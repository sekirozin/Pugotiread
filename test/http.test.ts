import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isPathInside, sendFile } from "../src/server/http.js";

async function withFileServer(run: (origin: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pugotiread-http-"));
  const filePath = path.join(dir, "manual.pdf");
  await fs.writeFile(filePath, Buffer.from("0123456789abcdef"));
  const server = http.createServer((req, res) => void sendFile(req, res, filePath).catch((error) => {
    res.destroy(error as Error);
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("sendFile entrega PDF por Range e mantém validadores", async () => {
  await withFileServer(async (origin) => {
    const partial = await fetch(origin, { headers: { Range: "bytes=2-5" } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-type"), "application/pdf");
    assert.equal(partial.headers.get("content-range"), "bytes 2-5/16");
    assert.equal(partial.headers.get("content-length"), "4");
    assert.equal(partial.headers.get("accept-ranges"), "bytes");
    assert.equal(await partial.text(), "2345");

    const etag = partial.headers.get("etag");
    assert(etag);
    const unchanged = await fetch(origin, { headers: { "If-None-Match": etag } });
    assert.equal(unchanged.status, 304);
    assert.equal(await unchanged.text(), "");
  });
});

test("sendFile responde 416 para Range inválido e preserva HEAD", async () => {
  await withFileServer(async (origin) => {
    const invalid = await fetch(origin, { headers: { Range: "bytes=20-30" } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get("content-range"), "bytes */16");

    const head = await fetch(origin, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "16");
    assert.equal(await head.text(), "");
  });
});

test("validação de paths não aceita prefixos vizinhos nem traversal", () => {
  assert.equal(isPathInside("/srv/public", "/srv/public/app.js"), true);
  assert.equal(isPathInside("/srv/public", "/srv/publicidade/app.js"), false);
  assert.equal(isPathInside("/srv/public", "/srv/public/../segredo"), false);
});
