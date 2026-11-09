import test from "node:test";
import assert from "node:assert/strict";
import { resolverAtalhoLeitor, resolverTeclaEpubIframe, type ContextoAtalhoLeitor, type TeclaAtalho } from "../src/UI/Web/reader-keyboard.js";

const contextoBase: ContextoAtalhoLeitor = {
  leitorAtivo: true, leitorPdf: false, leitorEpub: false, modoVerticalContinuo: false, direcaoLeitura: "ltr",
  alvoProtegido: false, pesquisaPdfAberta: false, pesquisaEpubAberta: false, telaCheia: false, telaCheiaDisponivel: true, controlesVisiveis: false,
};
const resolver = (tecla: TeclaAtalho, contexto: Partial<ContextoAtalhoLeitor> = {}) =>
  resolverAtalhoLeitor(tecla, { ...contextoBase, ...contexto });

test("setas horizontais respeitam LTR e RTL", () => {
  assert.equal(resolver({ key: "ArrowRight" }), "proxima-pagina");
  assert.equal(resolver({ key: "ArrowLeft" }), "pagina-anterior");
  assert.equal(resolver({ key: "ArrowRight" }, { direcaoLeitura: "rtl" }), "pagina-anterior");
  assert.equal(resolver({ key: "ArrowLeft" }, { direcaoLeitura: "rtl" }), "proxima-pagina");
});

test("Space, PageUp, PageDown, Home e End formam navegação coerente", () => {
  assert.equal(resolver({ key: " " }), "proxima-pagina");
  assert.equal(resolver({ key: " ", shiftKey: true }), "pagina-anterior");
  assert.equal(resolver({ key: "PageUp" }), "pagina-anterior");
  assert.equal(resolver({ key: "PageDown" }), "proxima-pagina");
  assert.equal(resolver({ key: "Home" }), "primeira-pagina");
  assert.equal(resolver({ key: "End" }), "ultima-pagina");
});

test("alvos editáveis e botões bloqueiam leitura; setas verticais vão aos extremos da página", () => {
  assert.equal(resolver({ key: "ArrowRight" }, { alvoProtegido: true }), null);
  assert.equal(resolver({ key: " " }, { alvoProtegido: true }), null);
  assert.equal(resolver({ key: "ArrowUp" }, { modoVerticalContinuo: true }), "topo-pagina");
  assert.equal(resolver({ key: "ArrowDown" }, { modoVerticalContinuo: true }), "fim-pagina");
});

test("PDF captura / e Ctrl/Cmd+F somente quando ativo", () => {
  assert.equal(resolver({ key: "/" }, { leitorPdf: true }), "abrir-pesquisa-pdf");
  assert.equal(resolver({ key: "f", ctrlKey: true }, { leitorPdf: true }), "abrir-pesquisa-pdf");
  assert.equal(resolver({ key: "f", metaKey: true }, { leitorPdf: true }), "abrir-pesquisa-pdf");
  assert.equal(resolver({ key: "f", ctrlKey: true }), null);
});

test("F alterna fullscreen apenas quando a API está disponível", () => {
  assert.equal(resolver({ key: "f" }), "alternar-tela-cheia");
  assert.equal(resolver({ key: "f" }, { telaCheiaDisponivel: false }), null);
});

test("Escape prioriza pesquisa, fullscreen, controles e só então leitor", () => {
  assert.equal(resolver({ key: "Escape" }, { leitorPdf: true, pesquisaPdfAberta: true, telaCheia: true, controlesVisiveis: true }), "fechar-pesquisa-pdf");
  assert.equal(resolver({ key: "Escape" }, { telaCheia: true, controlesVisiveis: true }), "sair-tela-cheia");
  assert.equal(resolver({ key: "Escape" }, { controlesVisiveis: true }), "fechar-controles");
  assert.equal(resolver({ key: "Escape" }), "fechar-leitor");
  assert.equal(resolver({ key: "Escape" }, { alvoProtegido: true, controlesVisiveis: true }), "fechar-controles");
});

