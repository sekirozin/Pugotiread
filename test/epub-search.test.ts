import test from "node:test";
import assert from "node:assert/strict";
import { buscarNosCapitulos, contarOcorrencias, normalizarEpub, obterIndicesOcorrencias } from "../src/UI/Web/epub-search.js";

test("normalização remove acentos e converte caixa para busca sem sensibilidade", () => {
  assert.equal(normalizarEpub("LIÇÃO"), "licao");
  assert.equal(normalizarEpub("Ação").includes("acao"), true);
});

test("contagem de ocorrências não considera sobreposição", () => {
  assert.equal(contarOcorrencias("aaa", "aa"), 1);
  assert.equal(contarOcorrencias("ana", "a"), 2);
  assert.equal(contarOcorrencias("sem nada", "xyz"), 0);
});

test("busca nos capítulos devolve apenas os que contêm o termo, em ordem", () => {
  const capitulos = [
    { index: 0, name: "Primeiro", text: "O leão e o rato. O leão é rei." },
    { index: 1, name: "Segundo", text: "Nada a ver aqui." },
    { index: 2, name: "Terceiro", text: "o Rato voltou." }
  ];
  const resultados = buscarNosCapitulos(capitulos, "Leão");
  assert.deepEqual(resultados, [
    { chapterIndex: 0, chapterName: "Primeiro", count: 2 }
  ]);
  resultados.forEach((r) => {
    void r;
  });
  const ratos = buscarNosCapitulos(capitulos, "rato");
  assert.equal(ratos.length, 2);
  assert.equal(ratos[0].chapterIndex, 0);
  assert.equal(ratos[1].chapterIndex, 2);
});

test("busca conecta termo independente de acentos e espaços múltiplos", () => {
  const capitulos = [{ index: 0, name: "Um", text: "Olá    mundo" }];
  assert.deepEqual(buscarNosCapitulos(capitulos, "ola  mundo"), [
    { chapterIndex: 0, chapterName: "Um", count: 1 }
  ]);
});

test("índices das ocorrências no texto normalizado seguem a ordem", () => {
  const indices = obterIndicesOcorrencias("ab ab ab", "ab");
  assert.deepEqual(indices, [0, 3, 6]);
  assert.deepEqual(obterIndicesOcorrencias("sem termo", "x"), []);
});