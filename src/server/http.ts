import fs from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.js";

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
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

function getStaticCacheControl(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html" || extension === ".js" || extension === ".css") {
    return "no-cache, no-store, must-revalidate";
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

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]);

function getFileCacheControl(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (imageExtensions.has(ext)) {
    return "public, max-age=86400, immutable";
  }
  return "private, max-age=3600";
}

export async function sendFile(res: ServerResponse, filePath: string, cacheControl = getFileCacheControl(filePath)): Promise<void> {
  const file = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": contentTypes.get(ext) ?? "application/octet-stream",
    "Cache-Control": cacheControl
  });
  res.end(file);
}

export function getContentType(filePath: string): string {
  return contentTypes.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

export function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, max-age=3600"
  });
  res.end(html);
}

export function sendBuffer(res: ServerResponse, filePath: string, file: Buffer): void {
  res.writeHead(200, {
    "Content-Type": getContentType(filePath),
    "Cache-Control": getFileCacheControl(filePath)
  });
  res.end(file);
}

export async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  if (requestedPath.startsWith("/icons/")) {
    const iconPath = path.resolve(config.iconsDir, `.${decodeURIComponent(requestedPath.slice("/icons".length))}`);
    if (!iconPath.startsWith(path.resolve(config.iconsDir))) {
      sendJson(res, 403, { error: "Acesso negado." });
      return;
    }

    try {
      const file = await fs.readFile(iconPath);
      res.writeHead(200, { "Content-Type": contentTypes.get(path.extname(iconPath).toLowerCase()) ?? "application/octet-stream" });
      res.end(file);
    } catch {
      sendJson(res, 404, { error: "Ícone não encontrado." });
    }
    return;
  }

  const servesWebModule = requestedPath.startsWith("/UI/Web/");
  const baseDir = requestedPath === "/app.js"
    ? config.clientDir
    : servesWebModule
      ? path.resolve(config.clientDir, "../UI/Web")
      : config.publicDir;
  const staticPath = servesWebModule ? requestedPath.slice("/UI/Web".length) : requestedPath;
  const filePath = path.resolve(baseDir, `.${staticPath}`);

  if (!filePath.startsWith(path.resolve(baseDir))) {
    sendJson(res, 403, { error: "Acesso negado." });
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypes.get(path.extname(filePath)) ?? "application/octet-stream",
      "Cache-Control": getStaticCacheControl(filePath)
    });
    res.end(file);
  } catch {
    if (path.extname(requestedPath)) {
      sendJson(res, 404, { error: "Arquivo estático não encontrado." });
      return;
    }

    const fallback = await fs.readFile(path.join(config.publicDir, "index.html"));
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate"
    });
    res.end(fallback);
  }
}
