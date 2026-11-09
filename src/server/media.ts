import { validRating } from "../shared/work-metadata.js";
import { epubResourceCache } from "./reader-resources.js";
import fs from "node:fs/promises";
import fsSync from "node:fs";
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
const directPdfLibraryKinds = new Set<Library["kind"]>(["book", "lightNovel", "other"]);
const epubInfoCache = new Map<string, { stamp: string; info: EpubInfo | null }>();
const pdfPageCountCache = new Map<string, { stamp: string; pageCount: number }>();

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
  toc: EpubChapter[];
  opfDir: string;
};

type WorkMetadata = {
  status?: string;
  title?: string;
  description?: string;
  authors?: string[];
  artists?: string[];
  release_date?: string;
  release_year?: string;
  rating?: string;
  google_books_rating?: string | number | null;
  provider?: string;
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

function isReadableDocument(fileName: string): boolean {
  return readableDocumentExtensions.has(path.extname(fileName).toLowerCase());
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
    return JSON.parse(raw.replace(/^\uFEFF/, "")) as WorkMetadata;
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
  const stat = await fs.stat(zipPath).catch(() => null);
  if (!stat) return null;
  const key = `${zipPath}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${entryPath}`;
  return epubResourceCache.get(key, () => extractZipEntry(zipPath, entryPath));
}

async function extractZipEntry(zipPath: string, entryPath: string): Promise<Buffer | null> {
  const candidates = Array.from(new Set([entryPath, `./${entryPath.replace(/^\.\/+/, "")}`]));
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync("unzip", ["-p", zipPath, candidate], {
        encoding: "buffer",
        maxBuffer: 30 * 1024 * 1024,
        timeout: 15_000
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

  const toc = await listEpubTocEntries(epubPath, opfDir);

  return {
    title: getXmlTagText(opf, "title"),
    authors: getXmlTagTexts(opf, "creator"),
    chapters,
    toc,
    opfDir
  };
}

function listTocNcxEntries(ncx: string, opfDir: string): EpubChapter[] {
  const entries: EpubChapter[] = [];
  for (const match of ncx.matchAll(/<navPoint\b[^>]*>([\s\S]*?)<\/navPoint>/gi)) {
    const ponto = match[1] ?? "";
    const label = getXmlTagText(ponto, "text");
    const contentTag = ponto.match(/<content\b[^>]*>/i)?.[0];
    if (!label) {
      continue;
    }
    const href = parseXmlAttributes(contentTag ?? "")["src"];
    if (!href) {
      continue;
    }
    entries.push({ name: label.trim(), href: resolveZipPath(opfDir, href) });
  }
  return entries;
}

function listTocNavEntries(navHtml: string, opfDir: string): EpubChapter[] {
  const bloco =
    navHtml.match(/<nav\b[^>]*epub:type=["']toc["'][^>]*>([\s\S]*?)<\/nav>/i)?.[1] ??
    navHtml.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i)?.[1];
  if (!bloco) {
    return [];
  }
  const entries: EpubChapter[] = [];
  for (const match of bloco.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = match[1] ?? "";
    const label = stripXmlTags(match[2] ?? "").trim();
    if (!href || !label) {
      continue;
    }
    entries.push({ name: label, href: resolveZipPath(opfDir, href) });
  }
  return entries;
}

async function listEpubTocEntries(epubPath: string, opfDir: string): Promise<EpubChapter[]> {
  const ncxCandidates = [path.posix.join(opfDir, "toc.ncx"), "toc.ncx"];
  const navCandidates = [path.posix.join(opfDir, "nav.xhtml"), path.posix.join(opfDir, "toc.xhtml"), "nav.xhtml"];

  const ncxEntries: EpubChapter[] = [];
  for (const candidate of ncxCandidates) {
    const ncx = await readZipText(epubPath, candidate);
    if (ncx) {
      ncxEntries.push(...listTocNcxEntries(ncx, opfDir));
      break;
    }
  }

  if (ncxEntries.length >= 2) {
    return ncxEntries;
  }

  const navEntries: EpubChapter[] = [];
  for (const candidate of navCandidates) {
    const nav = await readZipText(epubPath, candidate);
    if (nav) {
      navEntries.push(...listTocNavEntries(nav, opfDir));
      break;
    }
  }

  if (navEntries.length > ncxEntries.length) {
    return navEntries;
  }
  return ncxEntries;
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

const numeraisCapitulo: Record<string, number> = {
  um: 1,
  dois: 2,
  tres: 3,
  três: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
  treze: 13,
  catorze: 14,
  quatorze: 14,
  quinze: 15,
  dezesseis: 16,
  dezasseis: 16,
  dezessete: 17,
  dezassete: 17,
  dezoito: 18,
  dezenove: 19,
  vinte: 20
};

const conectoresTitulo = new Set([
  "de", "da", "do", "das", "dos", "em", "e", "a", "o", "à", "às", "ao", "na", "no", "nas",
  "nos", "que", "um", "uma", "uns", "umas", "os", "as", "por", "para"
]);

const comecosDeFraseCapitulo = new Set([
  "se", "era", "foi", "é", "tem", "tinha", "tinham", "havia", "haviam", "mas",
  "pois", "então", "depois", "ainda", "enfim", "não", "tudo", "todos", "todas",
  "quando", "como", "naquele", "naquela", "aquele", "aquela", "até", "apesar"
]);

function extrairTituloCapitulo(resto: string): string {
  const tokens = resto.trim().split(/\s+/).slice(0, 24);
  const palavras: string[] = [];
  const ehTituloCaso = (token: string): boolean => /^[A-ZÀ-Ú]/.test(token) && /[a-zà-ú]/.test(token);
  const semPontuacao = (token: string): string => token.replace(/[“"”.,;:!?]+$/g, "").replace(/^[“"“’]+/, "");

  for (let indice = 0; indice < tokens.length; indice += 1) {
    const token = tokens[indice] ?? "";
    if (/^[A-ZÀ-Ú0-9]+[.!?]$/.test(token) || /^\d+$/.test(semPontuacao(token))) {
      break;
    }
    if (token.startsWith("—") || token.startsWith("-")) {
      break;
    }
    if (/^[A-ZÀ-Úa-zà-ú]{1,5}\.$/.test(token)) {
      break;
    }
    const limpo = semPontuacao(token);
    if (/^[A-Z0-9]{2,}$/.test(limpo)) {
      break;
    }
    if (ehTituloCaso(token)) {
      const seguinte = semPontuacao(tokens[indice + 1] ?? "");
      if (
        palavras.length >= 3 &&
        indice + 1 < tokens.length &&
        /^[a-zà-ú]+$/.test(seguinte) &&
        comecosDeFraseCapitulo.has(seguinte.toLowerCase())
      ) {
        break;
      }
      palavras.push(limpo);
      continue;
    }
    if (conectoresTitulo.has(limpo.toLowerCase())) {
      if (indice === 0) {
        palavras.push(limpo);
        continue;
      }
      const proximo = semPontuacao(tokens[indice + 1] ?? "");
      if (indice + 1 < tokens.length && ehTituloCaso(proximo)) {
        palavras.push(limpo);
        continue;
      }
    }
    break;
  }

  while (palavras.length > 0 && conectoresTitulo.has((palavras[palavras.length - 1] ?? "").toLowerCase())) {
    palavras.pop();
  }

  return palavras.join(" ").trim();
}

export function detectarMarcadorCapitulo(texto: string): { numero: number | null; titulo: string } | null {
  const amostra = texto.slice(0, 400);
  const match = amostra.match(/CA[Pp][IÍ]TULO[:.\s]([A-ZÀ-Ú]+|\d+)\b([\s\S]*)/i);
  if (!match) {
    return null;
  }
  const palavraNumero = (match[1] ?? "").toLowerCase().replace(".", "");
  const numero = /^\d+$/.test(palavraNumero) ? parseInt(palavraNumero, 10) : (numeraisCapitulo[palavraNumero] ?? null);
  const titulo = extrairTituloCapitulo(match[2] ?? "");
  return { numero, titulo };
}

function extrairCorpoTexto(html: string): string {
  const semCabecalho = html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ");
  const semEstilos = semCabecalho.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  const semScripts = semEstilos.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  const semTags = semScripts.replace(/<[^>]+>/g, " ");
  const semEntidades = semTags
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/gi, " ")
    .replace(/&#\d+;/g, " ");
  return semEntidades.replace(/\s+/g, " ").trim();
}

async function lerMarcadoresCapitulos(
  epubInfo: EpubInfo,
  lerHtml: (href: string) => Promise<string | null>
): Promise<Array<{ indice: number; numero: number | null; titulo: string }>> {
  const marcadores: Array<{ indice: number; numero: number | null; titulo: string }> = [];
  for (let indice = 0; indice < epubInfo.chapters.length; indice += 1) {
    const html = await lerHtml(epubInfo.chapters[indice]?.href ?? "");
    if (!html) {
      continue;
    }
    const marcador = detectarMarcadorCapitulo(extrairCorpoTexto(html));
    if (marcador) {
      marcadores.push({ indice, ...marcador });
    }
  }
  return marcadores;
}

export function agruparPorToc(toc: EpubChapter[], hrefPorIndice: string[]): ChapterInfo[] {
  const indicePorHref = new Map<string, number>();
  hrefPorIndice.forEach((href, indice) => {
    if (!indicePorHref.has(href)) {
      indicePorHref.set(href, indice);
    }
  });

  const pontos: Array<{ indice: number; name: string }> = [];
  for (const entrada of toc) {
    const indice = indicePorHref.get(entrada.href);
    if (indice !== undefined) {
      pontos.push({ indice, name: entrada.name.trim() });
    }
  }
  pontos.sort((a, b) => a.indice - b.indice);

  const grupos: ChapterInfo[] = [];
  const total = hrefPorIndice.length;
  for (let k = 0; k < pontos.length; k += 1) {
    const ponto = pontos[k];
    if (k > 0 && ponto.indice === pontos[k - 1]?.indice) {
      continue;
    }
    const fim = k + 1 < pontos.length ? (pontos[k + 1]?.indice ?? 0) - 1 : total - 1;
    if (fim < ponto.indice) {
      continue;
    }
    grupos.push({
      name: ponto.name || `Capítulo ${k + 1}`,
      startPage: ponto.indice,
      pageCount: fim - ponto.indice + 1,
      isSpecial: isSpecialChapterName(ponto.name),
      addedAt: null
    });
  }
  return grupos;
}

export function agruparPorMarcadores(
  marcadores: Array<{ indice: number; numero: number | null; titulo: string }>,
  totalPaginas: number
): ChapterInfo[] {
  const grupos: ChapterInfo[] = [];
  if (marcadores[0] && marcadores[0].indice > 0) {
    grupos.push({
      name: "Preliminares",
      startPage: 0,
      pageCount: marcadores[0].indice,
      isSpecial: false,
      addedAt: null
    });
  }
  for (let k = 0; k < marcadores.length; k += 1) {
    const marcador = marcadores[k]!;
    const inicio = marcador.indice;
    const fim = k + 1 < marcadores.length ? (marcadores[k + 1]?.indice ?? 0) - 1 : totalPaginas - 1;
    const numero = marcador.numero;
    const titulo = marcador.titulo;
    const name =
      numero != null && titulo
        ? `Capítulo ${numero} — ${titulo}`
        : titulo || (numero != null ? `Capítulo ${numero}` : `Capítulo ${k + 1}`);
    grupos.push({
      name,
      startPage: inicio,
      pageCount: Math.max(fim - inicio + 1, 1),
      isSpecial: isSpecialChapterName(name),
      addedAt: null
    });
  }
  return grupos;
}

async function agruparCapitulosEpub(
  epubInfo: EpubInfo,
  lerHtml: (href: string) => Promise<string | null>
): Promise<ChapterInfo[]> {
  const total = epubInfo.chapters.length;
  if (total === 0) {
    return [];
  }
  const hrefPorIndice = epubInfo.chapters.map((capitulo) => capitulo.href);

  const porToc = agruparPorToc(epubInfo.toc, hrefPorIndice);
  const ultimoToc = porToc[porToc.length - 1];
  const coberturaToc = ultimoToc ? ultimoToc.startPage + ultimoToc.pageCount : 0;
  if (porToc.length >= 2 && porToc.length < total && coberturaToc >= total * 0.6) {
    return porToc;
  }

  const marcadores = await lerMarcadoresCapitulos(epubInfo, lerHtml);
  const ultimoMarcador = marcadores[marcadores.length - 1];
  const coberturaMarcadores = ultimoMarcador ? ultimoMarcador.indice + 1 : 0;
  if (marcadores.length >= 2 && coberturaMarcadores >= total * 0.6) {
    return agruparPorMarcadores(marcadores, total);
  }

  return epubInfo.chapters.map((capitulo, indice) => ({
    name: capitulo.name || `Capítulo ${indice + 1}`,
    startPage: indice,
    pageCount: 1,
    isSpecial: isSpecialChapterName(capitulo.name),
    addedAt: null
  }));
}

async function scanEpubPages(epubPath: string): Promise<{ metadata: Pick<WorkMetadata, "title" | "authors">; pages: MediaPage[]; chapters: ChapterInfo[] }> {
  const epub = await getEpubInfo(epubPath);
  if (!epub || epub.chapters.length === 0) {
    return { metadata: {}, pages: [], chapters: [] };
  }

  const addedAt = await getLatestMtimeIso([epubPath]);
  const chapters = await agruparCapitulosEpub(epub, async (href) => readZipText(epubPath, href));

  return {
    metadata: {
      title: epub.title ?? undefined,
      authors: epub.authors
    },
    pages: epub.chapters.map((chapter) => ({ relativePath: chapter.href, type: "epub" })),
    chapters: chapters.map((capitulo) => ({ ...capitulo, addedAt }))
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

  // PDFs também podem representar uma obra inteira; a capa será rasterizada
  // pelo cache. Imagens continuam tendo prioridade e o fluxo dos demais
  // formatos permanece inalterado.
  return sortPages(entries.filter(isReadableImage))[0] ?? sortPages(entries.filter(isReadableDocument))[0] ?? null;
}

async function findAdjacentBookCoverPath(libraryPath: string, bookFileName: string): Promise<string | null> {
  const entries = await fs.readdir(libraryPath).catch(() => []);
  const bookBaseName = path.parse(bookFileName).name.toLowerCase();
  const matchingCover = entries.find((entry) => path.parse(entry).name.toLowerCase() === bookBaseName && isReadableImage(entry));
  return matchingCover ?? null;
}

async function getPdfPageCount(pdfPath: string): Promise<number> {
  const stat = await fs.stat(pdfPath).catch(() => null);
  const stamp = stat ? `${stat.mtimeMs}:${stat.size}` : "";
  const cached = pdfPageCountCache.get(pdfPath);
  if (cached?.stamp === stamp) {
    return cached.pageCount;
  }

  let pageCount = 1;
  try {
    const { stdout } = await execFileAsync("pdfinfo", [pdfPath], {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 256 * 1024
    });
    const match = stdout.match(/^Pages:\s+(\d+)\s*$/im);
    const parsed = Number(match?.[1]);
    if (Number.isInteger(parsed) && parsed > 0) {
      pageCount = parsed;
    }
  } catch (error) {
    console.warn(`[MEDIA] Não foi possível contar as páginas de ${path.basename(pdfPath)}:`, error);
  }

  pdfPageCountCache.set(pdfPath, { stamp, pageCount });
  return pageCount;
}

async function makeCoverUrl(contentId: string, coverPath: string): Promise<string> {
  const stat = await fs.stat(coverPath).catch(() => null);
  const version = stat ? `${Math.round(stat.mtimeMs)}-${stat.size}` : Date.now().toString();
  return `/api/contents/${encodeURIComponent(contentId)}/cover?v=${encodeURIComponent(version)}`;
}

async function toDirectPdfContent(library: Library, fileName: string): Promise<ContentItem | null> {
  const filePath = path.join(library.path, fileName);
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile() || !isReadableDocument(fileName)) {
    return null;
  }

  const id = makeContentId(library.id, fileName);
  const containingDirectory = path.dirname(filePath);
  const adjacentCover = await findAdjacentBookCoverPath(containingDirectory, path.basename(fileName));
  const coverUrl = adjacentCover
    ? await makeCoverUrl(id, path.join(containingDirectory, adjacentCover))
    : await makeCoverUrl(id, filePath);
  const pageCount = await getPdfPageCount(filePath);
  return {
    id,
    libraryId: library.id,
    title: path.parse(fileName).name,
    description: null,
    authors: [],
    releaseDate: null,
    rating: null,
    genres: [],
    pageCount,
    chapterCount: 1,
    chapters: [{ name: "Documento", startPage: 0, pageCount, isSpecial: false, addedAt: new Date(stat.mtimeMs).toISOString() }],
    coverUrl,
    pageTypes: ["pdf"],
    // A biblioteca pode organizar um sistema por várias camadas, como
    // "Tormenta RPG/Fichas/Ficha Tormenta". Mantemos todo o caminho relativo
    // para que a interface não perca as subpastas intermediárias.
    system: path.dirname(fileName) === "." ? null : path.dirname(fileName).split(path.sep).join("/")
  };
}

async function findNestedDocuments(root: string, relativeDirectory = ""): Promise<string[]> {
  const absoluteDirectory = path.join(root, relativeDirectory);
  const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name.startsWith(".pdf-copy-")) continue;
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...await findNestedDocuments(root, relativePath));
    else if (entry.isFile() && isReadableDocument(entry.name)) files.push(relativePath);
  }
  return files;
}

async function toContentItem(library: Library, folderName: string): Promise<ContentItem | null> {
  const workPath = path.join(library.path, folderName);
  const workStat = await fs.stat(workPath).catch(() => null);
  if (directPdfLibraryKinds.has(library.kind) && workStat?.isFile() && isReadableDocument(folderName)) {
    return toDirectPdfContent(library, folderName);
  }
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
            authors: metadata.authors?.length ? metadata.authors : (epubScan.metadata.authors ?? []),
            artists: metadata.artists ?? [],
            releaseDate: metadata.release_date ?? metadata.release_year ?? null,
            rating: validRating(metadata.rating),
            publicationStatus: metadata.status ?? null,
            externalRating: metadata.google_books_rating != null
              ? String(metadata.google_books_rating)
              : metadata.provider === "google-books" && metadata.rating != null
                ? String(metadata.rating)
                : null,
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
    authors: metadata.authors ?? [],
    artists: metadata.artists ?? [],
    releaseDate: metadata.release_date ?? metadata.release_year ?? null,
    rating: validRating(metadata.rating),
            publicationStatus: metadata.status ?? null,
    externalRating: metadata.google_books_rating != null
              ? String(metadata.google_books_rating)
              : metadata.provider === "google-books" && metadata.rating != null
                ? String(metadata.rating)
                : null,
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

const libraryScanPromises = new Map<string, Promise<ContentItem[]>>();
const libraryWatchers = new Map<string, fsSync.FSWatcher>();
const libraryWatchTimers = new Map<string, NodeJS.Timeout>();

export function startLibraryWatchers(libraries: Library[]): void {
  const activeIds = new Set(libraries.map((library) => library.id));
  for (const [libraryId, watcher] of libraryWatchers) {
    if (!activeIds.has(libraryId)) {
      watcher.close();
      libraryWatchers.delete(libraryId);
      const timer = libraryWatchTimers.get(libraryId);
      if (timer) clearTimeout(timer);
      libraryWatchTimers.delete(libraryId);
    }
  }

  for (const library of libraries) {
    if (libraryWatchers.has(library.id)) continue;
    try {
      const watcher = fsSync.watch(library.path, { persistent: false }, () => {
        const previousTimer = libraryWatchTimers.get(library.id);
        if (previousTimer) clearTimeout(previousTimer);
        const timer = setTimeout(() => {
          libraryWatchTimers.delete(library.id);
          void scanLibrary(library, { refresh: true }).catch((error) => {
            console.error(`[MEDIA] Atualização por evento da biblioteca ${library.id}:`, error);
          });
        }, 750);
        timer.unref();
        libraryWatchTimers.set(library.id, timer);
      });
      libraryWatchers.set(library.id, watcher);
    } catch (error) {
      console.warn(`[MEDIA] Não foi possível observar a biblioteca ${library.id}:`, error);
    }
  }
}

async function performLibraryScan(library: Library, stamp: string): Promise<ContentItem[]> {
  try {
    const entries = await fs.readdir(library.path, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !entry.name.startsWith(".pdf-copy-"));
    const nestedDocuments = library.kind === "other" ? await findNestedDocuments(library.path) : [];
    const rootBookFiles = textLibraryKinds.has(library.kind)
      ? entries.filter((entry) => entry.isFile() && (isReadableBook(entry.name) || isReadableDocument(entry.name)))
      : directPdfLibraryKinds.has(library.kind)
        ? entries.filter((entry) => entry.isFile() && isReadableDocument(entry.name))
        : [];
    const candidates = library.kind === "other"
      ? [...new Set(nestedDocuments)]
      : [...directories.map((entry) => entry.name), ...rootBookFiles.map((entry) => entry.name)];
    const contents = (await Promise.all(candidates.map((name) => toContentItem(library, name))))
      .filter((content): content is ContentItem => Boolean(content));

    const sorted = contents.sort((a, b) => a.title.localeCompare(b.title, "pt-BR"));
    cacheService.setCachedScan(library.id, sorted, stamp);
    return sorted;
  } catch {
    return [];
  } finally {
    libraryScanPromises.delete(library.id);
  }
}

export async function scanLibrary(library: Library, options: { refresh?: boolean } = {}): Promise<ContentItem[]> {
  const stamp = "work-metadata-v3:" + await getLibraryMtime(library.path);
  const cached = cacheService.getCachedScan<ContentItem[]>(library.id, stamp);
  if (cached && !options.refresh) return cached;

  const running = libraryScanPromises.get(library.id);
  if (running) {
    if (options.refresh) {
      await running;
      return scanLibrary(library, { refresh: true });
    }
    const latest = cacheService.getLatestScan<ContentItem[]>(library.id);
    return latest?.data ?? running;
  }

  const latest = cacheService.getLatestScan<ContentItem[]>(library.id);
  const refreshPromise = performLibraryScan(library, stamp);
  libraryScanPromises.set(library.id, refreshPromise);

  if (latest && !options.refresh) {
    void refreshPromise.catch((error) => console.error(`[MEDIA] Atualização da biblioteca ${library.id}:`, error));
    return latest.data;
  }

  return refreshPromise;
}

export async function getContentCoverPath(library: Library, contentId: string): Promise<string | null> {
  if (getLibraryIdFromContentId(contentId) !== library.id) {
    return null;
  }

  const folderName = Buffer.from(contentId.split(":")[1] ?? "", "base64url").toString("utf8");
  const workPath = path.join(library.path, folderName);
  const workStat = await fs.stat(workPath).catch(() => null);
  if (workStat?.isFile() && directPdfLibraryKinds.has(library.kind) && isReadableDocument(folderName)) {
    return resolveSafeMediaPath(library.path, library.path, folderName);
  }
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

export function resolveSafeMediaPath(libraryPath: string, basePath: string, relativePath: string): string | null {
  const pagePath = path.resolve(basePath, relativePath);
  const safeBase = path.resolve(libraryPath);
  const relativePagePath = path.relative(safeBase, pagePath);
  if (relativePagePath.startsWith("..") || path.isAbsolute(relativePagePath)) {
    return null;
  }

  return pagePath;
}

export function findChapterForPage(chapters: ChapterInfo[], pageIndex: number): { chapter: ChapterInfo; localPageIndex: number } | null {
  const chapter = chapters.find((item) => pageIndex >= item.startPage && pageIndex < item.startPage + item.pageCount);
  return chapter ? { chapter, localPageIndex: pageIndex - chapter.startPage } : null;
}

async function listChapterPageNames(contentPath: string, chapter: ChapterInfo): Promise<string[]> {
  const isLooseFiles = chapter.name === "Arquivos soltos";
  const chapterPath = isLooseFiles ? contentPath : resolveSafeMediaPath(contentPath, contentPath, chapter.name);
  if (!chapterPath) {
    return [];
  }

  const entries = await fs.readdir(chapterPath, { withFileTypes: true }).catch(() => []);
  return sortPages(entries
    .filter((entry) => entry.isFile() && isReadablePage(entry.name) && (!isLooseFiles || !isCoverFile(entry.name)))
    .map((entry) => entry.name));
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
  const contentPath = resolveSafeMediaPath(library.path, library.path, folderName);
  if (!contentPath) {
    return null;
  }
  const stat = await fs.stat(contentPath).catch(() => null);
  if (stat?.isFile() && directPdfLibraryKinds.has(library.kind) && isReadableDocument(folderName)) {
    return pageIndex === 0 ? contentPath : null;
  }
  if (!stat?.isDirectory()) {
    return null;
  }

  const resolution = findChapterForPage(content.chapters, pageIndex);
  if (!resolution) {
    return null;
  }

  const pageNames = await listChapterPageNames(contentPath, resolution.chapter);
  const pageName = pageNames[resolution.localPageIndex];
  if (!pageName) {
    return null;
  }

  const chapterPath = resolution.chapter.name === "Arquivos soltos"
    ? contentPath
    : resolveSafeMediaPath(library.path, contentPath, resolution.chapter.name);
  return chapterPath ? resolveSafeMediaPath(library.path, chapterPath, pageName) : null;
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

function wrapEpubChapterHtml(html: string, contentId: string, chapterHref: string, theme: "light" | "sepia" | "dark" = "light", direction: "ltr" | "rtl" = "ltr"): string {
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
    : theme === "sepia" ? {
        colorScheme: "light",
        background: "#f4ecd8",
        text: "#423626",
        link: "#795534"
      } : {
        colorScheme: "light",
        background: "#f8f5ee",
        text: "#1f1b16",
        link: "#234c8c"
      };

  return `<!doctype html>
<html lang="pt-BR"${direction === "rtl" ? ' dir="rtl"' : ""}>
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

      * { box-sizing: border-box; }

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
        overflow: visible !important;
        padding: clamp(24px, 5vw, 56px) clamp(18px, 8vw, 96px) !important;
        font-size: clamp(18px, 2.2vw, 22px);
        line-height: 1.72;
      }

      .pugotiread-epub-document {
        width: min(760px, 100%);
        margin: 0 auto;
        overflow-wrap: break-word;
        overflow: visible !important;
      }

      .pugotiread-epub-document :is(p, li, h1, h2, h3, h4, blockquote) {
        height: auto !important;
        max-height: none !important;
        overflow: visible !important;
        text-overflow: clip !important;
      }

      .pugotiread-epub-rtl {
        direction: rtl;
        text-align: right;
      }

      p,
      li {
        line-height: 1.72 !important;
        font-family: inherit !important;
        font-size: inherit !important;
        letter-spacing: normal !important;
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

      mark[data-epub-highlight] {
        background: #ffe36b !important;
        color: #24201a !important;
      }
    </style>
  </head>
  <body${direction === "rtl" ? ' class="pugotiread-epub-rtl"' : ""}>
    <main class="pugotiread-epub-document">${body}</main>
  </body>
</html>`;
}

export async function getContentEpubChapterHtml(library: Library, contentId: string, pageIndex: number, theme: "light" | "sepia" | "dark" = "light", direction: "ltr" | "rtl" = "ltr"): Promise<string | null> {
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

  return wrapEpubChapterHtml(rawHtml, contentId, chapter.href, theme, direction);
}

const epubTextLengthCache = new Map<string, { stamp: string; lengths: number[] }>();

/** Text weights make the percentage independent of arbitrary EPUB spine splits. */
export async function getContentEpubTextLengths(library: Library, contentId: string): Promise<number[] | null> {
  if (!textLibraryKinds.has(library.kind)) return null;
  const epubPath = await findEpubPath(library, contentId);
  if (!epubPath) return null;
  const stat = await fs.stat(epubPath).catch(() => null);
  if (!stat) return null;
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  const cached = epubTextLengthCache.get(epubPath);
  if (cached?.stamp === stamp) return cached.lengths;
  const epub = await getEpubInfo(epubPath);
  if (!epub) return null;
  const lengths: number[] = [];
  for (const chapter of epub.chapters) {
    const html = await readZipText(epubPath, chapter.href);
    lengths.push(Math.max(extrairTextoEpub(html ?? "").replace(/\s+/g, " ").trim().length, 1));
  }
  epubTextLengthCache.set(epubPath, { stamp, lengths });
  return lengths;
}

export type EpubSearchResultado = {
  chapterIndex: number;
  chapterName: string;
  count: number;
};

export function extrairTextoEpub(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;|&#38;/gi, "&")
    .replace(/&lt;|&#60;/gi, "<")
    .replace(/&gt;|&#62;/gi, ">")
    .replace(/&quot;|&#34;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ");
}

export function normalizarTextoBusca(valor: string): string {
  return valor.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").replace(/\s+/g, " ");
}

export function contarOcorrenciasTexto(texto: string, termo: string): number {
  if (!termo) return 0;
  let total = 0;
  let inicio = 0;
  while (inicio < texto.length) {
    const indice = texto.indexOf(termo, inicio);
    if (indice < 0) break;
    total += 1;
    inicio = indice + termo.length;
  }
  return total;
}

// Busca textual dentro do livro (EPUB): lê o texto de cada capítulo e devolve,
// em ordem, os capítulos que contêm o termo com a contagem de ocorrências.
// Somente para bibliotecas de texto (book/lightNovel).
export async function searchEpubText(library: Library, contentId: string, termoBruto: string): Promise<{ total: number; results: EpubSearchResultado[] }> {
  if (!textLibraryKinds.has(library.kind)) {
    return { total: 0, results: [] };
  }
  const termo = normalizarTextoBusca(termoBruto).trim();
  if (!termo) {
    return { total: 0, results: [] };
  }

  const epubPath = await findEpubPath(library, contentId);
  if (!epubPath) {
    return { total: 0, results: [] };
  }

  const epub = await getEpubInfo(epubPath);
  const results: EpubSearchResultado[] = [];
  let total = 0;
  const chapters = epub?.chapters ?? [];
  for (let index = 0; index < chapters.length; index += 1) {
    const chapter = chapters[index];
    const rawHtml = await readZipText(epubPath, chapter.href);
    if (!rawHtml) continue;
    const texto = normalizarTextoBusca(extrairTextoEpub(rawHtml));
    const count = contarOcorrenciasTexto(texto, termo);
    if (count > 0) {
      total += count;
      results.push({ chapterIndex: index, chapterName: chapter.name || `Capítulo ${index + 1}`, count });
    }
  }

  return { total, results };
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
