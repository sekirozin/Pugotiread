import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
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
function getStaticCacheControl(filePath, hasVersion) {
    const extension = path.extname(filePath).toLowerCase();
    if ((extension === ".js" || extension === ".mjs" || extension === ".css") && hasVersion) {
        return "public, max-age=31536000, immutable";
    }
    if (extension === ".html") {
        return "no-cache, private, must-revalidate";
    }
    return "private, max-age=3600";
}
export async function readJson(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
}
export function sendNoContent(res) {
    res.writeHead(204);
    res.end();
}
function getFileCacheControl(filePath) {
    return "private, max-age=3600";
}
function makeEtag(size, mtimeMs) {
    return `"${size.toString(16)}-${Math.trunc(mtimeMs).toString(16)}"`;
}
function isNotModified(req, etag, mtimeMs) {
    const ifNoneMatch = req.headers["if-none-match"];
    if (ifNoneMatch) {
        return ifNoneMatch.split(",").map((value) => value.trim()).includes(etag) || ifNoneMatch.trim() === "*";
    }
    const ifModifiedSince = req.headers["if-modified-since"];
    const since = typeof ifModifiedSince === "string" ? Date.parse(ifModifiedSince) : Number.NaN;
    return Number.isFinite(since) && Math.trunc(mtimeMs / 1000) <= Math.trunc(since / 1000);
}
export function parseSingleRange(value, size) {
    if (!value)
        return null;
    if (!value.startsWith("bytes=") || value.includes(",") || size <= 0)
        return "invalid";
    const match = value.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (!match[1] && !match[2]))
        return "invalid";
    if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0)
            return "invalid";
        return { start: Math.max(size - suffixLength, 0), end: size - 1 };
    }
    const start = Number(match[1]);
    const requestedEnd = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd < start)
        return "invalid";
    return { start, end: Math.min(requestedEnd, size - 1) };
}
const extensoesComprimiveis = new Set([".html", ".css", ".js", ".mjs", ".json", ".svg"]);
const comprimirBrotli = promisify(zlib.brotliCompress);
const comprimirGzip = promisify(zlib.gzip);
const LIMITE_ARQUIVO_COMPRIMIDO = 8 * 1024 * 1024;
const LIMITE_CACHE_COMPRIMIDO = 16 * 1024 * 1024;
const cacheComprimido = new Map();
let bytesCacheComprimido = 0;
async function comprimirComCache(chave, codificacao, filePath) {
    const pronto = cacheComprimido.get(chave);
    if (pronto) {
        cacheComprimido.delete(chave);
        cacheComprimido.set(chave, pronto);
        return pronto;
    }
    const original = await fs.readFile(filePath);
    const corpo = codificacao === "br"
        ? await comprimirBrotli(original, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: original.length } })
        : await comprimirGzip(original, { level: 6 });
    cacheComprimido.set(chave, corpo);
    bytesCacheComprimido += corpo.length;
    for (const [antiga, valor] of cacheComprimido) {
        if (bytesCacheComprimido <= LIMITE_CACHE_COMPRIMIDO || antiga === chave)
            break;
        cacheComprimido.delete(antiga);
        bytesCacheComprimido -= valor.length;
    }
    return corpo;
}
/** Envia texto estático comprimido. Devolve false quando o pedido deve seguir como arquivo comum. */
async function enviarComprimido(req, res, filePath, cacheControl) {
    const ext = path.extname(filePath).toLowerCase();
    if (req.method !== "GET" || req.headers.range || !extensoesComprimiveis.has(ext))
        return false;
    const aceita = String(req.headers["accept-encoding"] ?? "");
    const codificacao = /\bbr\b/.test(aceita) ? "br" : /\bgzip\b/.test(aceita) ? "gzip" : null;
    const stat = await fs.stat(filePath);
    if (!codificacao || !stat.isFile() || stat.size < 1024 || stat.size > LIMITE_ARQUIVO_COMPRIMIDO)
        return false;
    const etag = `${makeEtag(stat.size, stat.mtimeMs).slice(0, -1)}-${codificacao}"`;
    const cabecalhos = {
        "Content-Type": contentTypes.get(ext) ?? "application/octet-stream",
        "Cache-Control": cacheControl,
        "ETag": etag,
        "Last-Modified": stat.mtime.toUTCString(),
        "Vary": "Accept-Encoding",
        "Content-Encoding": codificacao
    };
    if (isNotModified(req, etag, stat.mtimeMs)) {
        res.writeHead(304, cabecalhos);
        res.end();
        return true;
    }
    const corpo = await comprimirComCache(`${filePath}:${etag}`, codificacao, filePath);
    res.writeHead(200, { ...cabecalhos, "Content-Length": String(corpo.length) });
    res.end(corpo);
    return true;
}
export async function sendFile(req, res, filePath, cacheControl = getFileCacheControl(filePath)) {
    const stat = await fs.stat(filePath);
    if (!stat.isFile())
        throw new Error("O caminho solicitado não é um arquivo.");
    const ext = path.extname(filePath).toLowerCase();
    const etag = makeEtag(stat.size, stat.mtimeMs);
    const commonHeaders = {
        "Content-Type": contentTypes.get(ext) ?? "application/octet-stream",
        "Cache-Control": cacheControl,
        "Accept-Ranges": "bytes",
        "ETag": etag,
        "Last-Modified": stat.mtime.toUTCString(),
        ...(extensoesComprimiveis.has(ext) ? { "Vary": "Accept-Encoding" } : {})
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
    await new Promise((resolve, reject) => {
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
export function getContentType(filePath) {
    return contentTypes.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}
export function isPathInside(basePath, candidatePath) {
    const relativePath = path.relative(path.resolve(basePath), path.resolve(candidatePath));
    return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}
// Livros vêm de fora: o capítulo roda na mesma origem do app (o leitor precisa acessar o documento), então não pode executar nada.
const POLITICA_CAPITULO_EPUB = "default-src 'none'; img-src 'self' data: blob:; media-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'none'; base-uri 'none'; form-action 'none'";
export function sendHtml(req, res, html) {
    const body = Buffer.from(html);
    res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": POLITICA_CAPITULO_EPUB,
        "Cache-Control": "private, max-age=3600",
        "Content-Length": String(body.length)
    });
    res.end(req.method === "HEAD" ? undefined : body);
}
export function sendBuffer(req, res, filePath, file) {
    res.writeHead(200, {
        "Content-Type": getContentType(filePath),
        "Content-Security-Policy": `sandbox; ${POLITICA_CAPITULO_EPUB}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": getFileCacheControl(filePath),
        "Content-Length": String(file.length)
    });
    res.end(req.method === "HEAD" ? undefined : file);
}
export async function serveStatic(req, res) {
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
        }
        catch {
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
            : servesSharedModule ? path.resolve(config.clientDir, '../shared') : config.publicDir;
    const staticPath = servesWebModule ? requestedPath.slice("/UI/Web".length) : servesSharedModule ? requestedPath.slice('/shared'.length) : requestedPath;
    const filePath = path.resolve(baseDir, `.${staticPath}`);
    if (!isPathInside(baseDir, filePath)) {
        sendJson(res, 403, { error: "Acesso negado." });
        return;
    }
    try {
        const controleCache = getStaticCacheControl(filePath, url.searchParams.has("v"));
        if (!(await enviarComprimido(req, res, filePath, controleCache)))
            await sendFile(req, res, filePath, controleCache);
    }
    catch {
        if (path.extname(requestedPath)) {
            sendJson(res, 404, { error: "Arquivo estático não encontrado." });
            return;
        }
        await sendFile(req, res, path.join(config.publicDir, "index.html"), "no-cache, private, must-revalidate");
    }
}
