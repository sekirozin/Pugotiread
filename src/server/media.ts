import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { cacheService } from "./cache.js";
import type { ChapterInfo, ContentItem, Library, PageMediaType } from "../shared/types.js";

const readableImageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);
const readableDocumentExtensions = new Set([".pdf"]);
const readablePageExtensions = new Set([...readableImageExtensions, ...readableDocumentExtensions]);
const readableBookExtensions = new Set([".epub"]);
const coverNames = new Set(["capa", "cover", "folder", "poster"]);
const execFileAsync = promisify(execFile);
const textLibraryKinds = new Set<Library["kind"]>(["book", "lightNovel"]);
const epubInfoCache = new Map<string, { stamp: string; info: EpubInfo | null }>();

type MediaPage = {
  relativePath: string;
  type: PageMediaType;
};

type EpubChapter = {
  name: string;
  href: string;
};

type EpubInfo = {
  title: string | null;
  authors: string[];
  chapters: EpubChapter[];
  opfDir: string;
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

function isReadableBook(fileName: string): boolean {
  return readableBookExtensions.has(path.extname(fileName).toLowerCase());
}

async function findFirstBookFile(basePath: string, maxDepth = 2, relativeDir = ""): Promise<string | null> {
  const currentPath = path.join(basePath, relativeDir);
  const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
  const files = sortPages(entries.filter((entry) => entry.isFile() && isReadableBook(entry.name)).map((entry) => entry.name));
  if (files[0]) {
    return path.join(relativeDir, files[0]);
  }

  if (maxDepth <= 0) {
    return null;
  }

  const directories = sortPages(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  for (const directory of directories) {
    const nested = await findFirstBookFile(basePath, maxDepth - 1, path.join(relativeDir, directory));
    if (nested) {
      return nested;
    }
  }

  return null;
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

function decodeXml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function stripXmlTags(value: string): string {
  return decodeXml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function getXmlTagText(xml: string, tagName: string): string | null {
  const match = xml.match(new RegExp(`<(?:[\\w-]+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tagName}>`, "i"));
  return match?.[1] ? stripXmlTags(match[1]) : null;
}

function getXmlTagTexts(xml: string, tagName: string): string[] {
  const matches = xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tagName}>`, "gi"));
  return Array.from(matches, (match) => stripXmlTags(match[1] ?? "")).filter(Boolean);
}

function parseXmlAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)) {
    attrs[match[1] ?? ""] = decodeXml(match[2] ?? "");
  }
  return attrs;
}

function normalizeZipPath(value: string): string {
  return value.split(/[?#]/)[0]?.replaceAll("\\", "/").replace(/^\/+/, "") ?? "";
}

function resolveZipPath(baseDir: string, href: string): string {
  const decodedHref = decodeURIComponent(normalizeZipPath(href));
  return path.posix.normalize(path.posix.join(baseDir, decodedHref)).replace(/^(\.\.\/)+/, "");
}

async function readZipEntry(zipPath: string, entryPath: string): Promise<Buffer | null> {
  const candidates = Array.from(new Set([entryPath, `./${entryPath.replace(/^\.\/+/, "")}`]));
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync("unzip", ["-p", zipPath, candidate], {
        encoding: "buffer",
        maxBuffer: 30 * 1024 * 1024
      });
      return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    } catch {
      continue;
    }
  }
  return null;
}

async function readZipText(zipPath: string, entryPath: string): Promise<string | null> {
  const buffer = await readZipEntry(zipPath, entryPath);
  return buffer ? buffer.toString("utf8") : null;
}

async function readEpubInfo(epubPath: string): Promise<EpubInfo | null> {
  const container = await readZipText(epubPath, "META-INF/container.xml");
  const rootfile = container?.match(/full-path\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!rootfile) {
    return null;
  }

  const opfPath = normalizeZipPath(rootfile);
  const opf = await readZipText(epubPath, opfPath);
  if (!opf) {
    return null;
  }

  const opfDir = path.posix.dirname(opfPath) === "." ? "" : path.posix.dirname(opfPath);
  const manifest = new Map<string, { href: string; mediaType: string }>();
  for (const match of opf.matchAll(/<item\b[^>]*>/gi)) {
    const attrs = parseXmlAttributes(match[0]);
    if (!attrs.id || !attrs.href) {
      continue;
    }
    manifest.set(attrs.id, {
      href: resolveZipPath(opfDir, attrs.href),
      mediaType: attrs["media-type"] ?? ""
    });
  }

  const chapters: EpubChapter[] = [];
  for (const match of opf.matchAll(/<itemref\b[^>]*>/gi)) {
    const attrs = parseXmlAttributes(match[0]);
    const item = attrs.idref ? manifest.get(attrs.idref) : null;
    if (!item || !/x?html/i.test(item.mediaType)) {
      continue;
    }

    chapters.push({
      name: path.posix.basename(item.href, path.posix.extname(item.href)),
      href: item.href
    });
  }

  return {
    title: getXmlTagText(opf, "title"),
    authors: getXmlTagTexts(opf, "creator"),
    chapters,
    opfDir
  };
}

async function getEpubInfo(epubPath: string): Promise<EpubInfo | null> {
  const stat = await fs.stat(epubPath).catch(() => null);
  const stamp = stat ? `${stat.mtimeMs}:${stat.size}` : "";
  const cached = epubInfoCache.get(epubPath);
  if (cached?.stamp === stamp) {
    return cached.info;
  }

  const info = await readEpubInfo(epubPath);
  epubInfoCache.set(epubPath, { stamp, info });
  return info;
}

async function getLatestMtimeIso(paths: string[]): Promise<string | null> {
  const stats = await Promise.all(paths.map((targetPath) => fs.stat(targetPath).catch(() => null)));
  const latestMtime = stats.reduce((latest, stat) => Math.max(latest, stat?.mtimeMs ?? 0), 0);
  return latestMtime > 0 ? new Date(latestMtime).toISOString() : null;
}

async function scanEpubPages(epubPath: string): Promise<{ metadata: Pick<WorkMetadata, "title" | "authors">; pages: MediaPage[]; chapters: ChapterInfo[] }> {
  const epub = await getEpubInfo(epubPath);
  if (!epub || epub.chapters.length === 0) {
    return { metadata: {}, pages: [], chapters: [] };
  }

  const addedAt = await getLatestMtimeIso([epubPath]);
  return {
    metadata: {
      title: epub.title ?? undefined,
      authors: epub.authors
    },
    pages: epub.chapters.map((chapter) => ({ relativePath: chapter.href, type: "epub" })),
    chapters: epub.chapters.map((chapter, index) => ({
      name: chapter.name || `Capítulo ${index + 1}`,
      startPage: index,
      pageCount: 1,
      isSpecial: isSpecialChapterName(chapter.name),
      addedAt
    }))
  };
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
    const chapterFilePaths = chapterFiles.map((fileName) => path.join(chapterPath, fileName));
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
      isSpecial: isSpecialChapterName(chapterDir),
      addedAt: await getLatestMtimeIso([chapterPath, ...chapterFilePaths])
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
      isSpecial: false,
      addedAt: await getLatestMtimeIso(loosePages.map((fileName) => path.join(workPath, fileName)))
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
  if (cover) {
    return cover;
  }

  return sortPages(entries.filter(isReadableImage))[0] ?? null;
}

async function findAdjacentBookCoverPath(libraryPath: string, bookFileName: string): Promise<string | null> {
  const entries = await fs.readdir(libraryPath).catch(() => []);
  const bookBaseName = path.parse(bookFileName).name.toLowerCase();
  const matchingCover = entries.find((entry) => path.parse(entry).name.toLowerCase() === bookBaseName && isReadableImage(entry));
  return matchingCover ?? null;
}

async function makeCoverUrl(contentId: string, coverPath: string): Promise<string> {
  const stat = await fs.stat(coverPath).catch(() => null);
  const version = stat ? `${Math.round(stat.mtimeMs)}-${stat.size}` : Date.now().toString();
  return `/api/contents/${encodeURIComponent(contentId)}/cover?v=${encodeURIComponent(version)}`;
}

async function toContentItem(library: Library, folderName: string): Promise<ContentItem | null> {
  const workPath = path.join(library.path, folderName);
  const workStat = await fs.stat(workPath).catch(() => null);
  const isRootBookFile = textLibraryKinds.has(library.kind) && Boolean(workStat?.isFile()) && isReadableBook(folderName);
  if (isRootBookFile) {
    const epubScan = await scanEpubPages(workPath);
    if (epubScan.pages.length === 0) {
      return null;
    }

    const title = epubScan.metadata.title?.trim() || path.parse(folderName).name;
    const id = makeContentId(library.id, folderName);
    const coverPath = await findAdjacentBookCoverPath(library.path, folderName);
    const coverUrl = coverPath ? await makeCoverUrl(id, path.join(library.path, coverPath)) : null;
    return {
      id,
      libraryId: library.id,
      title,
      description: null,
      authors: epubScan.metadata.authors ?? [],
      releaseDate: null,
      rating: null,
      genres: [],
      pageCount: epubScan.pages.length,
      chapterCount: epubScan.chapters.length,
      chapters: epubScan.chapters,
      coverUrl,
      pageTypes: epubScan.pages.map((page) => page.type)
    };
  }

  const [metadata, coverPath, scan] = await Promise.all([
    readMetadata(workPath),
    findCoverPath(workPath),
    scanChapterPages(workPath)
  ]);
  const id = makeContentId(library.id, folderName);

  // A pasta da obra precisa ter páginas legíveis. Capa e metadata são opcionais:
  // quando não existem, a primeira página vira a capa.
  if (scan.pages.length === 0) {
    if (textLibraryKinds.has(library.kind)) {
      const epubFile = await findFirstBookFile(workPath);
      if (epubFile) {
        const epubScan = await scanEpubPages(path.join(workPath, epubFile));
        if (epubScan.pages.length > 0) {
          const title = metadata.title?.trim() || epubScan.metadata.title?.trim() || folderName;
          const coverUrl = coverPath ? await makeCoverUrl(id, path.join(workPath, coverPath)) : null;
          return {
            id,
            libraryId: library.id,
            title,
            description: metadata.description ?? null,
            authors: metadata.authors?.length ? metadata.authors : (epubScan.metadata.authors ?? metadata.artists ?? []),
            releaseDate: metadata.release_date ?? metadata.release_year ?? null,
            rating: metadata.rating ?? null,
            genres: metadata.genres ?? [],
            pageCount: epubScan.pages.length,
            chapterCount: epubScan.chapters.length,
            chapters: epubScan.chapters,
            coverUrl,
            pageTypes: epubScan.pages.map((page) => page.type)
          };
        }
      }
    }
    return null;
  }

  const title = metadata.title?.trim() || folderName;
  const coverUrl = coverPath ? await makeCoverUrl(id, path.join(workPath, coverPath)) : scan.pages[0] ? `/api/contents/${encodeURIComponent(id)}/pages/0` : null;
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
    coverUrl,
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
    const rootBookFiles = textLibraryKinds.has(library.kind) ? entries.filter((entry) => entry.isFile() && isReadableBook(entry.name)) : [];
    const candidates = [...directories, ...rootBookFiles];
    const contents = (await Promise.all(candidates.map((entry) => toContentItem(library, entry.name))))
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
  const workStat = await fs.stat(workPath).catch(() => null);
  if (workStat?.isFile() && textLibraryKinds.has(library.kind) && isReadableBook(folderName)) {
    const cover = await findAdjacentBookCoverPath(library.path, folderName);
    return cover ? resolveSafeMediaPath(library.path, library.path, cover) : null;
  }

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

async function findEpubPath(library: Library, contentId: string): Promise<string | null> {
  if (getLibraryIdFromContentId(contentId) !== library.id) {
    return null;
  }

  const folderName = Buffer.from(contentId.split(":")[1] ?? "", "base64url").toString("utf8");
  const contentPath = path.join(library.path, folderName);
  const stat = await fs.stat(contentPath).catch(() => null);
  if (!stat) {
    return null;
  }

  if (stat.isFile() && isReadableBook(contentPath)) {
    return resolveSafeMediaPath(library.path, library.path, folderName);
  }

  if (!stat.isDirectory()) {
    return null;
  }

  const epubFile = await findFirstBookFile(contentPath);
  return epubFile ? resolveSafeMediaPath(library.path, contentPath, epubFile) : null;
}

function rewriteEpubAssetUrls(html: string, contentId: string, chapterHref: string): string {
  const chapterDir = path.posix.dirname(chapterHref) === "." ? "" : path.posix.dirname(chapterHref);
  return html.replace(/\b(src|href)\s*=\s*(["'])([^"']+)\2/gi, (full, attr: string, quote: string, rawUrl: string) => {
    if (/^(?:https?:|data:|mailto:|#)/i.test(rawUrl)) {
      return full;
    }

    const assetPath = resolveZipPath(chapterDir, rawUrl);
    const assetUrl = `/api/contents/${encodeURIComponent(contentId)}/epub-assets/${assetPath.split("/").map(encodeURIComponent).join("/")}`;
    return `${attr}=${quote}${assetUrl}${quote}`;
  });
}

function extractHtmlPart(html: string, tagName: "head" | "body"): string {
  const match = html.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match?.[1] ?? "";
}

function wrapEpubChapterHtml(html: string, contentId: string, chapterHref: string, theme: "light" | "dark" = "light"): string {
  const rewritten = rewriteEpubAssetUrls(html, contentId, chapterHref)
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!doctype[\s\S]*?>/gi, "");
  const head = extractHtmlPart(rewritten, "head");
  const body = extractHtmlPart(rewritten, "body") || rewritten;
  const themeCss = theme === "dark"
    ? {
        colorScheme: "dark",
        background: "#0b0b0b",
        text: "#f4f4f4",
        link: "#9cc4ff"
      }
    : {
        colorScheme: "light",
        background: "#f8f5ee",
        text: "#1f1b16",
        link: "#234c8c"
      };

  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    ${head}
    <style>
      :root {
        color-scheme: ${themeCss.colorScheme};
        background: ${themeCss.background};
        color: ${themeCss.text};
        font-family: Georgia, "Times New Roman", serif;
      }

      * {
        box-sizing: border-box;
        max-width: 100%;
      }

      html,
      body {
        min-height: 100%;
        margin: 0 !important;
        background: ${themeCss.background} !important;
        color: ${themeCss.text} !important;
      }

      body * {
        color: inherit !important;
        background-color: transparent !important;
      }

      body {
        overflow: hidden;
        padding: clamp(24px, 5vw, 56px) clamp(18px, 8vw, 96px) !important;
        font-size: clamp(18px, 2.2vw, 22px);
        line-height: 1.72;
      }

      .pugotiread-epub-document {
        width: min(760px, 100%);
        margin: 0 auto;
        overflow-wrap: anywhere;
      }

      p,
      li {
        line-height: 1.72 !important;
      }

      p {
        margin: 0 0 1.05em;
      }

      img,
      svg,
      video,
      canvas {
        display: block;
        max-width: 100% !important;
        height: auto !important;
        margin: 1.2em auto;
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      a {
        color: ${themeCss.link} !important;
      }
    </style>
  </head>
  <body>
    <main class="pugotiread-epub-document">${body}</main>
  </body>
</html>`;
}

export async function getContentEpubChapterHtml(library: Library, contentId: string, pageIndex: number, theme: "light" | "dark" = "light"): Promise<string | null> {
  if (!textLibraryKinds.has(library.kind) || !Number.isInteger(pageIndex) || pageIndex < 0) {
    return null;
  }

  const epubPath = await findEpubPath(library, contentId);
  if (!epubPath) {
    return null;
  }

  const epub = await getEpubInfo(epubPath);
  const chapter = epub?.chapters[pageIndex];
  if (!chapter) {
    return null;
  }

  const rawHtml = await readZipText(epubPath, chapter.href);
  if (!rawHtml) {
    return null;
  }

  return wrapEpubChapterHtml(rawHtml, contentId, chapter.href, theme);
}

export async function getContentEpubAsset(library: Library, contentId: string, assetPath: string): Promise<{ path: string; data: Buffer } | null> {
  if (!textLibraryKinds.has(library.kind)) {
    return null;
  }

  const epubPath = await findEpubPath(library, contentId);
  if (!epubPath) {
    return null;
  }

  const safeAssetPath = normalizeZipPath(assetPath);
  if (!safeAssetPath || safeAssetPath.startsWith("../")) {
    return null;
  }

  const data = await readZipEntry(epubPath, safeAssetPath);
  return data ? { path: safeAssetPath, data } : null;
}