test("EPUB captura / e Ctrl/Cmd+F para a pesquisa no livro", () => {
  assert.equal(resolver({ key: "/" }, { leitorEpub: true }), "abrir-pesquisa-epub");
  assert.equal(resolver({ key: "f", ctrlKey: true }, { leitorEpub: true }), "abrir-pesquisa-epub");
  assert.equal(resolver({ key: "f", metaKey: true }, { leitorEpub: true }), "abrir-pesquisa-epub");
  assert.equal(resolver({ key: "/" }), null);
});

test("Escape fecha a pesquisa do EPUB antes de fechar controles ou o leitor", () => {
  assert.equal(resolver({ key: "Escape" }, { leitorEpub: true, pesquisaEpubAberta: true, telaCheia: true, controlesVisiveis: true }), "fechar-pesquisa-epub");
});

test("C alterna os controles no leitor", () => {
  assert.equal(resolver({ key: "c" }), "alternar-controles");
  assert.equal(resolver({ key: "c" }, { leitorPdf: true }), "alternar-controles");
  assert.equal(resolver({ key: "C" }), "alternar-controles");
});

// ---------------------------------------------------------------------------
// resolução de teclas dentro do iframe do EPUB
// ---------------------------------------------------------------------------

test("EPUB: setas horizontais no iframe navegam LTR e RTL", () => {
  // LTR: ArrowRight = próxima página; ArrowLeft = página anterior.
  assert.equal(resolverTeclaEpubIframe({ key: "ArrowRight", alvoProtegido: false }, "ltr"), "proxima-pagina");
  assert.equal(resolverTeclaEpubIframe({ key: "ArrowLeft", alvoProtegido: false }, "ltr"), "pagina-anterior");
  // RTL inverte a direção das setas.
  assert.equal(resolverTeclaEpubIframe({ key: "ArrowRight", alvoProtegido: false }, "rtl"), "pagina-anterior");
  assert.equal(resolverTeclaEpubIframe({ key: "ArrowLeft", alvoProtegido: false }, "rtl"), "proxima-pagina");
});

test("EPUB: setas no iframe não são interceptadas em alvos protegidos", () => {
  assert.equal(resolverTeclaEpubIframe({ key: "ArrowRight", alvoProtegido: true }, "ltr"), null);
  assert.equal(resolverTeclaEpubIframe({ key: "ArrowLeft", alvoProtegido: true }, "rtl"), null);
});

test("EPUB: setas no iframe respeitam modificadores (Ctrl/Cmd/Alt)", () => {
  assert.equal(resolverTeclaEpubIframe({ key: "ArrowRight", ctrlKey: true, alvoProtegido: false }, "ltr"), null);
  assert.equal(resolverTeclaEpubIframe({ key: "ArrowLeft", metaKey: true, alvoProtegido: false }, "ltr"), null);
  assert.equal(resolverTeclaEpubIframe({ key: "ArrowRight", altKey: true, alvoProtegido: false }, "rtl"), null);
});

test("EPUB: setas, espaço e PageDown navegam dentro do iframe sem perder o capítulo", () => {
  assert.equal(resolverTeclaEpubIframe({ key: "ArrowUp", alvoProtegido: false }, "ltr"), "topo-pagina");
  assert.equal(resolverTeclaEpubIframe({ key: "ArrowDown", alvoProtegido: false }, "rtl"), "fim-pagina");
  assert.equal(resolverTeclaEpubIframe({ key: " ", alvoProtegido: false }, "ltr"), "proxima-pagina");
  assert.equal(resolverTeclaEpubIframe({ key: "PageDown", alvoProtegido: false }, "ltr"), "proxima-pagina");
  assert.equal(resolverTeclaEpubIframe({ key: "PageUp", alvoProtegido: false }, "ltr"), "pagina-anterior");
  assert.equal(resolverTeclaEpubIframe({ key: "Home", alvoProtegido: false }, "ltr"), "topo-pagina");
  assert.equal(resolverTeclaEpubIframe({ key: "End", alvoProtegido: false }, "ltr"), "fim-pagina");
  assert.equal(resolverTeclaEpubIframe({ key: "Escape", alvoProtegido: false }, "ltr"), null);
});
