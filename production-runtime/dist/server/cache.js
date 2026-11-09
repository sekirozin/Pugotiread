import sharp from "sharp";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
const THUMBNAIL_WIDTH = 320;
const THUMBNAIL_QUALITY = 75;
const PDF_MAX_INPUT_SIZE = 500 * 1024 * 1024;
const PDF_MAX_OUTPUT_SIZE = 10 * 1024 * 1024;
const PDF_RENDER_TIMEOUT_MS = 20_000;
const execFileAsync = promisify(execFile);
function isPdf(filePath) {
    return path.extname(filePath).toLowerCase() === ".pdf";
}
function makePdfCacheKey(sourcePath, mtimeMs, size, contentId) {
    return crypto.createHash("sha256").update(`${contentId}\0${path.resolve(sourcePath)}\0${mtimeMs}\0${size}`).digest("hex");
}
class CacheService {
    scanCache = new Map();
    libraryCacheDb;
    constructor() {
        fsSync.mkdirSync(path.dirname(config.libraryCacheDbFile), { recursive: true });
        this.libraryCacheDb = new Database(config.libraryCacheDbFile);
        this.libraryCacheDb.pragma("journal_mode = WAL");
        this.libraryCacheDb.exec(`CREATE TABLE IF NOT EXISTS library_scans (libraryId TEXT PRIMARY KEY, stamp TEXT NOT NULL, payload TEXT NOT NULL, updatedAt TEXT NOT NULL);`);
    }
    getCoverThumbnailPath(contentId, sourcePath, sourceStat) {
        const fileName = sourcePath && sourceStat && isPdf(sourcePath)
            ? `${makePdfCacheKey(sourcePath, sourceStat.mtimeMs, sourceStat.size, contentId)}.webp`
            : `${contentId}.webp`;
        return path.join(config.cacheDir, "covers", fileName);
    }
    async getCoverThumbnail(contentId) {
        const thumbPath = this.getCoverThumbnailPath(contentId);
        try {
            await fs.access(thumbPath);
            return thumbPath;
        }
        catch {
            return null;
        }
    }
    async generateCoverThumbnail(sourcePath, contentId) {
        const sourceStat = await fs.stat(sourcePath);
        const thumbPath = this.getCoverThumbnailPath(contentId, sourcePath, sourceStat);
        await fs.mkdir(path.dirname(thumbPath), { recursive: true });
        if (!isPdf(sourcePath)) {
            await sharp(sourcePath).resize(THUMBNAIL_WIDTH, undefined, { fit: "outside", withoutEnlargement: true }).webp({ quality: THUMBNAIL_QUALITY }).toFile(thumbPath);
            return thumbPath;
        }
        if (sourceStat.size > PDF_MAX_INPUT_SIZE)
            throw new Error("PDF excede o limite de rasterização.");
        const temporaryDirectory = await fs.mkdtemp(path.join(config.cacheDir, "pdf-cover-"));
        const temporaryPrefix = path.join(temporaryDirectory, "pagina");
        const renderedPath = `${temporaryPrefix}.png`;
        try {
            await execFileAsync("pdftoppm", ["-f", "1", "-l", "1", "-singlefile", "-scale-to", String(THUMBNAIL_WIDTH), "-png", sourcePath, temporaryPrefix], { timeout: PDF_RENDER_TIMEOUT_MS, maxBuffer: 64 * 1024 });
            const renderedStat = await fs.stat(renderedPath);
            if (renderedStat.size > PDF_MAX_OUTPUT_SIZE)
                throw new Error("Prévia de PDF excede o limite de tamanho.");
            const temporaryOutput = `${thumbPath}.tmp-${process.pid}-${Date.now()}`;
            await sharp(renderedPath, { limitInputPixels: 2_000_000 }).resize(THUMBNAIL_WIDTH, undefined, { fit: "inside", withoutEnlargement: true }).webp({ quality: THUMBNAIL_QUALITY }).toFile(temporaryOutput);
            await fs.rename(temporaryOutput, thumbPath);
            return thumbPath;
        }
        finally {
            await fs.rm(temporaryDirectory, { recursive: true, force: true });
        }
    }
    async getOrCreateCover(sourcePath, contentId) {
        if (!sourcePath)
            return null;
        const sourceStat = await fs.stat(sourcePath).catch(() => null);
        const cachedPath = sourceStat && isPdf(sourcePath) ? this.getCoverThumbnailPath(contentId, sourcePath, sourceStat) : await this.getCoverThumbnail(contentId);
        if (cachedPath && await fs.access(cachedPath).then(() => true).catch(() => false))
            return cachedPath;
        try {
            return await this.generateCoverThumbnail(sourcePath, contentId);
        }
        catch {
            return sourcePath;
        }
    }
    async invalidateCover(contentId) {
        await fs.rm(this.getCoverThumbnailPath(contentId), { force: true });
    }
    async invalidateLibraryCovers(libraryId) {
        const coversDir = path.join(config.cacheDir, "covers");
        const entries = await fs.readdir(coversDir).catch(() => []);
        await Promise.all(entries.filter((entry) => entry.startsWith(`${libraryId}:`)).map((entry) => fs.rm(path.join(coversDir, entry), { force: true })));
    }
    getCachedScan(key, stamp) {
        const entry = this.scanCache.get(key);
        if (entry?.stamp === stamp)
            return entry.data;
        const persisted = this.libraryCacheDb.prepare("SELECT stamp, payload FROM library_scans WHERE libraryId = ?").get(key);
        if (!persisted || persisted.stamp !== stamp)
            return null;
        try {
            const data = JSON.parse(persisted.payload);
            this.scanCache.set(key, { data, stamp: persisted.stamp });
            return data;
        }
        catch {
            return null;
        }
    }
    getLatestScan(key) {
        const entry = this.scanCache.get(key);
        if (entry)
            return { data: entry.data, stamp: entry.stamp };
        const persisted = this.libraryCacheDb.prepare("SELECT stamp, payload FROM library_scans WHERE libraryId = ?").get(key);
        if (!persisted)
            return null;
        try {
            const data = JSON.parse(persisted.payload);
            this.scanCache.set(key, { data, stamp: persisted.stamp });
            return { data, stamp: persisted.stamp };
        }
        catch {
            return null;
        }
    }
    setCachedScan(key, data, stamp) {
        this.scanCache.set(key, { data, stamp });
        this.libraryCacheDb.prepare(`INSERT INTO library_scans (libraryId, stamp, payload, updatedAt) VALUES (?, ?, ?, ?) ON CONFLICT(libraryId) DO UPDATE SET stamp = excluded.stamp, payload = excluded.payload, updatedAt = excluded.updatedAt`).run(key, stamp, JSON.stringify(data), new Date().toISOString());
    }
    invalidateScan(libraryId) {
        this.scanCache.delete(libraryId);
        this.libraryCacheDb.prepare("DELETE FROM library_scans WHERE libraryId = ?").run(libraryId);
    }
}
export const cacheService = new CacheService();
