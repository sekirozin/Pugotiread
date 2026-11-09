import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.js";

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".avif", "image/avif"],
  [".svg", "image/svg+xml"],
  [".pdf", "application/pdf"],
  [".epub", "application/epub+zip"],
  [".xhtml", "application/xhtml+xml; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"],
  [".opf", "application/oebps-package+xml; charset=utf-8"],
  [".ncx", "application/x-dtbncx+xml; charset=utf-8"],
  [".otf", "font/otf"],
  [".ttf", "font/ttf"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"]
]);

function getStaticCacheControl(filePath: string, hasVersion: boolean): string {
  const extension = path.extname(filePath).toLowerCase();
  if ((extension === ".js" || extension === ".css") && hasVersion) {
    return "public, max-age=31536000, immutable";
  }
  if (extension === ".html") {
    return "no-cache, private, must-revalidate";
  }
  return "private, max-age=3600";
}

export async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

export function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

function getFileCacheControl(filePath: string): string {
  return "private, max-age=3600";
}

function makeEtag(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${Math.trunc(mtimeMs).toString(16)}"`;
}

function isNotModified(req: IncomingMessage, etag: string, mtimeMs: number): boolean {
  const ifNoneMatch = req.headers["if-none-match"];
  if (ifNoneMatch) {
    return ifNoneMatch.split(",").map((value) => value.trim()).includes(etag) || ifNoneMatch.trim() === "*";
  }
  const ifModifiedSince = req.headers["if-modified-since"];
  const since = typeof ifModifiedSince === "string" ? Date.parse(ifModifiedSince) : Number.NaN;
  return Number.isFinite(since) && Math.trunc(mtimeMs / 1000) <= Math.trunc(since / 1000);
}

export function parseSingleRange(value: string | undefined, size: number): { start: number; end: number } | null | "invalid" {
  if (!value) return null;
  if (!value.startsWith("bytes=") || value.includes(",") || size <= 0) return "invalid";
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return "invalid";

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return { start: Math.max(size - suffixLength, 0), end: size - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd < start) return "invalid";
  return { start, end: Math.min(requestedEnd, size - 1) };
}

export async function sendFile(req: IncomingMessage, res: ServerResponse, filePath: string, cacheControl = getFileCacheControl(filePath)): Promise<void> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("O caminho solicitado não é um arquivo.");
  const ext = path.extname(filePath).toLowerCase();
  const etag = makeEtag(stat.size, stat.mtimeMs);
  const commonHeaders = {
    "Content-Type": contentTypes.get(ext) ?? "application/octet-stream",
    "Cache-Control": cacheControl,
    "Accept-Ranges": "bytes",
    "ETag": etag,
    "Last-Modified": stat.mtime.toUTCString()
  };

  if (isNotModified(req, etag, stat.mtimeMs)) {
    res.writeHead(304, commonHeaders);
    res.end();
    return;
  }

  const ifRange = req.headers["if-range"];
  const ifRangeDate = typeof ifRange === "string" ? Date.parse(ifRange) : Number.NaN;
  const rangeAllowed = !ifRange || ifRange === etag || (Number.isFinite(ifRangeDate) && stat.mtimeMs <= ifRangeDate + 999);
  const range = rangeAllowed ? parseSingleRange(req.headers.range, stat.size) : null;
  if (range === "invalid") {
    res.writeHead(416, { ...commonHeaders, "Content-Range": `bytes */${stat.size}`, "Content-Length": "0" });
    res.end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(stat.size - 1, 0);
  const contentLength = range ? end - start + 1 : stat.size;
  res.writeHead(range ? 206 : 200, {
    ...commonHeaders,
    "Content-Length": String(contentLength),
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${stat.size}` } : {})
  });
  if (req.method === "HEAD" || stat.size === 0) {
    res.end();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, range ? { start, end } : undefined);
    const abort = () => {
      stream.destroy();
      resolve();
    };
    req.once("aborted", abort);
    res.once("close", abort);
    stream.once("error", (error) => {
      if (res.headersSent) {
        res.destroy(error);
        resolve();
        return;
      }
      reject(error);
    });
    res.once("finish", resolve);
    stream.pipe(res);
  });
}

export function getContentType(filePath: string): string {
  return contentTypes.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

export function isPathInside(basePath: string, candidatePath: string): boolean {
  const relativePath = path.relative(path.resolve(basePath), path.resolve(candidatePath));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function sendHtml(req: IncomingMessage, res: ServerResponse, html: string): void {
  const body = Buffer.from(html);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, max-age=3600",
    "Content-Length": String(body.length)
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

export function sendBuffer(req: IncomingMessage, res: ServerResponse, filePath: string, file: Buffer): void {
  res.writeHead(200, {
    "Content-Type": getContentType(filePath),
    "Cache-Control": getFileCacheControl(filePath),
    "Content-Length": String(file.length)
  });
  res.end(req.method === "HEAD" ? undefined : file);
}

export async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  if (requestedPath.startsWith("/icons/")) {
    const iconPath = path.resolve(config.iconsDir, `.${decodeURIComponent(requestedPath.slice("/icons".length))}`);
    if (!isPathInside(config.iconsDir, iconPath)) {
      sendJson(res, 403, { error: "Acesso negado." });
      return;
    }

    try {
      await sendFile(req, res, iconPath, "public, max-age=86400");
    } catch {
      sendJson(res, 404, { error: "Ícone não encontrado." });
    }
    return;
  }

  const servesWebModule = requestedPath.startsWith("/UI/Web/");
  const servesSharedModule = requestedPath.startsWith('/shared/');
  const baseDir = requestedPath === "/app.js"
    ? config.clientDir
    : servesWebModule
      ? path.resolve(config.clientDir, "../UI/Web")
      : servesSharedModule ? path.resolve(config.clientDir,'../shared') : config.publicDir;
  const staticPath = servesWebModule ? requestedPath.slice("/UI/Web".length) : servesSharedModule ? requestedPath.slice('/shared'.length) : requestedPath;
  const filePath = path.resolve(baseDir, `.${staticPath}`);

  if (!isPathInside(baseDir, filePath)) {
    sendJson(res, 403, { error: "Acesso negado." });
    return;
  }

  try {
    await sendFile(req, res, filePath, getStaticCacheControl(filePath, url.searchParams.has("v")));
  } catch {
    if (path.extname(requestedPath)) {
      sendJson(res, 404, { error: "Arquivo estático não encontrado." });
      return;
    }

    await sendFile(req, res, path.join(config.publicDir, "index.html"), "no-cache, private, must-revalidate");
  }
}
