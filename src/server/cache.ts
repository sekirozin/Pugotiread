import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const THUMBNAIL_WIDTH = 320;
const THUMBNAIL_QUALITY = 75;

class CacheService {
  private scanCache = new Map<string, { data: unknown; stamp: string }>();

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
    if (!entry || entry.stamp !== stamp) return null;
    return entry.data as T;
  }

  setCachedScan<T>(key: string, data: T, stamp: string): void {
    this.scanCache.set(key, { data, stamp });
  }

  invalidateScan(libraryId: string): void {
    this.scanCache.delete(libraryId);
  }
}

export const cacheService = new CacheService();
