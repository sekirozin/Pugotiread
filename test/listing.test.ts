import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import type { Library } from "./src/shared/types.js";

const globallyListedLibraryKinds = new Set<Library["kind"]>(["manga", "manhwa", "comic"]);
const listGlobally = (libraries: Library[]) => libraries.filter((library) => globallyListedLibraryKinds.has(library.kind));

test("catálogo e lançamentos excluem other e mantêm livros fora dessas views", () => {
  const libraries: Library[] = [
    { id: "rpg", name: "RPG", kind: "other", path: "/media/RPG" },
    { id: "livros", name: "Livros", kind: "book", path: "/media/Livros" },
    { id: "manga", name: "Mangás", kind: "manga", path: "/media/Mangás" }
  ];
  assert.deepEqual(listGlobally(libraries).map((library) => library.id), ["manga"]);
});

test("biblioteca other continua disponível na view própria", () => {
  const libraries: Library[] = [
    { id: "rpg", name: "RPG", kind: "other", path: "/media/RPG" }
  ];
  const activeLibrary = libraries.find((library) => library.id === "rpg");
  assert.equal(activeLibrary?.kind, "other");
  assert.equal(activeLibrary?.name, "RPG");
});

test("cache antigo dos lançamentos também remove obras de other", () => {
  const libraries: Library[] = [
    { id: "rpg", name: "RPG", kind: "other", path: "/media/RPG" },
    { id: "manga", name: "Mangás", kind: "manga", path: "/media/Mangás" }
  ];
  const globallyListedIds = new Set(listGlobally(libraries).map((library) => library.id));
  const cachedContents = [{ libraryId: "rpg", id: "rpg:1" }, { libraryId: "manga", id: "manga:1" }];
  assert.deepEqual(cachedContents.filter((content) => globallyListedIds.has(content.libraryId)).map((content) => content.id), ["manga:1"]);
});

test("a versão do cache e o carregamento de lançamentos não restauram other", () => {
  const app = fs.readFileSync(new URL("../src/UI/Web/app.ts", import.meta.url), "utf8");
  assert.ok(app.includes('const homeCachePrefix = "pugotiread-home-cache-v3"'));
  assert.ok(app.includes("state.readingNowContents = filterGloballyListedContents("));
  assert.ok(app.includes("await loadLibraryContents(getGloballyListedLibraries(visibleLibraries))"));
});

test("a listagem não duplica uma obra ao combinar fontes", () => {
  const contents = [{ id: "rpg:1" }, { id: "manga:1" }, { id: "rpg:1" }];
  const unique = [...new Map(contents.map((content) => [content.id, content])).values()];
  assert.deepEqual(unique.map((content) => content.id), ["rpg:1", "manga:1"]);
});

test("leitor PDF renderiza botão acessível próprio e leitor não-PDF não o recebe", () => {
  const app = fs.readFileSync(new URL("../src/UI/Web/app.ts", import.meta.url), "utf8");
  assert.ok(app.includes('const isPdfReader = content.pageTypes.includes("pdf")'));
  assert.ok(app.includes("reader-pdf-back"));
  assert.ok(app.includes('data-reader-action="close"'));
  assert.ok(app.includes('aria-label="Voltar para a página inicial"'));
});


test("Início do leitor PDF fica acima das zonas e fecha por handler próprio", () => {
  const app = fs.readFileSync(new URL("../src/UI/Web/app.ts", import.meta.url), "utf8");
  const styles = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.ok(app.includes("function closeReader(): void"));
  assert.ok(app.includes("function bindReaderPdfHomeButton(): void"));
  assert.ok(app.includes("closeReader();"));
  assert.match(styles, /:is\(\.reader-pdf-toolbar, \.reader-pdf-side-toolbar\)\s*\{\s*position: absolute; z-index: 1040;/);
});

test("PDF usa viewer local controlado, sem iframe ou controles do navegador", () => {
  const app = fs.readFileSync(new URL("../src/UI/Web/app.ts", import.meta.url), "utf8");
  const styles = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.ok(app.includes('class="reader ${isPdfReader ? "reader-pdf-reader" : ""}'));
  assert.ok(app.includes("reader-pdf-fullscreen"));
  assert.ok(app.includes("reader-pdf-search-button"));
  assert.ok(app.includes("data-pdf-pages"));
  assert.ok(!app.includes('class="reader-pdf ${vertical ? "vertical-page" : ""}"'));
  assert.ok(app.includes("await root.requestFullscreen();"));
  assert.ok(app.includes("fullscreen === reader || fullscreen === document.documentElement"));
  assert.ok(styles.includes(".reader-pdf-reader .reader-pagination { display: none; }"));
  assert.ok(styles.includes(".pdf-page.is-search-result"));
});

test("viewer PDF local usa PDF.js, worker local e pesquisa com resultado navegável", () => {
  const viewer = fs.readFileSync(new URL("../src/UI/Web/pdf-viewer.ts", import.meta.url), "utf8");
  assert.ok(viewer.includes('"/pdfjs/pdf.mjs?v=reader-epub-arrows-20260902-v12"'));
  assert.ok(viewer.includes('"/pdfjs/pdf.worker.mjs?v=reader-epub-arrows-20260902-v12"'));
  assert.ok(viewer.includes("rangeChunkSize: 65_536"));
  assert.ok(viewer.includes("${indiceResultado + 1}/${resultados.length}"));
  assert.ok(viewer.includes("scrollIntoView"));
});
