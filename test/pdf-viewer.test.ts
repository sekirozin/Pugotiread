import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { calcularPaginaRelativaPdf, ControladorPaginaPdf, limitarNumeroPagina, MAX_CANVASES_PDF, MAX_RENDERIZACOES_PDF, resolverCliquePalcoLeitor } from "../src/UI/Web/pdf-viewer.js";

const raiz = path.resolve(import.meta.dirname, "../");
const viewer = fs.readFileSync(path.join(raiz, "src/UI/Web/pdf-viewer.ts"), "utf8");
const app = fs.readFileSync(path.join(raiz, "src/UI/Web/app.ts"), "utf8");

test("viewer PDF inicializa PDF.js, worker versionado e renderiza a primeira página", () => {
  assert.match(app, /pdf-viewer\.js\?v=[\w-]+/);
  assert.match(viewer, /getDocument\(\{ url, rangeChunkSize:/);
  assert.match(viewer, /GlobalWorkerOptions\.workerSrc = "\/pdfjs\/pdf\.worker\.mjs\?v=reader-epub-arrows-20260902-v12"/);
  assert.match(viewer, /agendarRenderizacao\(paginaRestaurada, false, true\)/);
  assert.match(viewer, /canvas\.getContext\("2d"\)/);
  assert.match(viewer, /pagina\.render\(\{ canvasContext: contexto, viewport \}\)/);
  assert.match(app, /data-pdf-pages/);
  assert.match(app, /data-pdf-status/);
});

test("contrato de navegação numérica valida e limita a página", () => {
  assert.equal(limitarNumeroPagina(0, 370), 1);
  assert.equal(limitarNumeroPagina(287.9, 370), 287);
  assert.equal(limitarNumeroPagina(999, 370), 370);
  assert.equal(limitarNumeroPagina(Number.NaN, 370), 1);
  assert.match(app, /data-pdf-page-form/);
  assert.match(app, /navegarParaPaginaPdf\(Number\(campo\.value\)\)/);
});

test("navegação PDF avança e recua uma página respeitando os limites", () => {
  assert.equal(calcularPaginaRelativaPdf(10, 1, 370), 11);
  assert.equal(calcularPaginaRelativaPdf(10, -1, 370), 9);
  assert.equal(calcularPaginaRelativaPdf(370, 1, 370), 370);
  assert.equal(calcularPaginaRelativaPdf(1, -1, 370), 1);
});

test("estado autoritativo progride em Right x5 e Space x5 a partir de página diferente de 1", () => {
  const controlador = new ControladorPaginaPdf();
  controlador.reiniciar(100, 20);
  for (let indice = 0; indice < 5; indice += 1) controlador.navegarRelativo(1, indice);
  assert.equal(controlador.obterPaginaAtual(), 25);
  for (let indice = 5; indice < 10; indice += 1) controlador.navegarRelativo(1, indice);
  assert.equal(controlador.obterPaginaAtual(), 30);
});

test("ações rápidas mistas usam sempre o alvo síncrono mais recente", () => {
  const controlador = new ControladorPaginaPdf();
  controlador.reiniciar(100, 40);
  const paginas = ([1, 1, -1, 1, -1, -1, 1] as Array<-1 | 1>)
    .map((delta, indice) => controlador.navegarRelativo(delta, 100 + indice));
  assert.deepEqual(paginas, [41, 42, 41, 42, 41, 40, 41]);
});

test("callback antigo do observer não regride navegação programática", () => {
  const controlador = new ControladorPaginaPdf();
  controlador.reiniciar(100, 20);
  controlador.navegarRelativo(1, 200);
  assert.equal(controlador.registrarObservacoes([
    { numero: 1, razao: 1, visivel: true, instante: 199 }
  ]), 21);
  assert.equal(controlador.registrarObservacoes([
    { numero: 20, razao: 1, visivel: true, instante: 201 }
  ]), 21);
  assert.equal(controlador.registrarObservacoes([
    { numero: 21, razao: 1, visivel: true, instante: 202 }
  ]), 21);
  assert.equal(controlador.registrarObservacoes([
    { numero: 22, razao: 0.8, visivel: true, instante: 203 },
    { numero: 21, razao: 0.2, visivel: true, instante: 203 }
  ]), 22);
  assert.equal(controlador.navegarRelativo(1, 204), 23);
});

test("sequências repetidas permanecem nos limites do documento", () => {
  const controlador = new ControladorPaginaPdf();
  controlador.reiniciar(3, 2);
  assert.deepEqual([controlador.navegarRelativo(1, 1), controlador.navegarRelativo(1, 2)], [3, 3]);
  assert.deepEqual([
    controlador.navegarRelativo(-1, 3),
    controlador.navegarRelativo(-1, 4),
    controlador.navegarRelativo(-1, 5)
  ], [2, 1, 1]);
});

test("renderização PDF tem concorrência e canvases limitados sem resize de todas as páginas", () => {
  assert.equal(MAX_RENDERIZACOES_PDF, 2);
  assert.equal(MAX_CANVASES_PDF, 10);
  const blocoResize = viewer.slice(viewer.indexOf("observadorResize ="), viewer.indexOf("observadorResize.observe"));
  assert.match(blocoResize, /aplicarZoomPdf\(escalaZoomPdf, obterPaginaAtualPdf\(\)\)/);
  assert.doesNotMatch(blocoResize, /querySelectorAll/);
  assert.match(viewer, /removerCanvas\(numero\)/);
  assert.match(viewer, /rootMargin: "1200px 0px"/);
});

test("pesquisa começa oculta, é sob demanda e possui regra hidden explícita", () => {
  const styles = fs.readFileSync(path.join(raiz, "public/styles.css"), "utf8");
  assert.match(app, /data-pdf-search hidden role="search"/);
  assert.match(styles, /\.reader-pdf-search\[hidden\] \{ display: none; \}/);
  const abertura = viewer.slice(viewer.indexOf("export async function iniciarLeitorPdf"), viewer.indexOf("function encerrarRecursos"));
  assert.doesNotMatch(abertura, /getTextContent/);
  assert.match(viewer, /cacheTexto/);
  assert.match(viewer, /tokenPesquisa/);
});

test("toolbar PDF é compacta, acessível e usa ícones Tabler com stroke 1.5", () => {
  assert.match(app, /class="reader-pdf-toolbar" aria-label="Controles do PDF"/);
  assert.match(app, /data-pdf-page-input type="number"/);
  assert.match(app, /stroke-width="1\.5"/);
  assert.doesNotMatch(app, /reader-pdf-fullscreen-label/);
});

test("hotkeys usam matriz testável, protegem controles e navegam no PDF sem remontá-lo", () => {
  assert.match(app, /resolverAtalhoLeitor\(event/);
  assert.match(viewer, /input, textarea, select, button/);
  assert.match(app, /if \(leitorPdf\) navegarRelativoPdf\(1\)/);
  assert.match(app, /case "page-next":[\s\S]*includes\("pdf"\)\) navegarRelativoPdf\(1\)/);
  assert.match(app, /if \(leitorPdf\) renderReaderOverlay\(\); else renderShell\(\);/);
});

test("clique no canvas ou palco PDF mantém página 100 e a mesma geração do documento", () => {
  const estado = { pagina: 100, geracaoViewer: 27, alternancias: 0, cliquesToolbar: 0 };
  const processar = (dentroPalco: boolean, dentroInterface = false) => {
    const acao = resolverCliquePalcoLeitor({ leitorPdf: true, dentroPalco, dentroInterface });
    if (acao === "alternar-controles") estado.alternancias += 1;
  };

  processar(true); // canvas/página
  processar(true); // fundo rolável do stage
  processar(false, true); // toolbar continua fora da decisão do stage
  estado.cliquesToolbar += 1;

  assert.deepEqual(estado, { pagina: 100, geracaoViewer: 27, alternancias: 0, cliquesToolbar: 1 });
  assert.equal(resolverCliquePalcoLeitor({ leitorPdf: false, dentroPalco: true, dentroInterface: false }), "alternar-controles");

  const inicio = app.indexOf("const acaoClique = resolverCliquePalcoLeitor");
  const fim = app.indexOf("const action = target.dataset.readerAction", inicio);
  const integracao = app.slice(inicio, fim);
  assert.ok(inicio >= 0 && fim > inicio, "integração delegada do clique não encontrada");
  assert.match(integracao, /leitorPdf: state\.reader\.content\.pageTypes\.includes\("pdf"\)/);
  assert.doesNotMatch(integracao, /setReaderPage|iniciarLeitorPdf|renderReaderOverlay/);

  const delegacao = app.slice(app.indexOf("function bindReaderDelegatedEvents"), app.indexOf("async function handleReaderBookmark"));
  assert.match(delegacao, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);/);
  assert.match(delegacao, /case "pdf-search":\s*abrirPesquisaPdf\(\);/);
  assert.match(app, /\[data-pdf-page-form\][\s\S]*navegarParaPaginaPdf\(Number\(campo\.value\)\)/);
});

test("assets PDF.js e worker estão presentes e não são HTML de fallback", () => {
  for (const nome of ["pdf.mjs", "pdf.worker.mjs"]) {
    const arquivo = path.join(raiz, "public/pdfjs", nome);
    assert.ok(fs.existsSync(arquivo), `asset ausente: ${nome}`);
    const conteudo = fs.readFileSync(arquivo, "utf8");
    assert.ok(conteudo.length > 100_000, `${nome} parece truncado`);
    assert.doesNotMatch(conteudo.slice(0, 500), /<html/i, `${nome} é HTML`);
  }
});

test("zoom PDF sem reinicialização do documento (app.ts e pdf-viewer.ts)", () => {
  const startFuncao = app.indexOf("function setReaderZoom");
  const inicioRamoPdf = app.indexOf('pageTypes.includes("pdf")) {', startFuncao);
  const fimRamoPdf = app.indexOf("return;\n  }\n\n  renderShell();", inicioRamoPdf);
  const ramoPdf = app.slice(inicioRamoPdf, fimRamoPdf > inicioRamoPdf ? fimRamoPdf : app.length);
  assert.match(ramoPdf, /aplicarZoomPdf\(state\.reader\.zoom \/ 100, obterPaginaAtualPdf\(\)\)/);
  assert.doesNotMatch(ramoPdf, /renderShell\(\)|iniciarLeitorPdf\(\)/);
  const aplicacao = viewer.slice(viewer.indexOf("export function aplicarZoomPdf"), viewer.indexOf("export function obterZoomPdf"));
  assert.match(aplicacao, /escalaZoomPdf/);
  assert.match(aplicacao, /renderizarNovoLayoutPdf\(\)/);
  assert.doesNotMatch(aplicacao, /iniciarLeitorPdf|iniciarDocumento|abrirDocumento/);
  assert.match(viewer, /LIMITE_ESCALA_ZOOM_PDF = 2\.5/);
  assert.match(viewer, /escalaZoomPdf = 1/);
});

test("resolverCliquePalcoLeitor alterna overlays apenas na área externa do documento PDF", () => {
  assert.equal(resolverCliquePalcoLeitor({ leitorPdf: true, dentroPalco: true, dentroInterface: false }), "ignorar");
  assert.equal(resolverCliquePalcoLeitor({ leitorPdf: true, dentroPalco: false, dentroInterface: false }), "alternar-controles");
  assert.equal(resolverCliquePalcoLeitor({ leitorPdf: true, dentroPalco: false, dentroInterface: true }), "ignorar");
});

test("pesquisa PDF cria camada de marca-texto sobre os itens de texto encontrados", () => {
  assert.match(viewer, /highlightWords\(camada.textDivs, texto.items, termoDestaque\)/);
  assert.match(viewer, /new moduloPdfAtual.TextLayer/);
  assert.match(viewer, /pdf-text-layer/);
  assert.match(viewer, /termoDestaque/);
  const styles = fs.readFileSync(path.join(raiz, "public/styles.css"), "utf8");
  assert.match(styles, /\.pdf-text-match/);
});

test("fechar pesquisa limpa marca-textos, resultados e destaque das páginas", () => {
  assert.match(viewer, /function limparDestaquesPesquisa/);
  assert.match(viewer, /pdf-text-highlights.*remove/);
  assert.match(viewer, /is-search-result.*remove/);
  assert.match(viewer, /limparDestaquesPesquisa\(\)/);
});
