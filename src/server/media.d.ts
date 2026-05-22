import type { ContentItem, Library } from "../shared/types.js";
export declare function getLibraryMtime(libraryPath: string): Promise<string>;
export declare function scanLibrary(library: Library): Promise<ContentItem[]>;
export declare function getContentCoverPath(library: Library, contentId: string): Promise<string | null>;
export declare function getContentCoverThumbnail(library: Library, contentId: string): Promise<string | null>;
export declare function getContentPagePath(library: Library, contentId: string, pageIndex: number): Promise<string | null>;
//# sourceMappingURL=media.d.ts.map