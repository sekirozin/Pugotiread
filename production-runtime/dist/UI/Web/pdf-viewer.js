import { readerBudget, deviceHints, canvasSize } from "./reader-budget.js";
// @ts-ignore Versioned runtime module for browser and desktop caches.
import { PdfFormEditor } from "./pdf-form.js?v=rpg-personal-20260923";
// @ts-ignore Runtime URL versions invalidate immutable browser/app caches.
import { indexText, findWords, highlightWords } from "./pdf-text-search.js?v=pdf-reader-verified-20260907-r1";
// @ts-ignore Runtime URL versions invalidate immutable browser/app caches.
import { PdfOutline } from "./pdf-outline.js?v=pdf-reader-verified-20260907-r1";
const budget = readerBudget(deviceHints());
export const MAX_RENDERIZACOES_PDF = budget.pdfConcurrency;
export const MAX_CANVASES_PDF = budget.pdfCanvases;
let documentoAtual = null;
let observadorProximidade = null;
let observadorVisibilidade = null;
let observadorResize = null;
let observadorControles = null;
let observadorEdicaoFormulario = null;
let temporizadorResize = null;
let resultados = [];
let indiceResultado = -1;
let paginaResultadoAtual = null;
let tokenLeitor = 0;
let tokenPesquisa = 0;
let renderizacoesAtivas = 0;
const filaRenderizacao = [];
const trabalhosPendentes = new Map();
const tarefasAtivas = new Map();
const paginasProximas = new Set();
const ultimoUsoCanvas = new Map();
const cacheTexto = new Map();
const cacheItensTexto = new Map();
const destaquesPorPagina = new Map();
let termoDestaque = "";
let moduloPdfAtual = null;
let sumarioPdf = null;
let formularioPdf = null;
const camadasTexto = new Map();
let escalaZoomPdf = 1;
let revisaoLayout = 0;
let temporizadorZoom = null;
let gestosPdf = null;
export const LIMITE_ESCALA_ZOOM_PDF = 2.5;
export class ControladorPaginaPdf {
    paginaAtual = 1;
    totalPaginas = 1;
    paginaProgramatica = null;
    instanteNavegacaoProgramatica = Number.NEGATIVE_INFINITY;
    visibilidadePaginas = new Map();
    reiniciar(total, pagina = 1) {
        this.totalPaginas = Math.max(1, Math.trunc(total));
        this.paginaAtual = limitarNumeroPagina(pagina, this.totalPaginas);
        this.paginaProgramatica = null;
        this.instanteNavegacaoProgramatica = Number.NEGATIVE_INFINITY;
        this.visibilidadePaginas.clear();
        return this.paginaAtual;
    }
    obterPaginaAtual() {
        return this.paginaAtual;
    }
    obterTotalPaginas() {
        return this.totalPaginas;
    }
    navegarPara(valor, instante = performance.now()) {
        const pagina = limitarNumeroPagina(valor, this.totalPaginas);
        this.paginaAtual = pagina;
        this.paginaProgramatica = pagina;
        this.instanteNavegacaoProgramatica = instante;
        this.visibilidadePaginas.clear();
        return pagina;
    }
    navegarRelativo(delta, instante = performance.now()) {
        return this.navegarPara(calcularPaginaRelativaPdf(this.paginaAtual, delta, this.totalPaginas), instante);
    }
    registrarObservacoes(observacoes) {
        const paginaProtegida = this.paginaProgramatica;
        for (const observacao of observacoes) {
            if (observacao.instante < this.instanteNavegacaoProgramatica)
                continue;
            if (paginaProtegida !== null && observacao.numero !== paginaProtegida)
                continue;
            if (observacao.visivel)
                this.visibilidadePaginas.set(observacao.numero, observacao.razao);
            else
                this.visibilidadePaginas.delete(observacao.numero);
        }
        if (paginaProtegida !== null) {
            if ((this.visibilidadePaginas.get(paginaProtegida) ?? 0) > 0) {
                this.paginaAtual = paginaProtegida;
                this.paginaProgramatica = null;
            }
            return this.paginaAtual;
        }
        let melhorNumero = this.paginaAtual;
        let melhorRazao = -1;
        for (const [numero, razao] of this.visibilidadePaginas) {
            if (razao > melhorRazao) {
                melhorRazao = razao;
                melhorNumero = numero;
            }
        }
        this.paginaAtual = limitarNumeroPagina(melhorNumero, this.totalPaginas);
        return this.paginaAtual;
    }
}
const controladorPagina = new ControladorPaginaPdf();
let ultimaPaginaNotificada = 0;
function obterArea() {
    return document.querySelector("[data-pdf-pages]");
}
function obterPalco() {
    return document.getElementById("reader-stage");
}
function atualizarStatusDocumento(mensagem, ocultar = false) {
    const status = document.querySelector("[data-pdf-status]");
    if (!status)
        return;
    status.textContent = mensagem;
    status.hidden = ocultar;
}
function atualizarStatusPesquisa(mensagem) {
    const status = document.querySelector("[data-pdf-search-status]");
    if (status)
        status.textContent = mensagem;
}
function obterPalavra() {
    return document.querySelector("[data-pdf-search-input]")?.value.trim() ?? "";
}
function normalizar(texto) {
    return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
}
function contarOcorrencias(texto, termo) {
    let total = 0;
    let inicio = 0;
    while (termo && inicio < texto.length) {
        const indice = texto.indexOf(termo, inicio);
        if (indice < 0)
            break;
        total += 1;
        inicio = indice + termo.length;
    }
    return total;
}
export function limitarNumeroPagina(valor, total) {
    if (!Number.isFinite(valor))
        return 1;
    return Math.min(Math.max(Math.trunc(valor), 1), Math.max(1, Math.trunc(total)));
}
export function calcularPaginaRelativaPdf(atual, delta, total) {
    return limitarNumeroPagina(atual + delta, total);
}
export function resolverCliquePalcoLeitor(contexto) {
    // Cliques em interfaces (toolbar, pesquisas, overlays) nunca alternam controles.
    if (contexto.dentroInterface)
        return "ignorar";
    if (contexto.leitorPdf) {
        // PDF: preserva cliques do documento (seleção de texto/anotações futuras).
        // Permite alternar os overlays apenas ao clicar na área vazia externa ao
        // documento (fora do palco). A tecla C também alterna os controles.
        return contexto.dentroPalco ? "ignorar" : "alternar-controles";
    }
    if (!contexto.dentroPalco)
        return "ignorar";
    return "alternar-controles";
}
export function alvoEditavelPdf(alvo) {
    return alvo instanceof HTMLElement && Boolean(alvo.closest("input, textarea, select, button, [contenteditable]:not([contenteditable=\"false\"])"));
}
export function obterPaginaAtualPdf() {
    return controladorPagina.obterPaginaAtual();
}
export function obterTotalPaginasPdf() {
    return controladorPagina.obterTotalPaginas();
}
function atualizarCampoPagina(numero) {
    const campo = document.querySelector("[data-pdf-page-input]");
    if (campo && document.activeElement !== campo)
        campo.value = String(numero);
    if (numero !== ultimaPaginaNotificada) {
        ultimaPaginaNotificada = numero;
        window.dispatchEvent(new CustomEvent("pugotiread:pdf-page-change", { detail: { page: numero } }));
    }
}
function atualizarTotalPaginas(total) {
    const totalElemento = document.querySelector("[data-pdf-page-total]");
    const campo = document.querySelector("[data-pdf-page-input]");
    if (totalElemento)
        totalElemento.textContent = `/ ${total}`;
    if (campo) {
        campo.max = String(total);
        campo.disabled = false;
    }
}
function cancelarRenderizacao(numero) {
    tarefasAtivas.get(numero)?.cancel();
    tarefasAtivas.delete(numero);
    trabalhosPendentes.delete(numero);
    const indice = filaRenderizacao.findIndex((trabalho) => trabalho.numero === numero);
    if (indice >= 0)
        filaRenderizacao.splice(indice, 1);
}
function removerCanvas(numero) {
    const pagina = obterArea()?.querySelector(`[data-pdf-page="${numero}"]`);
    if (!pagina)
        return;
    cancelarRenderizacao(numero);
    camadasTexto.get(numero)?.cancel();
    camadasTexto.delete(numero);
    // Explicitly release the backing bitmap instead of waiting for GC.
    for (const canvas of Array.from(pagina.querySelectorAll("canvas"))) {
        canvas.width = 0;
        canvas.height = 0;
    }
    pagina.replaceChildren();
    pagina.dataset.renderizada = "false";
    ultimoUsoCanvas.delete(numero);
}
function limitarCanvases() {
    const area = obterArea();
    if (!area)
        return;
    const canvases = Array.from(area.querySelectorAll(".pdf-page[data-renderizada=\"true\"]"));
    if (canvases.length <= MAX_CANVASES_PDF)
        return;
    canvases
        .map((elemento) => ({ elemento, numero: Number(elemento.dataset.pdfPage), uso: ultimoUsoCanvas.get(Number(elemento.dataset.pdfPage)) ?? 0 }))
        .filter(({ numero }) => numero !== controladorPagina.obterPaginaAtual())
        .sort((a, b) => a.uso - b.uso)
        .slice(0, canvases.length - MAX_CANVASES_PDF)
        .forEach(({ numero }) => removerCanvas(numero));
}
async function executarRenderizacao(trabalho) {
    const area = obterArea();
    const documento = documentoAtual;
    if (!area || !documento || (trabalho.geracao !== tokenLeitor || trabalho.revisao !== revisaoLayout))
        return;
    const paginaElemento = area.querySelector(`[data-pdf-page="${trabalho.numero}"]`);
    if (!paginaElemento || (paginaElemento.dataset.renderizada === "true" && !trabalho.forcar)) {
        ultimoUsoCanvas.set(trabalho.numero, performance.now());
        return;
    }
    const pagina = await documento.getPage(trabalho.numero);
    if ((trabalho.geracao !== tokenLeitor || trabalho.revisao !== revisaoLayout) || documento !== documentoAtual)
        return;
    const viewportBase = pagina.getViewport({ scale: 1 });
    paginaElemento.style.aspectRatio = `${viewportBase.width} / ${viewportBase.height}`;
    const larguraDisponivel = paginaElemento.clientWidth;
    const escala = larguraDisponivel / viewportBase.width;
    const viewport = pagina.getViewport({ scale: escala });
    // Limita memória por canvas mesmo com zoom alto e tela de alta densidade.
    const tamanho = canvasSize(viewport.width, viewport.height, window.devicePixelRatio || 1, budget.pdfPixels);
    const densidade = tamanho.scale;
    const canvas = document.createElement("canvas");
    canvas.width = tamanho.width;
    canvas.height = tamanho.height;
    canvas.style.width = "100%";
    canvas.style.height = `${Math.ceil(viewport.height)}px`;
    const contexto = canvas.getContext("2d");
    if (!contexto)
        return;
    contexto.setTransform(densidade, 0, 0, densidade, 0, 0);
    const tarefa = pagina.render({ canvasContext: contexto, viewport });
    tarefasAtivas.set(trabalho.numero, tarefa);
    try {
        await tarefa.promise;
    }
    catch (erro) {
        if (trabalho.geracao === tokenLeitor && erro?.name !== "RenderingCancelledException")
            throw erro;
        return;
    }
    finally {
        if (tarefasAtivas.get(trabalho.numero) === tarefa)
            tarefasAtivas.delete(trabalho.numero);
    }
    if ((trabalho.geracao !== tokenLeitor || trabalho.revisao !== revisaoLayout) || documento !== documentoAtual || !paginaElemento.isConnected)
        return;
    formularioPdf?.beforeRender(paginaElemento);
    paginaElemento.replaceChildren(canvas);
    if (moduloPdfAtual?.TextLayer) {
        try {
            const texto = await pagina.getTextContent();
            if (trabalho.geracao !== tokenLeitor || trabalho.revisao !== revisaoLayout || !paginaElemento.contains(canvas))
                return;
            const camadaTexto = document.createElement("div");
            camadaTexto.className = "pdf-text-layer";
            camadaTexto.setAttribute("aria-hidden", "true");
            camadaTexto.style.setProperty("--total-scale-factor", String(viewport.scale));
            paginaElemento.append(camadaTexto);
            const camada = new moduloPdfAtual.TextLayer({ textContentSource: texto, container: camadaTexto, viewport });
            const registro = { divs: camada.textDivs, items: texto.items, cancel: () => camada.cancel() };
            camadasTexto.get(trabalho.numero)?.cancel();
            camadasTexto.set(trabalho.numero, registro);
            await camada.render();
            if (trabalho.geracao !== tokenLeitor || trabalho.revisao !== revisaoLayout || !camadaTexto.isConnected)
                return;
            highlightWords(camada.textDivs, texto.items, termoDestaque);
        }
        catch (error) {
            if (error?.name !== "AbortException")
                console.warn("Não foi possível preparar o texto do PDF", error);
        }
    }
    paginaElemento.dataset.renderizada = "true";
    void formularioPdf?.attach(paginaElemento, pagina, viewport).catch(error => console.warn("Campos PDF indisponíveis", error));
    paginaElemento.dataset.larguraRenderizada = String(Math.round(larguraDisponivel));
    ultimoUsoCanvas.set(trabalho.numero, performance.now());
    limitarCanvases();
}
function processarFila() {
    while (renderizacoesAtivas < MAX_RENDERIZACOES_PDF && filaRenderizacao.length > 0) {
        const trabalho = filaRenderizacao.shift();
        if (trabalhosPendentes.get(trabalho.numero) !== trabalho)
            continue;
        trabalhosPendentes.delete(trabalho.numero);
        renderizacoesAtivas += 1;
        void executarRenderizacao(trabalho)
            .catch((erro) => console.error("Falha ao renderizar página do PDF", erro))
            .finally(() => {
            renderizacoesAtivas -= 1;
            processarFila();
        });
    }
}
function agendarRenderizacao(numero, forcar = false, prioridade = false) {
    if (!documentoAtual || numero < 1 || numero > documentoAtual.numPages)
        return;
    const existente = trabalhosPendentes.get(numero);
    if (existente && (!forcar || existente.forcar))
        return;
    if (forcar)
        cancelarRenderizacao(numero);
    const trabalho = { numero, geracao: tokenLeitor, revisao: revisaoLayout, forcar };
    trabalhosPendentes.set(numero, trabalho);
    if (prioridade)
        filaRenderizacao.unshift(trabalho);
    else
        filaRenderizacao.push(trabalho);
    processarFila();
}
export function navegarParaPaginaPdf(valor) {
    const numero = controladorPagina.navegarPara(valor);
    const elemento = obterArea()?.querySelector(`[data-pdf-page="${numero}"]`);
    atualizarCampoPagina(numero);
    agendarRenderizacao(numero, false, true);
    elemento?.scrollIntoView({ block: "start", behavior: "auto" });
    return numero;
}
export function navegarRelativoPdf(delta) {
    const numero = controladorPagina.navegarRelativo(delta);
    const elemento = obterArea()?.querySelector(`[data-pdf-page="${numero}"]`);
    atualizarCampoPagina(numero);
    agendarRenderizacao(numero, false, true);
    elemento?.scrollIntoView({ block: "start", behavior: "auto" });
    return numero;
}
function atualizarLayoutPdf() {
    const area = obterArea();
    const palco = obterPalco();
    if (!area || !palco)
        return;
    const estilo = getComputedStyle(area);
    const padding = parseFloat(estilo.paddingLeft) + parseFloat(estilo.paddingRight);
    const largura = Math.min(1100, Math.max(1, palco.clientWidth - padding)) * escalaZoomPdf;
    area.style.setProperty("--pdf-page-width", `${largura}px`);
    area.style.setProperty("--pdf-area-width", `${Math.max(palco.clientWidth, largura + padding)}px`);
}
function renderizarNovoLayoutPdf() {
    revisaoLayout += 1;
    for (const tarefa of tarefasAtivas.values())
        tarefa.cancel();
    tarefasAtivas.clear();
    filaRenderizacao.length = 0;
    trabalhosPendentes.clear();
    const atual = controladorPagina.obterPaginaAtual();
    agendarRenderizacao(atual, true, true);
    for (const numero of paginasProximas) {
        if (numero !== atual)
            agendarRenderizacao(numero, true);
    }
}
export function aplicarZoomPdf(escala, paginaAtual, ponto) {
    if (!Number.isFinite(escala))
        return;
    const novoZoom = Math.min(LIMITE_ESCALA_ZOOM_PDF, Math.max(0.5, escala));
    const area = obterArea();
    const palco = obterPalco();
    const documento = documentoAtual;
    if (!area || !palco || !documento) {
        escalaZoomPdf = novoZoom;
        return;
    }
    const rectPalco = palco.getBoundingClientRect();
    const foco = ponto ?? { x: rectPalco.left + palco.clientWidth / 2, y: rectPalco.top + palco.clientHeight / 2 };
    const sobFoco = document.elementFromPoint(foco.x, foco.y)?.closest("[data-pdf-page]");
    const atual = limitarNumeroPagina(paginaAtual, documento.numPages);
    const pagina = sobFoco ?? area.querySelector(`[data-pdf-page="${atual}"]`);
    const antes = pagina?.getBoundingClientRect();
    const x = antes ? (foco.x - antes.left) / antes.width : 0;
    const y = antes ? (foco.y - antes.top) / antes.height : 0;
    escalaZoomPdf = novoZoom;
    atualizarLayoutPdf();
    const depois = pagina?.getBoundingClientRect();
    if (depois) {
        palco.scrollLeft += depois.left + x * depois.width - foco.x;
        palco.scrollTop += depois.top + y * depois.height - foco.y;
    }
    // O canvas existente acompanha o gesto imediatamente; redesenhar só após
    // uma pausa evita dezenas de renderizações caras por segundo no celular.
    if (temporizadorZoom)
        clearTimeout(temporizadorZoom);
    temporizadorZoom = setTimeout(() => {
        temporizadorZoom = null;
        renderizarNovoLayoutPdf();
    }, 120);
    window.dispatchEvent(new CustomEvent("pugotiread:pdf-zoom-change", { detail: { zoom: Math.round(novoZoom * 100) } }));
}
function configurarGestosPdf() {
    const palco = obterPalco();
    if (!palco)
        return;
    gestosPdf = new AbortController();
    const opcoes = { passive: false, signal: gestosPdf.signal };
    let pinca = null;
    const distancia = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    palco.addEventListener("touchstart", (evento) => {
        if (evento.touches.length !== 2) {
            pinca = null;
            return;
        }
        const [a, b] = Array.from(evento.touches);
        pinca = { distancia: Math.max(1, distancia(a, b)), zoom: escalaZoomPdf, ids: [a.identifier, b.identifier] };
        evento.preventDefault();
    }, opcoes);
    palco.addEventListener("touchmove", (evento) => {
        if (!pinca || evento.touches.length !== 2)
            return;
        const toques = Array.from(evento.touches);
        const a = toques.find((t) => t.identifier === pinca.ids[0]);
        const b = toques.find((t) => t.identifier === pinca.ids[1]);
        if (!a || !b)
            return;
        evento.preventDefault();
        aplicarZoomPdf(pinca.zoom * distancia(a, b) / pinca.distancia, obterPaginaAtualPdf(), {
            x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2
        });
    }, opcoes);
    const terminar = () => { pinca = null; };
    palco.addEventListener("touchend", terminar, opcoes);
    palco.addEventListener("touchcancel", terminar, opcoes);
}
export function obterZoomPdf() {
    return escalaZoomPdf;
}
function atualizarBotoesPesquisa() {
    document.querySelectorAll("[data-pdf-search-next], [data-pdf-search-previous]").forEach((botao) => {
        botao.disabled = resultados.length === 0;
    });
}
async function irParaResultado(indice) {
    if (resultados.length === 0)
        return;
    indiceResultado = (indice + resultados.length) % resultados.length;
    const resultado = resultados[indiceResultado];
    paginaResultadoAtual = resultado.pagina;
    navegarParaPaginaPdf(resultado.pagina);
    document.querySelectorAll(".pdf-page.is-search-result").forEach((pagina) => pagina.classList.remove("is-search-result"));
    document.querySelector(`[data-pdf-page="${resultado.pagina}"]`)?.classList.add("is-search-result");
    atualizarStatusPesquisa(`${indiceResultado + 1}/${resultados.length} · pág. ${resultado.pagina}`);
}
export function pesquisaPdfAberta() {
    const pesquisa = document.querySelector("[data-pdf-search]");
    return Boolean(pesquisa && !pesquisa.hidden);
}
export function abrirPesquisaPdf() {
    const pesquisa = document.querySelector("[data-pdf-search]");
    const campo = document.querySelector("[data-pdf-search-input]");
    if (!pesquisa || !campo)
        return;
    document.querySelector(".reader-pdf-options")?.removeAttribute("open");
    pesquisa.hidden = false;
    campo.focus();
    campo.select();
}
function limparDestaquesPesquisa() {
    termoDestaque = "";
    resultados = [];
    indiceResultado = -1;
    paginaResultadoAtual = null;
    destaquesPorPagina.clear();
    document.querySelectorAll(".pdf-page.is-search-result").forEach((pagina) => pagina.classList.remove("is-search-result"));
    document.querySelectorAll(".pdf-text-highlights").forEach((camada) => camada.remove());
    for (const layer of camadasTexto.values())
        highlightWords(layer.divs, layer.items, "");
    document.querySelectorAll(".pdf-page.has-text-highlights").forEach((pagina) => pagina.classList.remove("has-text-highlights"));
    atualizarBotoesPesquisa();
    atualizarStatusPesquisa("");
}
export function fecharPesquisaPdf() {
    tokenPesquisa += 1;
    limparDestaquesPesquisa();
    const pesquisa = document.querySelector("[data-pdf-search]");
    if (pesquisa)
        pesquisa.hidden = true;
    document.querySelector("[data-pdf-search-input]")?.blur();
    document.querySelector(".reader-pdf-search-button")?.focus();
}
async function obterTextoPagina(documento, numero, token) {
    const cache = cacheTexto.get(numero);
    if (cache !== undefined)
        return cache;
    const conteudo = await documento.getPage(numero).then((pagina) => pagina.getTextContent());
    if (token !== tokenPesquisa || documento !== documentoAtual)
        return null;
    const texto = indexText(conteudo.items).text;
    cacheTexto.set(numero, texto);
    cacheItensTexto.set(numero, conteudo.items);
    return texto;
}
export async function pesquisarPdf() {
    const documento = documentoAtual;
    const termo = normalizar(obterPalavra());
    const token = ++tokenPesquisa;
    limparDestaquesPesquisa();
    termoDestaque = termo;
    destaquesPorPagina.clear();
    if (!documento || !termo) {
        atualizarStatusPesquisa("Digite um termo.");
        return;
    }
    let proximaPagina = 1;
    let processadas = 0;
    let primeiroResultadoAberto = false;
    atualizarStatusPesquisa(`Buscando 0/${documento.numPages}…`);
    const pesquisar = async () => {
        while (token === tokenPesquisa) {
            const numero = proximaPagina++;
            if (numero > documento.numPages)
                return;
            const texto = await obterTextoPagina(documento, numero, token);
            if (texto === null || token !== tokenPesquisa)
                return;
            const ocorrencias = findWords(texto, termo).length;
            if (ocorrencias > 0) {
                destaquesPorPagina.set(numero, cacheItensTexto.get(numero) ?? []);
                resultados.push({ pagina: numero, ocorrencias });
                resultados.sort((a, b) => a.pagina - b.pagina);
                if (paginaResultadoAtual !== null)
                    indiceResultado = resultados.findIndex((resultado) => resultado.pagina === paginaResultadoAtual);
                atualizarBotoesPesquisa();
                const layer = camadasTexto.get(numero);
                if (layer)
                    highlightWords(layer.divs, layer.items, termo);
                else if (paginasProximas.has(numero))
                    agendarRenderizacao(numero, false, true);
                if (!primeiroResultadoAberto) {
                    primeiroResultadoAberto = true;
                    await irParaResultado(resultados.findIndex((resultado) => resultado.pagina === numero));
                }
            }
            processadas += 1;
            atualizarStatusPesquisa(`${resultados.length} pág. · ${processadas}/${documento.numPages}`);
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    };
    await Promise.all(Array.from({ length: Math.min(2, documento.numPages) }, pesquisar));
    if (token !== tokenPesquisa)
        return;
    if (resultados.length === 0) {
        atualizarStatusPesquisa("Nenhum resultado.");
        return;
    }
    const total = resultados.reduce((soma, resultado) => soma + resultado.ocorrencias, 0);
    atualizarStatusPesquisa(`${total} ocorrência${total === 1 ? "" : "s"} · ${resultados.length} pág.`);
}
export function proximoResultadoPdf(direcao) {
    void irParaResultado(indiceResultado + direcao);
}
function configurarObservadores() {
    const area = obterArea();
    const palco = obterPalco();
    if (!area || !palco)
        return;
    observadorProximidade = new IntersectionObserver((entradas) => {
        for (const entrada of entradas) {
            const numero = Number(entrada.target.dataset.pdfPage);
            if (entrada.isIntersecting) {
                paginasProximas.add(numero);
                agendarRenderizacao(numero);
            }
            else {
                paginasProximas.delete(numero);
                removerCanvas(numero);
            }
        }
    }, { root: palco, rootMargin: `${budget.pdfMargin}px 0px` });
    observadorVisibilidade = new IntersectionObserver((entradas) => {
        const pagina = controladorPagina.registrarObservacoes(entradas.map((entrada) => ({
            numero: Number(entrada.target.dataset.pdfPage),
            razao: entrada.intersectionRatio,
            visivel: entrada.isIntersecting,
            instante: entrada.time
        })));
        atualizarCampoPagina(pagina);
    }, { root: palco, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] });
    area.querySelectorAll("[data-pdf-page]").forEach((pagina) => {
        observadorProximidade?.observe(pagina);
        observadorVisibilidade?.observe(pagina);
    });
    const reader = palco.closest(".reader");
    const toolbar = reader?.querySelector(".reader-pdf-toolbar");
    const pesquisa = reader?.querySelector(".reader-pdf-search");
    const atualizarEspacoControles = () => {
        if (!reader || !toolbar)
            return;
        const topo = reader.getBoundingClientRect().top;
        const editor = reader.querySelector(".pdf-form-panel:not([hidden])");
        if (reader.classList.contains("pdf-form-editing") && editor) {
            const fimEditor = editor.getBoundingClientRect().bottom - topo;
            reader.style.setProperty("--pdf-toolbar-bottom", `${fimEditor + 8}px`);
            reader.style.setProperty("--pdf-content-top", `${fimEditor + 12}px`);
            return;
        }
        const fimToolbar = toolbar.getBoundingClientRect().bottom - topo;
        reader.style.setProperty("--pdf-toolbar-bottom", `${fimToolbar + 8}px`);
        const fimPesquisa = pesquisa && !pesquisa.hidden ? pesquisa.getBoundingClientRect().bottom - topo : 0;
        reader.style.setProperty("--pdf-content-top", `${Math.max(fimToolbar, fimPesquisa) + 16}px`);
    };
    observadorControles = new ResizeObserver(atualizarEspacoControles);
    if (toolbar)
        observadorControles.observe(toolbar);
    if (pesquisa)
        observadorControles.observe(pesquisa);
    const painelFormulario = reader?.querySelector(".pdf-form-panel");
    if (painelFormulario)
        observadorControles.observe(painelFormulario);
    observadorEdicaoFormulario = new MutationObserver(atualizarEspacoControles);
    observadorEdicaoFormulario.observe(reader, { attributes: true, attributeFilter: ["class"] });
    atualizarEspacoControles();
    observadorResize = new ResizeObserver(() => {
        if (temporizadorResize)
            clearTimeout(temporizadorResize);
        temporizadorResize = setTimeout(() => {
            atualizarEspacoControles();
            aplicarZoomPdf(escalaZoomPdf, obterPaginaAtualPdf());
        }, 180);
    });
    observadorResize.observe(palco);
}
export async function iniciarLeitorPdf(url, paginaInicial = 1, zoomInicial = 1, editor) {
    const area = obterArea();
    if (!area || !obterPalco())
        return;
    const token = ++tokenLeitor;
    if (editor && formularioPdf === editor)
        formularioPdf = null;
    encerrarRecursos(false);
    if (editor)
        formularioPdf = editor;
    const readerRoot = document.querySelector(".reader-pdf-reader");
    if (readerRoot)
        sumarioPdf = new PdfOutline(readerRoot, navegarParaPaginaPdf);
    const documentoAnterior = documentoAtual;
    documentoAtual = null;
    if (documentoAnterior)
        void documentoAnterior.destroy().catch(() => undefined);
    resultados = [];
    indiceResultado = -1;
    paginaResultadoAtual = null;
    cacheTexto.clear();
    cacheItensTexto.clear();
    destaquesPorPagina.clear();
    termoDestaque = "";
    moduloPdfAtual = null;
    escalaZoomPdf = Math.min(LIMITE_ESCALA_ZOOM_PDF, Math.max(0.5, zoomInicial));
    atualizarBotoesPesquisa();
    atualizarStatusDocumento("PDF carregando…");
    try {
        const caminhoModuloPdf = "/pdfjs/pdf.mjs?v=reader-epub-arrows-20260902-v12";
        const pdfjs = await import(caminhoModuloPdf);
        moduloPdfAtual = pdfjs;
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.mjs?v=reader-epub-arrows-20260902-v12";
        const documento = await pdfjs.getDocument({ url, rangeChunkSize: 262_144, disableAutoFetch: true, disableStream: true }).promise;
        if (token !== tokenLeitor) {
            await documento.destroy();
            return;
        }
        documentoAtual = documento;
        const contentMatch = new URL(url, location.href).pathname.match(/^\/api\/contents\/([^/]+)\/pages\//);
        if (!editor && readerRoot && contentMatch) {
            const newEditor = new PdfFormEditor(readerRoot, decodeURIComponent(contentMatch[1]), (previewUrl, page) => iniciarLeitorPdf(previewUrl, page, escalaZoomPdf, newEditor), obterPaginaAtualPdf);
            formularioPdf = newEditor;
        }
        void sumarioPdf?.load(documento);
        const primeiraPagina = await documento.getPage(1);
        const viewport = primeiraPagina.getViewport({ scale: 1 });
        const proporcao = `${viewport.width} / ${viewport.height}`;
        area.replaceChildren(...Array.from({ length: documento.numPages }, (_, indice) => {
            const pagina = document.createElement("article");
            pagina.className = "pdf-page";
            pagina.dataset.pdfPage = String(indice + 1);
            pagina.dataset.renderizada = "false";
            pagina.style.aspectRatio = proporcao;
            pagina.setAttribute("aria-label", `Página ${indice + 1} do PDF`);
            return pagina;
        }));
        atualizarTotalPaginas(documento.numPages);
        const paginaRestaurada = controladorPagina.reiniciar(documento.numPages, paginaInicial);
        atualizarCampoPagina(paginaRestaurada);
        atualizarStatusDocumento("", true);
        atualizarLayoutPdf();
        configurarGestosPdf();
        configurarObservadores();
        agendarRenderizacao(paginaRestaurada, false, true);
        requestAnimationFrame(() => navegarParaPaginaPdf(paginaRestaurada));
    }
    catch (erro) {
        if (token !== tokenLeitor)
            return;
        console.error(erro);
        atualizarStatusDocumento(`Não foi possível abrir este PDF. ${erro instanceof Error ? erro.message : "Tente novamente."}`);
        if (editor)
            throw erro;
    }
}
export function alternarSumarioPdf() { sumarioPdf?.toggleOpen(); }
function encerrarRecursos(destruirDocumento) {
    formularioPdf?.destroy();
    formularioPdf = null;
    sumarioPdf?.destroy();
    sumarioPdf = null;
    for (const layer of camadasTexto.values())
        layer.cancel();
    camadasTexto.clear();
    gestosPdf?.abort();
    gestosPdf = null;
    if (temporizadorZoom)
        clearTimeout(temporizadorZoom);
    temporizadorZoom = null;
    revisaoLayout += 1;
    observadorProximidade?.disconnect();
    observadorVisibilidade?.disconnect();
    observadorResize?.disconnect();
    observadorControles?.disconnect();
    observadorControles = null;
    observadorEdicaoFormulario?.disconnect();
    observadorEdicaoFormulario = null;
    observadorProximidade = null;
    observadorVisibilidade = null;
    observadorResize = null;
    ultimaPaginaNotificada = 0;
    if (temporizadorResize)
        clearTimeout(temporizadorResize);
    temporizadorResize = null;
    for (const tarefa of tarefasAtivas.values())
        tarefa.cancel();
    tarefasAtivas.clear();
    filaRenderizacao.length = 0;
    trabalhosPendentes.clear();
    paginasProximas.clear();
    controladorPagina.reiniciar(1, 1);
    ultimoUsoCanvas.clear();
    if (destruirDocumento) {
        const documento = documentoAtual;
        documentoAtual = null;
        if (documento)
            void documento.destroy().catch(() => undefined);
    }
}
export function encerrarLeitorPdf() {
    tokenLeitor += 1;
    tokenPesquisa += 1;
    encerrarRecursos(true);
    cacheTexto.clear();
}
