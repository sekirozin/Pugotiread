import test from "node:test";
import assert from "node:assert/strict";
import { epubBookPercent, epubViewportOffset } from "../src/UI/Web/epub-progress.js";

test("EPUB: progresso pondera pelo texto, não pelo número arbitrário de arquivos", () => {
  assert.equal(epubBookPercent([100, 900], 0, 1), 10);
  assert.equal(epubBookPercent([100, 900], 1, 0.5), 55);
  assert.equal(epubBookPercent([100, 900], 1, 1), 100);
});

test("EPUB: posição interna permanece válida quando a diagramação muda", () => {
  assert.equal(epubViewportOffset(450, 1000, 100), 0.5);
  assert.equal(epubViewportOffset(0, 100, 100), 0);
  assert.equal(epubViewportOffset(2000, 1000, 100), 1);
});
