import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const raiz = path.resolve(import.meta.dirname, "../");
const app = fs.readFileSync(path.join(raiz, "src/UI/Web/app.ts"), "utf8");
const styles = fs.readFileSync(path.join(raiz, "public/styles.css"), "utf8");

test("contador absoluto de progresso aparece no subtítulo do leitor", () => {
  assert.match(app, /data-reader-absolute-progress/);
  assert.match(app, /renderContadorAbsoluto\(content, safePage\)/);
  assert.match(app, /Capítulo \$\{atual\}\/\$\{total\}/);
  assert.match(app, /Página \$\{obterPaginaAtualPdf\(\)\}\/\$\{obterTotalPaginasPdf\(\)\}/);
});

test("botão de busca EPUB existe, recolhido e com aria-expanded", () => {
  assert.match(app, /data-reader-action="epub-search"/);
  assert.match(app, /aria-expanded="false"/);
});

test("painel de busca EPUB fica oculto por padrão (hidden) com todos os controles", () => {
  const inicio = app.indexOf('<form class="reader-epub-search"');
  const fim = app.indexOf("</form>", inicio);
  const trecho = app.slice(inicio, fim);
  assert.ok(inicio >= 0 && fim > inicio, "form de busca EPUB não encontrado");
  assert.match(trecho, /hidden/);
  assert.match(trecho, /data-epub-search-input/);
  assert.match(trecho, /data-epub-search-previous/);
  assert.match(trecho, /data-epub-search-next/);
  assert.match(trecho, /data-epub-search-close/);
  assert.match(trecho, /data-epub-search-status/);
});

test("leitor aplica classe RTL e inverte a direção do slider quando rtl", () => {
  assert.match(app, /\$\{isRtl \? "reader-rtl" : ""\}/);
  assert.match(app, /reader-slider-inner" \$\{direction === "rtl"/);
});

test("marcador PDF alterna ícone preenchido/vazado conforme estado", () => {
  assert.match(app, /function renderIconeMarcadorPdf\(marcado: boolean\)/);
  assert.match(app, /\$\{marcado \? "currentColor" : "none"\}/);
  assert.match(app, /icone\.innerHTML = renderIconeMarcadorPdf\(marcado\)/);
});

test("leitor de PDF oferece impressão no menu lateral direito", () => {
  assert.match(app, /class="reader-pdf-print-button" data-reader-action="pdf-print"/);
  assert.match(app, /case "pdf-print":\s*imprimirPdfAberto\(\);/);
  assert.match(app, /function imprimirPdfAberto\(\)/);
  assert.match(app, /\.reader-pdf\[data-pdf-url\]/);
  assert.match(app, /new URL\("\/pdf-print\.html"/);
  assert.match(app, /window\.open\(destino\.href, "_blank"\)/);
  assert.match(styles, /\.reader-pdf-print-frame/);
});

test("CSS: busca EPUB ocultável, RTL inverte zonas e vertical tem dicas", () => {
  assert.match(styles, /\.reader-epub-search\[hidden\][\s\S]*display: none;/);
  assert.match(styles, /\.reader-rtl\.reader \.reader-pagination\.horizontal \.zone\.prev[\s\S]*right: 0;/);
  assert.match(styles, /\.reader-rtl\.reader \.reader-pagination\.horizontal \.zone\.next[\s\S]*left: 0;/);
  assert.match(styles, /\.reader-rtl\.reader/);
  assert.match(styles, /content: "▼ Página seguinte"/);
  assert.match(styles, /content: "▲ Página anterior"/);
});


test("backend serve busca EPUB e propaga direção na rota de capítulo", () => {
  const server = fs.readFileSync(path.join(raiz, "src/server/index.ts"), "utf8");
  assert.match(server, /searchEpubText/);
  assert.match(server, /epub-search/);
  assert.match(server, /direction"\) === "rtl" \? "rtl" : "ltr"/);
});

test("assets alteráveis possuem cache-bust explícito no index e nos módulos PDF", () => {
  assert.match(app, /reader-keyboard\.js\?v=[^"\s]+/);
  assert.match(app, /pdf-viewer\.js\?v=[^"\s]+/);
  const publicIndex = fs.readFileSync(path.join(raiz, "public/index.html"), "utf8");
  assert.match(publicIndex, /\/styles\.css\?v=[^"\s]+/);
  assert.match(publicIndex, /\/UI\/Web\/app\.js\?v=[^"\s]+/);
});

test("iframes EPUB interceptam setas horizontais e desviam para navegação do leitor", () => {
  // O listener de keydown dentro do iframe deve usar o resolvedor de teclas do
  // EPUB com o guard de alvo protegido e executar a ação de navegação.
  assert.match(app, /resolverTeclaEpubIframe/);
  assert.match(app, /alvoEditavelPdf\(event\.target\)/);
  assert.match(app, /executarAtalhoLeitor\(acao\)/);
  // Não deve roubar ArrowUp/Down: a rolagem vertical dentro do capítulo permanece.
  assert.doesNotMatch(app, /resolverTeclaEpubIframe\(\s*\{\s*key: event\.key[\s\S]*ArrowUp/s);
});
