import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Library } from "../src/shared/types.js";

const testStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "pugotiread-media-state-"));
process.env.CACHE_DIR = path.join(testStateDir, "cache");
process.env.LIBRARY_CACHE_DB_FILE = path.join(testStateDir, "library-cache.db");
const { agruparPorMarcadores, agruparPorToc, contarOcorrenciasTexto, detectarMarcadorCapitulo, extrairTextoEpub, findChapterForPage, getContentCoverPath, getContentCoverThumbnail, getContentPagePath, normalizarTextoBusca, resolveSafeMediaPath, scanLibrary } = await import("../src/server/media.js");

test.after(async () => {
  await fs.rm(testStateDir, { recursive: true, force: true });
});

test("detecta marcador de capítulo em texto de página EPUB", () => {
  assert.deepEqual(detectarMarcadorCapitulo("CAPÍTULO DOIS O Vidro Que Sumiu uase dez anos haviam se passado"), {
    numero: 2,
    titulo: "O Vidro Que Sumiu"
  });
  assert.deepEqual(detectarMarcadorCapitulo("CAPÍTULO UM O Menino Que Sobreviveu o Sr. e a Sra. Dursley"), {
    numero: 1,
    titulo: "O Menino Que Sobreviveu"
  });
  assert.deepEqual(detectarMarcadorCapitulo("CAPÍTULO QUATRO O Guardiao das Chaves UM! 5 Bateram"), {
    numero: 4,
    titulo: "O Guardiao das Chaves"
  });
  assert.deepEqual(detectarMarcadorCapitulo("CAPÍTULO 12 O Espelho de Ojesed Natal se aproximava."), {
    numero: 12,
    titulo: "O Espelho de Ojesed"
  });
  assert.equal(detectarMarcadorCapitulo("— Acorde! Levante-se! Agora! Harry acordou assustado."), null);
  assert.equal(detectarMarcadorCapitulo(""), null);
});

test("agrupa páginas do EPUB em capítulos reais pelos marcadores", () => {
  const grupos = agruparPorMarcadores(
    [
      { indice: 8, numero: 1, titulo: "O Menino Que Sobreviveu" },
      { indice: 23, numero: 2, titulo: "O Vidro Que Sumiu" },
      { indice: 34, numero: 3, titulo: "As Cartas de Ninguém" }
    ],
    50
  );
  assert.deepEqual(grupos[0], {
    name: "Preliminares",
    startPage: 0,
    pageCount: 8,
    isSpecial: false,
    addedAt: null
  });
  assert.equal(grupos[1]?.name, "Capítulo 1 — O Menino Que Sobreviveu");
  assert.equal(grupos[1]?.startPage, 8);
  assert.equal(grupos[1]?.pageCount, 15);
  assert.equal(grupos[2]?.name, "Capítulo 2 — O Vidro Que Sumiu");
  assert.equal(grupos[2]?.startPage, 23);
  assert.equal(grupos[2]?.pageCount, 11);
  assert.equal(grupos[3]?.name, "Capítulo 3 — As Cartas de Ninguém");
  assert.equal(grupos[3]?.startPage, 34);
  assert.equal(grupos[3]?.pageCount, 16);
});

test("agrupa páginas do EPUB pelos títulos do TOC (ncx/nav)", () => {
  const hrefs = [
    "EPUB/cover.xhtml",
    "EPUB/copyright.xhtml",
    "EPUB/prólogo.xhtml",
    "EPUB/tyrion.xhtml",
    "EPUB/daenerys.xhtml"
  ];
  const toc = [
    { name: "Capa", href: "EPUB/cover.xhtml" },
    { name: "Ficha Técnica", href: "EPUB/copyright.xhtml" },
    { name: "Prólogo", href: "EPUB/prólogo.xhtml" },
    { name: "Tyrion", href: "EPUB/tyrion.xhtml" },
    { name: "Daenerys", href: "EPUB/daenerys.xhtml" }
  ];
  const grupos = agruparPorToc(toc, hrefs);
  assert.equal(grupos.length, hrefs.length);
  assert.equal(grupos[0]?.name, "Capa");
  assert.equal(grupos[2]?.name, "Prólogo");
  assert.equal(grupos[2]?.startPage, 2);
  assert.equal(grupos[2]?.pageCount, 1);
  assert.equal(grupos[4]?.name, "Daenerys");
});

test("resolve capítulo por índices públicos sem scan global por página", () => {
  const chapters = [
    { name: "Cap. 1", startPage: 0, pageCount: 2, isSpecial: false },
    { name: "Cap. 2", startPage: 2, pageCount: 3, isSpecial: false }
  ];
  assert.deepEqual(findChapterForPage(chapters, 0), { chapter: chapters[0], localPageIndex: 0 });
  assert.deepEqual(findChapterForPage(chapters, 4), { chapter: chapters[1], localPageIndex: 2 });
  assert.equal(findChapterForPage(chapters, 5), null);
});

