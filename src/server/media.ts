import fs from "node:fs/promises";
import path from "node:path";
import { cacheService } from "./cache.js";
import type { ChapterInfo, ContentItem, Library, PageMediaType } from "../shared/types.js";

const readableImageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);
const readableDocumentExtensions = new Set([".pdf"]);
const readablePageExtensions = new Set([...readableImageExtensions, ...readableDocumentExtensions]);
const coverNames = new Set(["capa", "cover", "folder", "poster"]);

type MediaPage = {
  relativePath: string;
  type: PageMediaType;
};

type WorkMetadata = {
  title?: string;
  description?: string;
  authors?: string[];
  artists?: string[];
  release_date?: string;
  release_year?: string;
  rating?: string;
  genres?: string[];
};

function makeContentId(libraryId: string, title: string): string {
  return `${libraryId}:${Buffer.from(title).toString("base64url")}`;
}

function getLibraryIdFromContentId(contentId: string): string {
  return contentId.split(":")[0] ?? "";
}

function sortPages(pages: string[]): string[] {
  return pages.sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true, sensitivity: "base" }));
}

function isReadablePage(fileName: string): boolean {
  return readablePageExtensions.has(path.extname(fileName).toLowerCase());
}

function isReadableImage(fileName: string): boolean {
  return readableImageExtensions.has(path.extname(fileName).toLowerCase());
}

function isCoverFile(fileName: string): boolean {
  return coverNames.has(path.parse(fileName).name.toLowerCase()) && isReadableImage(fileName);
}

function getPageType(fileName: string): PageMediaType {
  return readableDocumentExtensions.has(path.extname(fileName).toLowerCase()) ? "pdf" : "image";
}

function isSpecialChapterName(name: string): boolean {
  return /(?:special|extras?|bonus|omake|side story|ova|spin[- ]?off)/i.test(name);
}

async function readMetadata(workPath: string): Promise<WorkMetadata> {
  const metadataPath = path.join(workPath, "metadata.json");
  const raw = await fs.readFile(metadataPath, "utf8").catch(() => null);
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as WorkMetadata;
  } catch {
    return {};
  }
}

