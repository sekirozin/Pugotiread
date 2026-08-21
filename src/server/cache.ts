import sharp from "sharp";
import Database from "better-sqlite3";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const THUMBNAIL_WIDTH = 320;
const THUMBNAIL_QUALITY = 75;

class CacheService {
  private scanCache = new Map<string, { data: unknown; stamp: string }>();
  private libraryCacheDb: Database.Database;

  constructor() {
    fsSync.mkdirSync(path.dirname(config.libraryCacheDbFile), { recursive: true });
    this.libraryCacheDb = new Database(config.libraryCacheDbFile);
    this.libraryCacheDb.pragma("journal_mode = WAL");
    this.libraryCacheDb.exec(`
      CREATE TABLE IF NOT EXISTS library_scans (
        libraryId TEXT PRIMARY KEY,
        stamp TEXT NOT NULL,
        payload TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
  }

  getCoverThumbnailPath(contentId: string): string {
    return path.join(config.cacheDir, "covers", `${contentId}.webp`);
  }

  async getCoverThumbnail(contentId: string): Promise<string | null> {
    const thumbPath = this.getCoverThumbnailPath(contentId);
    try {
      await fs.access(thumbPath);
      return thumbPath;
    } catch {
      return null;
    }
  }

  async generateCoverThumbnail(sourcePath: string, contentId: string): Promise<string> {
    const thumbPath = this.getCoverThumbnailPath(contentId);
    await fs.mkdir(path.dirname(thumbPath), { recursive: true });
    await sharp(sourcePath)
      .resize(THUMBNAIL_WIDTH, undefined, { fit: "outside", withoutEnlargement: true })
      .webp({ quality: THUMBNAIL_QUALITY })
      .toFile(thumbPath);
    return thumbPath;
  }

  async getOrCreateCover(sourcePath: string | null, contentId: string): Promise<string | null> {
    if (!sourcePath) return null;

    const cached = await this.getCoverThumbnail(contentId);
    if (cached) return cached;

    try {
      return await this.generateCoverThumbnail(sourcePath, contentId);
    } catch {
      return sourcePath;
    }
  }

  async invalidateCover(contentId: string): Promise<void> {
    await fs.rm(this.getCoverThumbnailPath(contentId), { force: true });
  }

  async invalidateLibraryCovers(libraryId: string): Promise<void> {
    const coversDir = path.join(config.cacheDir, "covers");
    const entries = await fs.readdir(coversDir).catch(() => []);
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(`${libraryId}:`))
        .map((entry) => fs.rm(path.join(coversDir, entry), { force: true }))
    );
  }

  getCachedScan<T>(key: string, stamp: string): T | null {
    const entry = this.scanCache.get(key);
    if (entry?.stamp === stamp) return entry.data as T;

    const persisted = this.libraryCacheDb
      .prepare("SELECT stamp, payload FROM library_scans WHERE libraryId = ?")
      .get(key) as { stamp: string; payload: string } | undefined;
    if (!persisted || persisted.stamp !== stamp) return null;

    try {
      const data = JSON.parse(persisted.payload) as T;
      this.scanCache.set(key, { data, stamp: persisted.stamp });
      return data;
    } catch {
      return null;
    }
  }

  getLatestScan<T>(key: string): { data: T; stamp: string } | null {
    const entry = this.scanCache.get(key);
    if (entry) {
      return { data: entry.data as T, stamp: entry.stamp };
    }

    const persisted = this.libraryCacheDb
      .prepare("SELECT stamp, payload FROM library_scans WHERE libraryId = ?")
      .get(key) as { stamp: string; payload: string } | undefined;
    if (!persisted) return null;

    try {
      const data = JSON.parse(persisted.payload) as T;
      this.scanCache.set(key, { data, stamp: persisted.stamp });
      return { data, stamp: persisted.stamp };
    } catch {
      return null;
    }
  }

  setCachedScan<T>(key: string, data: T, stamp: string): void {
    this.scanCache.set(key, { data, stamp });
    this.libraryCacheDb
      .prepare(`
        INSERT INTO library_scans (libraryId, stamp, payload, updatedAt)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(libraryId) DO UPDATE SET
          stamp = excluded.stamp,
          payload = excluded.payload,
          updatedAt = excluded.updatedAt
      `)
      .run(key, stamp, JSON.stringify(data), new Date().toISOString());
  }

  invalidateScan(libraryId: string): void {
    this.scanCache.delete(libraryId);
    this.libraryCacheDb.prepare("DELETE FROM library_scans WHERE libraryId = ?").run(libraryId);
  }
}

export const cacheService = new CacheService();