test("getContentPagePath resolve capítulo e Arquivos soltos com ordenação natural", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pugotiread-library-"));
  const workName = "Obra teste";
  const workPath = path.join(root, workName);
  await fs.mkdir(path.join(workPath, "Cap. 1"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(workPath, "Cap. 1", "10.jpg"), "dez"),
    fs.writeFile(path.join(workPath, "Cap. 1", "2.jpg"), "dois"),
    fs.writeFile(path.join(workPath, "extra.pdf"), "%PDF-1.7"),
    fs.writeFile(path.join(workPath, "cover.jpg"), "capa")
  ]);
  const library: Library = { id: "teste", name: "Teste", kind: "manga", path: root };
  const contentId = `teste:${Buffer.from(workName).toString("base64url")}`;
  try {
    assert.equal(await getContentPagePath(library, contentId, 0), path.join(workPath, "Cap. 1", "2.jpg"));
    assert.equal(await getContentPagePath(library, contentId, 1), path.join(workPath, "Cap. 1", "10.jpg"));
    assert.equal(await getContentPagePath(library, contentId, 2), path.join(workPath, "extra.pdf"));
    assert.equal(await getContentPagePath(library, contentId, 3), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("resolveSafeMediaPath bloqueia saída da biblioteca", () => {
  assert.equal(resolveSafeMediaPath("/media", "/media/obra", "cap/1.jpg"), "/media/obra/cap/1.jpg");
  assert.equal(resolveSafeMediaPath("/media", "/media/obra", "../../etc/passwd"), null);
});

test("detecta PDFs diretamente em biblioteca Outros como obras independentes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pugotiread-pdf-library-"));
  await Promise.all([
    fs.writeFile(path.join(root, "Arcano.pdf"), "%PDF-1.7"),
    fs.writeFile(path.join(root, "Básico Revisado.pdf"), "%PDF-1.7")
  ]);
  await fs.mkdir(path.join(root, "Tormenta RPG", "Ficha Tormenta"), { recursive: true });
  await fs.writeFile(path.join(root, "Tormenta RPG", "Ficha Tormenta", "Mephisto.pdf"), "%PDF-1.7");
  const library: Library = { id: "outros", name: "Outros", kind: "other", path: root };
  try {
    const contents = await scanLibrary(library, { refresh: true });
    assert.deepEqual(contents.map((content) => content.title), ["Arcano", "Básico Revisado", "Mephisto"]);
    assert.equal(contents.find(content => content.title === "Mephisto")?.system, "Tormenta RPG/Ficha Tormenta");
    assert.equal(contents[0]?.pageCount, 1);
    assert.deepEqual(contents[0]?.pageTypes, ["pdf"]);
    assert.equal(contents[0]?.chapters[0]?.pageCount, 1);

    const contentId = contents[0]?.id;
    assert(contentId);
    assert.equal(await getContentPagePath(library, contentId, 0), path.join(root, "Arcano.pdf"));
    assert.equal(await getContentPagePath(library, contentId, 1), null);
    assert.equal(await getContentCoverPath(library, contentId), path.join(root, "Arcano.pdf"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rasteriza a primeira página do PDF para a capa e invalida pelo estado do arquivo", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pugotiread-pdf-cover-"));
  const pdfPath = path.join(root, "Capa.pdf");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 4 0 R >>",
    "<< /Length 29 >>\nstream\n1 0 0 rg 0 0 200 300 re f\nendstream"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`;
  await fs.writeFile(pdfPath, pdf);
  const library: Library = { id: "pdf-capa", name: "PDF", kind: "other", path: root };
  try {
    const [content] = await scanLibrary(library, { refresh: true });
    assert(content);
    const coverPath = await getContentCoverThumbnail(library, content.id);
    assert(coverPath);
    if (await fs.access("/usr/bin/pdftoppm").then(() => true).catch(() => false)) {
      assert.equal(path.extname(coverPath), ".webp");
      assert.notEqual((await fs.readFile(coverPath)).subarray(0, 4).toString(), "%PDF");
      const originalMtime = (await fs.stat(pdfPath)).mtimeMs;
      await fs.utimes(pdfPath, new Date(), new Date(originalMtime + 2000));
      const refreshedCoverPath = await getContentCoverThumbnail(library, content.id);
      assert(refreshedCoverPath);
      assert.notEqual(refreshedCoverPath, coverPath);
    } else {
      assert.equal(coverPath, pdfPath);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("busca EPUB extrai texto, normaliza e conta ocorrências sem sensibilidade", () => {
  const texto = extrairTextoEpub("<p>Olá,&nbsp;mundo! &amp; <b>Luz</b>.</p><style>x</style>");
  assert.equal(contarOcorrenciasTexto(normalizarTextoBusca(texto), normalizarTextoBusca("LUZ")), 1);
  assert.equal(contarOcorrenciasTexto(normalizarTextoBusca("aa aa"), "aa"), 2);
  assert.equal(extrairTextoEpub("<p>A</p><p>B</p>").includes("<p>"), false);
});

test("getContentEpubChapterHtml aceita e propaga direção RTL/LTR", async () => {
  const source = await fs.readFile(new URL("../src/server/media.ts", import.meta.url), "utf8");
  assert.match(source, /getContentEpubChapterHtml\([^)]*direction: "ltr" \| "rtl" = "ltr"\)/);
  assert.match(source, /wrapEpubChapterHtml\([^)]*theme, direction\)/);
  assert.match(source, /pugotiread-epub-rtl/);
});
