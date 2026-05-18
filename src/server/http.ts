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
  [".pdf", "application/pdf"]
]);

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

export async function sendFile(res: ServerResponse, filePath: string): Promise<void> {
  const file = await fs.readFile(filePath);
  res.writeHead(200, {
    "Content-Type": contentTypes.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream",
    "Cache-Control": "private, max-age=3600"
  });
  res.end(file);
}

export async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const baseDir = requestedPath === "/app.js" ? config.clientDir : config.publicDir;
  const filePath = path.resolve(baseDir, `.${requestedPath}`);

  if (!filePath.startsWith(path.resolve(baseDir))) {
    sendJson(res, 403, { error: "Acesso negado." });
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentTypes.get(path.extname(filePath)) ?? "application/octet-stream" });
    res.end(file);
  } catch {
    if (path.extname(requestedPath)) {
      sendJson(res, 404, { error: "Arquivo estático não encontrado." });
      return;
    }

    const fallback = await fs.readFile(path.join(config.publicDir, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fallback);
  }
}
