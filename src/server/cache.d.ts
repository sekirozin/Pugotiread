declare class CacheService {
    private scanCache;
    getCoverThumbnailPath(contentId: string): string;
    getCoverThumbnail(contentId: string): Promise<string | null>;
    generateCoverThumbnail(sourcePath: string, contentId: string): Promise<string>;
    getOrCreateCover(sourcePath: string | null, contentId: string): Promise<string | null>;
    getCachedScan<T>(key: string, stamp: string): T | null;
    setCachedScan<T>(key: string, data: T, stamp: string): void;
    invalidateScan(libraryId: string): void;
}
export declare const cacheService: CacheService;
export {};
//# sourceMappingURL=cache.d.ts.map