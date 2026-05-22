import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
const THUMBNAIL_WIDTH = 320;
const THUMBNAIL_QUALITY = 75;
class CacheService {
    scanCache = new Map();
    getCoverThumbnailPath(contentId) {
        return path.join(config.cacheDir, "covers", `${contentId}.webp`);
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
        const thumbPath = this.getCoverThumbnailPath(contentId);
        await fs.mkdir(path.dirname(thumbPath), { recursive: true });
        await sharp(sourcePath)
            .resize(THUMBNAIL_WIDTH, undefined, { fit: "outside", withoutEnlargement: true })
            .webp({ quality: THUMBNAIL_QUALITY })
            .toFile(thumbPath);
        return thumbPath;
    }
    async getOrCreateCover(sourcePath, contentId) {
        if (!sourcePath)
            return null;
        const cached = await this.getCoverThumbnail(contentId);
        if (cached)
            return cached;
        try {
            return await this.generateCoverThumbnail(sourcePath, contentId);
        }
        catch {
            return sourcePath;
        }
    }
    getCachedScan(key, stamp) {
        const entry = this.scanCache.get(key);
        if (!entry || entry.stamp !== stamp)
            return null;
        return entry.data;
    }
    setCachedScan(key, data, stamp) {
        this.scanCache.set(key, { data, stamp });
    }
    invalidateScan(libraryId) {
        this.scanCache.delete(libraryId);
    }
}
export const cacheService = new CacheService();
//# sourceMappingURL=cache.js.map