async function scanChapterPages(workPath: string): Promise<{ pages: MediaPage[]; chapters: ChapterInfo[] }> {
  const entries = await fs.readdir(workPath, { withFileTypes: true }).catch(() => []);
  const chapterDirs = sortPages(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  const pages: MediaPage[] = [];
  const chapters: ChapterInfo[] = [];

  for (const chapterDir of chapterDirs) {
    const chapterPath = path.join(workPath, chapterDir);
    const chapterFiles = sortPages(await fs.readdir(chapterPath).catch(() => [])).filter(isReadablePage);
    if (chapterFiles.length === 0) {
      continue;
    }

    const startPage = pages.length;
    for (const fileName of chapterFiles) {
      pages.push({
        relativePath: path.join(chapterDir, fileName),
        type: getPageType(fileName)
      });
    }
    chapters.push({
      name: chapterDir,
      startPage,
      pageCount: chapterFiles.length,
      isSpecial: isSpecialChapterName(chapterDir)
    });
  }

  const loosePages = sortPages(
    entries
      .filter((entry) => entry.isFile() && isReadablePage(entry.name) && !isCoverFile(entry.name))
      .map((entry) => entry.name)
  );

  if (loosePages.length > 0) {
    const startPage = pages.length;
    for (const fileName of loosePages) {
      pages.push({
        relativePath: fileName,
        type: getPageType(fileName)
      });
    }
    chapters.push({
      name: "Arquivos soltos",
      startPage,
      pageCount: loosePages.length,
      isSpecial: false
    });
  }

  return {
    pages,
    chapters
  };
}

async function findCoverPath(workPath: string): Promise<string | null> {
  const entries = await fs.readdir(workPath).catch(() => []);
  const cover = entries.find(isCoverFile);
  return cover ?? null;
}

async function toContentItem(library: Library, folderName: string): Promise<ContentItem | null> {
  const workPath = path.join(library.path, folderName);
  const [metadata, coverPath, scan] = await Promise.all([
    readMetadata(workPath),
    findCoverPath(workPath),
    scanChapterPages(workPath)
  ]);
  const id = makeContentId(library.id, folderName);

  // A pasta da obra deve seguir o formato esperado:
  // obra/metadata.json, obra/Capa.*, obra/Cap. 01/*.webp...
  // Isso evita que uma pasta categoria, como /media, seja confundida com uma obra.
  if (scan.pages.length === 0 || (!coverPath && !metadata.title)) {
    return null;
  }

  const title = metadata.title?.trim() || folderName;
  return {
    id,
    libraryId: library.id,
    title,
    description: metadata.description ?? null,
    authors: metadata.authors?.length ? metadata.authors : (metadata.artists ?? []),
    releaseDate: metadata.release_date ?? metadata.release_year ?? null,
    rating: metadata.rating ?? null,
    genres: metadata.genres ?? [],
    pageCount: scan.pages.length,
    chapterCount: scan.chapters.length,
    chapters: scan.chapters,
    coverUrl: coverPath ? `/api/contents/${encodeURIComponent(id)}/cover` : scan.pages[0] ? `/api/contents/${encodeURIComponent(id)}/pages/0` : null,
    pageTypes: scan.pages.map((page) => page.type)
  };
}

export async function getLibraryMtime(libraryPath: string): Promise<string> {
  try {
    const stat = await fs.stat(libraryPath);
    return String(stat.mtimeMs);
  } catch {
    return "";
  }
}

export async function scanLibrary(library: Library): Promise<ContentItem[]> {
  const stamp = await getLibraryMtime(library.path);
  const cached = cacheService.getCachedScan<ContentItem[]>(library.id, stamp);
  if (cached) return cached;

  try {
    const entries = await fs.readdir(library.path, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory());
    const contents = (await Promise.all(directories.map((directory) => toContentItem(library, directory.name))))
      .filter((content): content is ContentItem => Boolean(content));

    const sorted = contents.sort((a, b) => a.title.localeCompare(b.title, "pt-BR"));
    cacheService.setCachedScan(library.id, sorted, stamp);
    return sorted;
  } catch {
    return [];
  }
}

export async function getContentCoverPath(library: Library, contentId: string): Promise<string | null> {
  if (getLibraryIdFromContentId(contentId) !== library.id) {
    return null;
  }

  const folderName = Buffer.from(contentId.split(":")[1] ?? "", "base64url").toString("utf8");
  const workPath = path.join(library.path, folderName);
  const cover = await findCoverPath(workPath);
  if (!cover) {
    return null;
  }

  return resolveSafeMediaPath(library.path, workPath, cover);
}

export async function getContentCoverThumbnail(library: Library, contentId: string): Promise<string | null> {
  const sourcePath = await getContentCoverPath(library, contentId);
  return cacheService.getOrCreateCover(sourcePath, contentId);
}

function resolveSafeMediaPath(libraryPath: string, basePath: string, relativePath: string): string | null {
  const pagePath = path.resolve(basePath, relativePath);
  const safeBase = path.resolve(libraryPath);
  const relativePagePath = path.relative(safeBase, pagePath);
  if (relativePagePath.startsWith("..") || path.isAbsolute(relativePagePath)) {
    return null;
  }

  return pagePath;
}

export async function getContentPagePath(library: Library, contentId: string, pageIndex: number): Promise<string | null> {
  if (getLibraryIdFromContentId(contentId) !== library.id || !Number.isInteger(pageIndex) || pageIndex < 0) {
    return null;
  }

  const contents = await scanLibrary(library);
  const content = contents.find((item) => item.id === contentId);
  if (!content) {
    return null;
  }

  const folderName = Buffer.from(contentId.split(":")[1] ?? "", "base64url").toString("utf8");
  const contentPath = path.join(library.path, folderName);
  const stat = await fs.stat(contentPath).catch(() => null);
  if (!stat) {
    return null;
  }

  const page = stat.isDirectory() ? (await scanChapterPages(contentPath)).pages[pageIndex] : null;
  if (!page) {
    return null;
  }

  return resolveSafeMediaPath(library.path, contentPath, page.relativePath);
}
