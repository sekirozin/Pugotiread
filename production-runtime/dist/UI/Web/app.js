import { isPublicationCompleted, validRating } from "../../shared/work-metadata.js";
import { observeReaderImages } from "./reader-image-window.js";
import { clampEpubOffset, epubBookPercent, epubViewportOffset } from "./epub-progress.js";
import { readerBudget, deviceHints, imagePrefetchOffsets } from "./reader-budget.js";
import { renderIcon, renderSidebarIcon } from "./components/icons.js";
import { renderAvatar } from "./components/avatar.js";
// @ts-ignore Versioned runtime module for browser and desktop caches.
import { clearPdfFormDrafts, PdfFormEditor } from "./pdf-form.js?v=rpg-personal-20260923";
import { renderSidebar, renderLibraryContextMenu, renderVaultContextMenu, renderVaultNavButton } from "./components/layout/sidebar.js";
import { renderStatsMenu, renderTopbar, renderAccountMenu } from "./components/layout/topbar.js";
import { renderSeriesCard, renderSeriesContextMenu } from "./components/series-card.js";
import { api } from "./services/api.js";
import { filterContents, normalizeText, parseSearch } from "./services/search.js";
import { state } from "./state/store.js";
import { applyRouteToState, buildRoute, createRouter, parseRoute } from "./router.js";
import { renderHomeView } from "./views/home.js";
import { renderLibraryView } from "./views/library.js";
import { bindRpgPanel } from './views/rpg.js';
import { renderPdfDetails } from './views/pdf-details.js';
import { renderContentListView, renderEmptyMedia, renderNoSearchResults, renderPlaceholderView } from "./views/shared.js";
// @ts-ignore A versão na URL invalida o módulo persistido pelo cache imutável do servidor.
import { abrirPesquisaPdf, alvoEditavelPdf, aplicarZoomPdf, alternarSumarioPdf, encerrarLeitorPdf, fecharPesquisaPdf, iniciarLeitorPdf, navegarParaPaginaPdf, navegarRelativoPdf, obterPaginaAtualPdf, obterTotalPaginasPdf, pesquisaPdfAberta, pesquisarPdf, proximoResultadoPdf, resolverCliquePalcoLeitor } from "./pdf-viewer.js?v=reader-performance-20261016";
// @ts-ignore A versão na URL invalida o módulo persistido pelo cache imutável do servidor.
import { resolverAtalhoLeitor, resolverTeclaEpubIframe } from "./reader-keyboard.js?v=kindle-reader-20261016";
let vaultInactivityTimer = null;
let lastVaultTouchAt = 0;
let vaultTouchInFlight = false;
let passwordResetTokenPath = "";
let syncStatusTimer = null;
let lastAppliedSyncFinishedAt = "";
let readerProgressSaveTimer = null;
let directDownloadSubmitting = false;
let readerScrollRaf = null;
let pdfControlsHideTimer = null;
let pdfPointerStart = null;
let pdfDragSuppressedUntil = 0;
let readerLoadingTimer = null;
let readerNavigationId = 0;
let pendingReaderPage = null;
let routeLoading = false;
let routeLoadingMensagem = "Carregando título";
// O catálogo global só é baixado por telas que dependem dele; guias abertas em obra, leitor ou biblioteca não pagam esse custo.
let catalogoGlobalPronto = false;
let catalogoGlobalPedido = null;
let globalSearchOpen = false;
let globalSearchQuery = "";
let globalSearchExtraContents = [];
let globalSearchRequest = 0;
const router = createRouter(window, applyAppRoute);
// Botões que representam destinos também respondem ao botão central do mouse.
document.addEventListener("auxclick", (event) => {
    if (event.button !== 1 || !(event.target instanceof Element) || event.target.closest("a[href]"))
        return;
    const target = event.target.closest("[data-series-continue], [data-chapter-open], [data-library-id], [data-library-folder], [data-global-search-result], [data-open-person]");
    if (!target || target.closest("[data-library-menu-id], [data-scan-library-id], .library-context-menu"))
        return;
    let route;
    if (target.dataset.seriesContinue || target.dataset.chapterOpen) {
        const id = target.dataset.seriesContinue || target.dataset.chapterOpen;
        const content = findContentById(id);
        if (!content) return;
        route = { kind: "reader", libraryId: content.libraryId, contentId: id, page: Number(target.dataset.chapterStart ?? 0) + 1 };
    } else if (target.dataset.globalSearchResult) {
        route = { kind: "title", libraryId: target.dataset.libraryId, contentId: target.dataset.globalSearchResult };
    } else if (target.dataset.openPerson) {
        route = { kind: "person", userId: target.dataset.openPerson };
    } else if (target.dataset.libraryFolder) {
        if (!state.activeLibraryId) return;
        route = { kind: "library", libraryId: state.activeLibraryId, folder: target.dataset.libraryFolder || undefined };
    } else if (target.dataset.libraryId) {
        route = { kind: "library", libraryId: target.dataset.libraryId };
    }
    if (!route) return;
    event.preventDefault();
    window.open(buildRoute(route), "_blank", "noopener");
});
const readerImageCache = new Map();
const readerLimits = readerBudget(deviceHints());
let readerPrefetchDirection = 1;
let readerPrefetchGeneration = 0;
let epubPrefetch = null;
let epubProgressRaf = null;
let epubPanel = "none";
let releaseReaderImageWindow = null;
// Bibliotecas "other" permanecem acessíveis pela navegação própria, mas não
// entram no catálogo geral nem nos lançamentos.
const globallyListedLibraryKinds = new Set(["manga", "manhwa", "comic"]);
// A mudança de elegibilidade das bibliotecas invalida a sessão anterior para
// não restaurar lançamentos de bibliotecas "other" em uma versão nova do app.
// v3: capítulos EPUB reais (TOC + marcadores) mudam a forma do conteúdo.
const homeCachePrefix = "pugotiread-home-cache-v3";
function getGloballyListedLibraries(libraries) {
    return libraries.filter((library) => globallyListedLibraryKinds.has(library.kind));
}
function filterGloballyListedContents(contents, libraries = state.libraries) {
    const globallyListedLibraryIds = new Set(getGloballyListedLibraries(libraries).map((library) => library.id));
    return contents.filter((content) => globallyListedLibraryIds.has(content.libraryId));
}
function getHomeCacheKey() {
    return state.user?.id ? `${homeCachePrefix}:${state.user.id}` : null;
}
function restoreHomeCache() {
    const key = getHomeCacheKey();
    if (!key) {
        return false;
    }
    try {
        const raw = sessionStorage.getItem(key);
        if (!raw) {
            return false;
        }
        const cached = JSON.parse(raw);
        if (!Array.isArray(cached.libraries) || !Array.isArray(cached.homeContents)) {
            return false;
        }
        state.libraries = cached.libraries;
        state.progress = cached.progress ?? [];
        state.bookmarks = cached.bookmarks ?? [];
        state.seriesMarks = cached.seriesMarks ?? [];
        state.wantToRead = cached.wantToRead ?? [];
        state.readingList = cached.readingList ?? [];
        state.collections = cached.collections ?? [];
        state.profileReviews = cached.profileReviews ?? [];
        state.peopleUsers = cached.peopleUsers ?? [];
        state.homeContents = filterGloballyListedContents(cached.homeContents);
        state.readingNowContents = filterGloballyListedContents(cached.readingNowContents ?? cached.homeContents);
        state.activeLibraryId = null;
        state.activeSeriesId = null;
        state.activeView = "home";
        return true;
    }
    catch {
        sessionStorage.removeItem(key);
        return false;
    }
}
function saveHomeCache() {
    const key = getHomeCacheKey();
    if (!key) {
        return;
    }
    try {
        sessionStorage.setItem(key, JSON.stringify({
            libraries: state.libraries,
            progress: state.progress,
            bookmarks: state.bookmarks,
            seriesMarks: state.seriesMarks,
            wantToRead: state.wantToRead,
            readingList: state.readingList,
            collections: state.collections,
            profileReviews: state.profileReviews,
            peopleUsers: state.peopleUsers,
            homeContents: state.homeContents,
            readingNowContents: state.readingNowContents
        }));
    }
    catch {
        // A full cache is an optimization only; quota/private browsing must not block startup.
    }
}
let googleConfigPromise = null;
let googleScriptPromise = null;
let pugotilabAuthConfigPromise = null;
const appElement = document.querySelector("#app");
if (!appElement) {
    throw new Error("Elemento #app não encontrado.");
}
const app = appElement;
let readerFullscreenPending = false;
function isReaderFullscreen() {
    const reader = document.querySelector(".reader");
    const fullscreen = document.fullscreenElement ?? document.webkitFullscreenElement;
    return Boolean(reader && fullscreen && (fullscreen === reader || fullscreen === document.documentElement));
}
function isReaderFullscreenAvailable() {
    const root = document.documentElement;
    return Boolean((document.fullscreenEnabled && root.requestFullscreen) ||
        (document.webkitFullscreenEnabled !== false && root.webkitRequestFullscreen));
}
async function exitReaderFullscreen() {
    if (!isReaderFullscreen())
        return;
    if (document.exitFullscreen)
        await document.exitFullscreen();
    else
        await document.webkitExitFullscreen?.();
}
function isMobileViewport() {
    return window.matchMedia("(max-width: 760px)").matches;
}
function renderReaderFullscreenIcon() {
    return renderIcon(isReaderFullscreen() ? "fullscreenExit" : "fullscreen");
}
function getReaderFullscreenLabel() {
    return isReaderFullscreen() ? "Sair da tela cheia" : "Tela cheia";
}
function renderIconeToolbarPdf(caminho) {
    return `<svg class="reader-pdf-toolbar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${caminho}"></path></svg>`;
}
function renderIconeMarcadorPdf(marcado) {
    return `<svg class="reader-pdf-toolbar-icon" viewBox="0 0 24 24" fill="${marcado ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18l-6-3l-6 3z"></path></svg>`;
}
function renderIconeImprimirPdf() {
    return `<svg class="reader-pdf-toolbar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 8V3h10v5"></path><path d="M6 18H4a2 2 0 0 1-2-2v-5a3 3 0 0 1 3-3h14a3 3 0 0 1 3 3v5a2 2 0 0 1-2 2h-2"></path><path d="M7 14h10v7H7z"></path><path d="M17 12h.01"></path></svg>`;
}
function getPasswordResetTokenFromPath() {
    const parts = window.location.pathname.split("/");
    return decodeURIComponent(parts[2] ?? "").trim();
}
function clearPasswordResetState() {
    state.passwordResetOpen = false;
    state.passwordResetEmail = "";
    state.passwordResetMessage = "";
    state.passwordResetError = "";
    passwordResetTokenPath = "";
}
async function getGoogleConfig() {
    googleConfigPromise ??= api("/api/auth/google/config");
    return googleConfigPromise;
}
async function getPugotilabAuthConfig() {
    pugotilabAuthConfigPromise ??= api("/api/auth/pugotilab/config");
    return pugotilabAuthConfigPromise;
}
function buildAuthUrl(baseUrl, returnUrl = window.location.href) {
    const authUrl = new URL(baseUrl, window.location.origin);
    authUrl.searchParams.set("return", returnUrl);
    return authUrl.toString();
}
async function redirectToPugotilabLogin() {
    const redirectKey = "pugotiread-pugotilab-auth-redirect";
    const redirectTarget = window.location.href;
    const alreadyRedirected = sessionStorage.getItem(redirectKey) === redirectTarget;
    if (alreadyRedirected) {
        renderLogin("Não foi possível validar a sessão Pugotilab. Entre novamente para continuar.");
        return;
    }
    sessionStorage.setItem(redirectKey, redirectTarget);
    const config = await getPugotilabAuthConfig();
    window.location.assign(buildAuthUrl(config.authUrl, redirectTarget));
}
function clearPugotilabRedirectMarker() {
    sessionStorage.removeItem("pugotiread-pugotilab-auth-redirect");
}
async function ensureGoogleScript() {
    if (window.google) {
        return;
    }
    googleScriptPromise ??= new Promise((resolve, reject) => {
        const existingScript = document.querySelector("script[data-google-identity]");
        if (existingScript) {
            existingScript.addEventListener("load", () => resolve(), { once: true });
            existingScript.addEventListener("error", () => reject(new Error("Não foi possível carregar o login do Google.")), { once: true });
            return;
        }
        const script = document.createElement("script");
        script.src = "https://accounts.google.com/gsi/client";
        script.async = true;
        script.defer = true;
        script.dataset.googleIdentity = "true";
        script.addEventListener("load", () => resolve(), { once: true });
        script.addEventListener("error", () => reject(new Error("Não foi possível carregar o login do Google.")), { once: true });
        document.head.append(script);
    });
    await googleScriptPromise;
}
async function mountGoogleButton(containerId, callback, unavailableMessage) {
    const container = document.querySelector(`#${containerId}`);
    if (!container) {
        return;
    }
    try {
        const config = await getGoogleConfig();
        if (!config.enabled || !config.clientId) {
            container.innerHTML = `<p class="google-unavailable">${escapeHtml(unavailableMessage)}</p>`;
            return;
        }
        await ensureGoogleScript();
        if (!window.google) {
            throw new Error("Login do Google indisponível.");
        }
        window.google.accounts.id.initialize({
            client_id: config.clientId,
            callback: (response) => {
                if (!response.credential) {
                    container.innerHTML = `<p class="google-unavailable">Credencial do Google não recebida.</p>`;
                    return;
                }
                void callback(response.credential);
            }
        });
        window.google.accounts.id.renderButton(container, {
            theme: "outline",
            size: "large",
            width: Math.min(360, container.clientWidth || 360),
            text: "signin_with"
        });
    }
    catch (error) {
        container.innerHTML = `<p class="google-unavailable">${escapeHtml(error instanceof Error ? error.message : unavailableMessage)}</p>`;
    }
}
function closeFloatingMenusFromOutside(target) {
    const element = target instanceof Element ? target : null;
    let changed = false;
    if (state.statsMenuOpen && (!element || !element.closest(".stats-menu-shell"))) {
        state.statsMenuOpen = false;
        changed = true;
    }
    if (state.accountMenuOpen && (!element || !element.closest(".account-menu-shell"))) {
        state.accountMenuOpen = false;
        changed = true;
    }
    if (state.openLibraryMenuId && (!element || !element.closest("[data-library-menu-id], .library-context-menu"))) {
        state.openLibraryMenuId = null;
        changed = true;
    }
    if (state.vaultMenuOpen && (!element || !element.closest("[data-vault-menu], .library-context-menu"))) {
        state.vaultMenuOpen = false;
        changed = true;
    }
    if ((state.openSeriesMenuId || state.openSeriesAddMenuId || state.openSeriesRemoveMenuId) &&
        (!element || !element.closest("[data-series-menu-key], .series-context-menu, .series-add-menu, .series-remove-menu"))) {
        state.openSeriesMenuId = null;
        state.openSeriesAddMenuId = null;
        state.openSeriesRemoveMenuId = null;
        changed = true;
    }
    if (changed) {
        renderNavigationMenus();
    }
}
function closeSidebarFromOutside(target) {
    const element = target instanceof Element ? target : null;
    if (element?.closest('.sidebar, #menu-button'))
        return;
    if (isMobileViewport() && state.mobileNavOpen) {
        closeMobileNavigation();
        updateNavigationLayout();
    }
    else if (!isMobileViewport() && !state.sidebarCollapsed) {
        state.sidebarCollapsed = true;
        updateNavigationLayout();
    }
}
function closeNavigationPanels() {
    state.accountMenuOpen = false;
    state.statsMenuOpen = false;
    state.vaultMenuOpen = false;
    state.openLibraryMenuId = null;
    state.openSeriesMenuId = null;
    state.openSeriesAddMenuId = null;
    state.openSeriesRemoveMenuId = null;
}
function closeMobileNavigation() {
    state.mobileNavOpen = false;
}
function openView(view) {
    if (view === "library") {
        if (state.activeLibraryId)
            void loadLibrary(state.activeLibraryId);
        return;
    }
    void router.navigate({ kind: "view", view });
}
async function applyAppRoute(route, context) {
    if (route.kind === "view" && route.view === "vault" && (state.user?.role !== "admin" || state.vaultHiddenFromMenu)) {
        await router.replaceRoute({ kind: "view", view: "home" });
        return;
    }
    if (route.kind === "person" && !state.peopleUsers.some((user) => user.id === route.userId)) {
        await router.replaceRoute({ kind: "view", view: "people" });
        return;
    }
    if ("libraryId" in route && ![...state.libraries, ...state.personalLibraries].some((library) => library.id === route.libraryId)) {
        await router.replaceRoute({ kind: "view", view: "home" });
        return;
    }
    clearReaderLoadingTimer();
    readerPrefetchGeneration += 1;
    epubPrefetch?.abort();
    epubPrefetch = null;
    readerImageCache.clear();
    releaseReaderImageWindow?.();
    releaseReaderImageWindow = null;
    encerrarLeitorPdf();
    pendingReaderPage = null;
    readerNavigationId += 1;
    if (state.reader && route.kind !== "reader")
        void exitReaderFullscreen().catch(() => undefined);
    closeNavigationPanels();
    closeMobileNavigation();
    state.libraryModalOpen = false;
    state.collectionModalOpen = false;
    state.collectionShareModalOpen = false;
    state.deletingCollectionId = null;
    state.adminUserModalOpen = false;
    state.adminUserDeleteId = null;
    state.profileEditing = false;
    state.search = "";
    state.seriesTab = "chapters";
    state.seriesReviewError = "";
    applyRouteToState(state, route);
    routeLoading = false;
    routeLoadingMensagem = "Carregando título";
    state.loadingLibraryId = null;
    state.libraryLoadError = "";
    if (rotaUsaCatalogoGlobal(route) && !catalogoGlobalPronto) {
        routeLoading = true;
        routeLoadingMensagem = "Carregando obras";
        renderShell();
        await garantirCatalogoGlobal();
        if (!context.isCurrent())
            return;
        routeLoading = false;
    }
    if ("libraryId" in route) {
        let content = "contentId" in route ? findContentById(route.contentId) : null;
        if (content?.libraryId !== route.libraryId)
            content = null;
        if (route.kind === "library" || !content) {
            routeLoading = route.kind !== "library";
            state.contents = [];
            state.loadingLibraryId = route.libraryId;
            renderShell();
            try {
                if ("contentId" in route) {
                    const payload = await api(`/api/libraries/${encodeURIComponent(route.libraryId)}/contents/${encodeURIComponent(route.contentId)}`);
                    if (!context.isCurrent())
                        return;
                    content = payload.content;
                    state.contents = [content];
                }
                else {
                    const payload = await api(`/api/libraries/${encodeURIComponent(route.libraryId)}/contents`);
                    if (!context.isCurrent())
                        return;
                    state.contents = payload.contents;
                }
            }
            catch (error) {
                if (!context.isCurrent())
                    return;
                state.libraryLoadError = error instanceof Error ? error.message : "Não foi possível carregar a biblioteca.";
            }
            state.loadingLibraryId = null;
            routeLoading = false;
        }
        if (route.kind !== "library") {
            if (!content) {
                await router.replaceRoute({ kind: "library", libraryId: route.libraryId });
                return;
            }
            if (route.kind === "reader") {
                activateReader(content, route.page - 1);
                syncReaderRoute();
            }
        }
    }
    renderShell();
    if (route.kind === "title" && findContentById(route.contentId)?.pageTypes.join(',') !== 'pdf') {
        await loadSeriesReviews(route.contentId).catch(() => undefined);
        if (context.isCurrent())
            renderShell();
    }
    if (route.kind === "view" && route.view === "bookmarks")
        void loadMarkedPages();
    if (route.kind === "view" && route.view === "collections")
        void loadCollectionContents();
}
function syncReaderRoute() {
    if (!state.reader)
        return;
    const { content, page } = state.reader;
    void router.replaceRoute({ kind: "reader", libraryId: content.libraryId, contentId: content.id, page: page + 1 }, false);
}
document.addEventListener("click", (event) => {
    closeFloatingMenusFromOutside(event.target);
    closeSidebarFromOutside(event.target);
    closeGlobalSearchFromOutside(event.target);
});
["click", "keydown", "pointermove", "scroll"].forEach((eventName) => {
    document.addEventListener(eventName, registerVaultActivity, { passive: true });
});
function applyTheme() {
    document.documentElement.dataset.theme = state.darkMode ? "dark" : "light";
}
// Tema da conta Pugotilab (menu da conta / Pugoti Profile) no claro/escuro do Pugotiread.
window.pugotiAplicarTema = (tema) => {
    state.darkMode = tema !== "claro";
    localStorage.setItem("pugotiread-dark-mode", state.darkMode ? "dark" : "light");
    applyTheme();
};
if (document.documentElement.dataset.pugotiTema)
    state.darkMode = document.documentElement.dataset.pugotiTema !== "claro";
function renderLoadingScreen(message = "Carregando obras", description = "Preparando as bibliotecas disponíveis para você.") {
    app.innerHTML = `
    <main class="boot-loading-screen" aria-live="polite" aria-busy="true">
      <section class="boot-loading-panel">
        <div class="boot-loading-brand">
          <span class="brand-badge">${renderSidebarIcon("book", "Pugotiread")}</span>
          <strong>Pugotiread</strong>
        </div>
        <div class="boot-loading-orbit" aria-hidden="true">
          <span></span>
        </div>
        <div class="boot-loading-copy">
          <h1>${escapeHtml(message)}</h1>
          <p>${escapeHtml(description)}</p>
        </div>
        <div class="boot-loading-skeleton" aria-hidden="true">
          <span></span>
          <span></span>
          <span></span>
          <span></span>
        </div>
      </section>
    </main>
  `;
}
function showLoadingCovers(libraries) {
    const container = app.querySelector(".boot-loading-skeleton");
    if (!container) return;
    const slots = [...container.querySelectorAll("span")];
    const covers = [];
    const seen = new Set();
    let timer = null;
    function paint() {
        if (!container.isConnected) {
            if (timer !== null) window.clearInterval(timer);
            return;
        }
        if (!covers.length) return;
        const shuffled = [...covers];
        for (let index = shuffled.length - 1; index > 0; index--) {
            const randomIndex = Math.floor(Math.random() * (index + 1));
            [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
        }
        slots.forEach((slot, index) => {
            if (index >= shuffled.length) return;
            const url = shuffled[index];
            if (slot.dataset.cover === url) return;
            const img = document.createElement("img");
            img.alt = "";
            img.decoding = "async";
            slot.dataset.pendingCover = url;
            img.onload = () => {
                if (!container.isConnected || slot.dataset.pendingCover !== url) return;
                slot.replaceChildren(img);
                slot.dataset.cover = url;
                slot.classList.add("has-cover");
                delete slot.dataset.pendingCover;
            };
            img.onerror = () => {
                if (slot.dataset.pendingCover === url) delete slot.dataset.pendingCover;
            };
            img.src = url;
        });
    }
    const kinds = new Set(["manga", "manhwa", "comic", "book", "lightNovel"]);
    for (const library of libraries.filter((item) => !item.isPersonal && kinds.has(item.kind))) {
        api(`/api/libraries/${encodeURIComponent(library.id)}/contents`).then(({ contents }) => {
            if (!container.isConnected) return;
            for (const item of contents) {
                if (item.libraryId === library.id && item.coverUrl && !seen.has(item.coverUrl)) {
                    seen.add(item.coverUrl);
                    covers.push(item.coverUrl);
                }
            }
            if (covers.length) {
                paint();
                if (timer === null) timer = window.setInterval(paint, 2600);
            }
        }).catch(() => {});
    }
}
async function boot() {
    applyTheme();
    if (window.location.pathname.startsWith("/reset-password/")) {
        passwordResetTokenPath = getPasswordResetTokenFromPath();
        if (!passwordResetTokenPath) {
            renderPasswordResetPage("Link de confirmação inválido.");
            return;
        }
        renderPasswordResetPage();
        return;
    }
    if (window.location.pathname.startsWith("/invite/")) {
        state.invitePathToken = decodeURIComponent(window.location.pathname.split("/")[2] ?? "");
        await loadInviteFlow();
        return;
    }
    try {
        renderLoadingScreen("Entrando no Pugotiread", "Validando sua sessão antes de carregar as obras.");
        const payload = await api("/api/me");
        clearPugotilabRedirectMarker();
        state.user = payload.user;
        if (state.user.needsNickname) {
            renderNicknameSetup();
            return;
        }
        const restoredHome = restoreHomeCache();
        if (!restoredHome) {
            const rotaInicial = parseRoute(window.location.href);
            if (rotaInicial.kind === "title" || rotaInicial.kind === "reader")
                renderLoadingScreen("Carregando título");
            else
                renderLoadingScreen();
        }
        await loadHome();
        startSyncStatusPolling();
    }
    catch {
        try {
            const setup = await api("/api/setup/status");
            state.setupRequired = setup.setupRequired;
            if (state.setupRequired) {
                renderInitialSetup();
                return;
            }
        }
        catch {
            // Fall through to the login screen if setup status cannot be read.
        }
        try {
            await redirectToPugotilabLogin();
        }
        catch (redirectError) {
            renderLogin(redirectError instanceof Error ? redirectError.message : "Não foi possível abrir o login Pugotilab.");
        }
    }
}
async function loadInviteFlow() {
    if (!state.invitePathToken) {
        renderLogin("Convite inválido.");
        return;
    }
    try {
        const payload = await api(`/api/invites/${encodeURIComponent(state.invitePathToken)}`);
        state.inviteData = payload.invitation;
        renderInviteRegistration();
    }
    catch (error) {
        state.inviteError = error instanceof Error ? error.message : "Convite inválido.";
        renderInviteRegistration();
    }
}
let startupLibraries = {};
let startupSelectedUserId = "";
async function loadHome() {
    const readingSettings = api("/api/me/reading-settings");
    const startup = await api("/api/me/startup").catch(() => ({ libraryId: null }));
    const requests = [
        api("/api/libraries"),
        api("/api/continue"),
        api("/api/bookmarks"),
        api("/api/series-marks"),
        api("/api/user-lists"),
        api("/api/me/reviews"),
        api("/api/users")
    ];
    // O mosaico de capas baixa as listas das bibliotecas: só vale nas aberturas que já dependem do catálogo.
    const rotaDaAbertura = parseRoute(window.location.href);
    const abreSemCatalogo = rotaDaAbertura.kind === "library" || rotaDaAbertura.kind === "title" || rotaDaAbertura.kind === "reader" || (window.location.pathname === "/" && startup.libraryId);
    if (!abreSemCatalogo)
        void requests[0].then(({ libraries }) => showLoadingCovers(libraries)).catch(() => {});
    if (state.user?.role === "admin") {
        requests.push(api("/api/admin/users"));
        requests.push(api("/api/admin/settings"));
        requests.push(api("/api/admin/pdf-form-copies"));
    }
    const [librariesPayload, progressPayload, bookmarksPayload, seriesMarksPayload, userListsPayload, reviewsPayload, usersPayload, adminPayload, settingsPayload, pdfCopiesPayload] = await Promise.all(requests);
    const { libraries } = librariesPayload;
    const { progress } = progressPayload;
    const { bookmarks } = bookmarksPayload;
    const { seriesMarks } = seriesMarksPayload;
    const userLists = userListsPayload;
    const { reviews } = reviewsPayload;
    const { users } = usersPayload;
    state.libraries = libraries;
    state.progress = progress;
    state.bookmarks = bookmarks;
    state.seriesMarks = seriesMarks;
    state.wantToRead = userLists.wantToRead;
    state.readingList = userLists.readingList;
    state.collections = userLists.collections;
    state.profileReviews = reviews;
    state.peopleUsers = users;
    if (adminPayload) {
        const payload = adminPayload;
        state.adminUsers = payload.users;
        state.libraries = payload.libraries;
    }
    if (settingsPayload) {
        const { settings } = settingsPayload;
        state.vaultTimeoutMinutes = settings.vaultTimeoutMinutes;
        state.vaultSettingsDraft = String(settings.vaultTimeoutMinutes);
        state.readingSettingsDraft = settings.readingDefaults;
        startupLibraries = settings.startupLibraries ?? {};
    }
    state.readingSettingsDraft = (await readingSettings).readingDefaults;
    if (pdfCopiesPayload)
        state.pdfFormCopies = pdfCopiesPayload.copies;
    // Successful invitation registration has finished its dedicated auth flow.
    if (window.location.pathname.startsWith("/invite/"))
        await router.replaceRoute({ kind: "view", view: "home" }, false);
    await router.start(startup.libraryId ? { kind: "library", libraryId: startup.libraryId } : undefined);
}
function rotaUsaCatalogoGlobal(route) {
    return route.kind === "view" || route.kind === "person";
}
function garantirCatalogoGlobal() {
    if (catalogoGlobalPronto)
        return Promise.resolve();
    catalogoGlobalPedido ??= loadLibraryContents(getGloballyListedLibraries(state.libraries)).then((contents) => {
        state.homeContents = contents;
        state.readingNowContents = contents;
        catalogoGlobalPronto = true;
        catalogoGlobalPedido = null;
        saveHomeCache();
    });
    return catalogoGlobalPedido;
}
async function loadLibraryContents(libraries) {
    const responses = await Promise.all(libraries.map((library) => api(`/api/libraries/${library.id}/contents`).catch(() => ({ contents: [] }))));
    return responses.flatMap((response) => response.contents);
}
async function loadCollectionContents() {
    const listPayload = await api("/api/user-lists?includeContents=1").catch(() => ({ contents: [] }));
    const libraryIds = new Set(state.collections.flatMap((collection) => collection.contentIds.map((id) => id.split(":", 1)[0]).filter(Boolean)));
    const libraries = state.libraries.filter((library) => libraryIds.has(library.id));
    const contents = await loadLibraryContents(libraries.length ? libraries : state.libraries);
    const merged = new Map([...state.homeContents, ...state.readingNowContents, ...state.contents].map((item) => [item.id, item]));
    for (const content of contents)
        merged.set(content.id, content);
    for (const content of listPayload.contents ?? [])
        merged.set(content.id, content);
    if (state.activeView !== "collections" || state.activeSeriesId || state.reader)
        return;
    state.contents = [...merged.values()];
    if (state.activeView === "collections")
        renderShell();
}
async function loadLibrary(libraryId) {
    await router.navigate({ kind: "library", libraryId });
}
function renderLogin(error = "") {
    app.innerHTML = `
    <main class="login-shell">
      <section class="login-panel pugotilab-login-panel">
        <h1 class="brand">Pugotiread</h1>
        <p class="muted">Use sua conta Pugotilab para acessar a biblioteca.</p>
        <p class="google-unavailable">Se você já estiver logado no Pugotilab, a entrada acontece automaticamente.</p>
        <p class="error">${escapeHtml(error)}</p>
        <button class="button" id="pugotilab-login-button" type="button">Entrar com Pugotilab</button>
      </section>
    </main>
  `;
    document.querySelector("#pugotilab-login-button")?.addEventListener("click", async () => {
        sessionStorage.removeItem("pugotiread-pugotilab-auth-redirect");
        try {
            await redirectToPugotilabLogin();
        }
        catch (redirectError) {
            renderLogin(redirectError instanceof Error ? redirectError.message : "Não foi possível abrir o login Pugotilab.");
        }
    });
}
function renderPasswordResetRequestSection() {
    return `
    <section class="login-reset-panel">
      <p class="muted">Informe o e-mail cadastrado para receber o link de troca de senha.</p>
      <form id="password-reset-request-form">
        <label class="form-row">
          <span>E-mail</span>
          <input class="input" name="email" type="email" autocomplete="email" value="${escapeHtml(state.passwordResetEmail)}" required />
        </label>
        ${state.passwordResetMessage ? `<p class="scan-message">${escapeHtml(state.passwordResetMessage)}</p>` : ""}
        ${state.passwordResetError ? `<p class="error">${escapeHtml(state.passwordResetError)}</p>` : ""}
        <div class="invite-form-actions">
          <button class="button secondary" id="close-password-reset" type="button">Voltar ao login</button>
          <button class="button" type="submit">Enviar link</button>
        </div>
      </form>
    </section>
  `;
}
function renderPasswordResetPage(error = "") {
    app.innerHTML = `
    <main class="login-shell">
      <form class="login-panel invite-panel" id="password-reset-form">
        <h1 class="brand">Pugotiread</h1>
        <p class="muted">Troca de senha</p>
        <p class="google-unavailable">Esse link precisa ser validado pelo e-mail cadastrado antes da senha ser trocada.</p>
        <label class="form-row">
          <span>Nova senha</span>
          <input class="input" name="newPassword" type="password" autocomplete="new-password" minlength="12" required autofocus />
        </label>
        <label class="form-row">
          <span>Confirmar senha</span>
          <input class="input" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" required />
        </label>
        <p class="error">${escapeHtml(error)}</p>
        <div class="invite-form-actions">
          <button class="button secondary" id="back-to-login-from-reset" type="button">Voltar ao login</button>
          <button class="button" type="submit">Trocar senha</button>
        </div>
      </form>
    </main>
  `;
    document.querySelector("#back-to-login-from-reset")?.addEventListener("click", () => {
        void router.replaceRoute({ kind: "view", view: "home" }, false);
        clearPasswordResetState();
        renderLogin();
    });
    document.querySelector("#password-reset-form")?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const newPassword = String(form.get("newPassword") ?? "");
        const confirmPassword = String(form.get("confirmPassword") ?? "");
        if (newPassword !== confirmPassword) {
            renderPasswordResetPage("As senhas não conferem.");
            return;
        }
        try {
            await api(`/api/password-reset/${encodeURIComponent(passwordResetTokenPath)}`, {
                method: "POST",
                body: JSON.stringify({ newPassword })
            });
            void router.replaceRoute({ kind: "view", view: "home" }, false);
            clearPasswordResetState();
            renderLogin("Senha alterada. Faça login novamente.");
        }
        catch (resetError) {
            renderPasswordResetPage(resetError instanceof Error ? resetError.message : "Não foi possível alterar a senha.");
        }
    });
}
function renderInitialSetup(error = "") {
    app.innerHTML = `
    <main class="login-shell">
      <form class="login-panel invite-panel" id="setup-form">
        <h1 class="brand">Pugotiread</h1>
        <p class="muted">Criar administrador inicial</p>
        <p class="google-unavailable">Nenhuma conta de administrador válida foi configurada ainda. Esta tela cria a primeira conta com acesso total.</p>
        <label class="form-row">
          <span>Usuário</span>
          <input class="input" name="username" autocomplete="username" maxlength="40" placeholder="admin" required autofocus />
        </label>
        <label class="form-row">
          <span>Nome público</span>
          <input class="input" name="displayName" autocomplete="name" maxlength="80" placeholder="Administrador" required />
        </label>
        <label class="form-row">
          <span>E-mail</span>
          <input class="input" name="email" type="email" autocomplete="email" placeholder="admin@local" required />
        </label>
        <label class="form-row">
          <span>Senha</span>
          <input class="input" name="password" type="password" autocomplete="new-password" minlength="12" required />
        </label>
        <p class="error">${escapeHtml(error)}</p>
        <div class="invite-form-actions">
          <button class="button secondary" id="back-to-login" type="button">Usar conta existente</button>
          <button class="button" type="submit">Criar administrador</button>
        </div>
      </form>
    </main>
  `;
    document.querySelector("#back-to-login")?.addEventListener("click", () => {
        renderLogin();
    });
    document.querySelector("#setup-form")?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        try {
            const payload = await api("/api/setup/admin", {
                method: "POST",
                body: JSON.stringify({
                    username: String(form.get("username") ?? ""),
                    displayName: String(form.get("displayName") ?? ""),
                    email: String(form.get("email") ?? ""),
                    password: String(form.get("password") ?? "")
                })
            });
            state.user = payload.user;
            state.setupRequired = false;
            if (state.user.needsNickname) {
                renderNicknameSetup();
                return;
            }
            await loadHome();
        }
        catch (setupError) {
            renderInitialSetup(setupError instanceof Error ? setupError.message : "Não foi possível criar o administrador.");
        }
    });
}
function renderInviteRegistration() {
    const invitation = state.inviteData;
    if (state.inviteCreateAccountOpen) {
        renderInviteAccountCreation(invitation);
        return;
    }
    app.innerHTML = `
    <main class="login-shell">
      <form class="login-panel invite-panel" id="invite-form">
        <h1 class="brand">Pugotiread</h1>
        <p class="muted">Entrar com convite</p>
        ${invitation
        ? `
              <p class="invite-summary">${escapeHtml(invitation.displayName)} / ${escapeHtml(invitation.email)}</p>
            `
        : ""}
        <button class="invite-create-link" id="open-invite-create-account" type="button">Criar conta</button>
        <div class="login-divider"><span>ou</span></div>
        <div class="google-button-slot" id="google-invite-button"></div>
        <p class="error">${escapeHtml(state.inviteError)}</p>
      </form>
    </main>
  `;
    document.querySelector("#open-invite-create-account")?.addEventListener("click", () => {
        state.inviteCreateAccountOpen = true;
        state.inviteError = "";
        renderInviteRegistration();
    });
    document.querySelector("#invite-form")?.addEventListener("submit", async (event) => {
        event.preventDefault();
    });
    void mountGoogleButton("google-invite-button", async (credential) => {
        try {
            const payload = await api("/api/auth/google", {
                method: "POST",
                body: JSON.stringify({
                    credential,
                    inviteToken: state.invitePathToken
                })
            });
            state.user = payload.user;
            state.inviteData = null;
            state.inviteError = "";
            if (state.user.needsNickname) {
                renderNicknameSetup();
                return;
            }
            await loadHome();
        }
        catch (inviteError) {
            state.inviteError = inviteError instanceof Error ? inviteError.message : "Não foi possível concluir o cadastro com Google.";
            renderInviteRegistration();
        }
    }, "Login com Google ainda não configurado.");
}
function renderInviteAccountCreation(invitation) {
    app.innerHTML = `
    <main class="login-shell">
      <form class="login-panel invite-panel" id="invite-create-form">
        <h1 class="brand">Pugotiread</h1>
        <p class="muted">Criar conta</p>
        <label class="form-row">
          <span>Nickname</span>
          <input class="input" name="nickname" maxlength="40" autocomplete="nickname" placeholder="Seu nome público" required />
        </label>
        <label class="form-row">
          <span>E-mail</span>
          <input class="input" name="email" type="email" autocomplete="email" value="${escapeHtml(invitation?.email ?? "")}" ${invitation?.email ? "readonly" : ""} required />
        </label>
        <label class="form-row">
          <span>Senha</span>
          <input class="input" name="password" type="password" autocomplete="new-password" required />
        </label>
        <p class="error">${escapeHtml(state.inviteError)}</p>
        <div class="invite-form-actions">
          <button class="button secondary" id="back-to-google-invite" type="button">Voltar</button>
          <button class="button" type="submit">Criar conta</button>
        </div>
      </form>
    </main>
  `;
    document.querySelector("#back-to-google-invite")?.addEventListener("click", () => {
        state.inviteCreateAccountOpen = false;
        state.inviteError = "";
        renderInviteRegistration();
    });
    document.querySelector("#invite-create-form")?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        try {
            const payload = await api(`/api/invites/${encodeURIComponent(state.invitePathToken ?? "")}`, {
                method: "POST",
                body: JSON.stringify({
                    nickname: String(form.get("nickname") ?? ""),
                    email: String(form.get("email") ?? ""),
                    password: String(form.get("password") ?? "")
                })
            });
            state.user = payload.user;
            state.inviteData = null;
            state.inviteError = "";
            state.inviteCreateAccountOpen = false;
            await loadHome();
        }
        catch (error) {
            state.inviteError = error instanceof Error ? error.message : "Não foi possível criar a conta.";
            renderInviteAccountCreation(invitation);
        }
    });
}
function renderNicknameSetup(error = "") {
    const user = state.user;
    app.innerHTML = `
    <main class="login-shell">
      <form class="login-panel invite-panel" id="nickname-form">
        <h1 class="brand">Pugotiread</h1>
        <p class="muted">Digite seu nickname</p>
        <label class="form-row">
          <span>Nickname</span>
          <input class="input" name="nickname" maxlength="40" autocomplete="nickname" placeholder="Seu nome público" required autofocus />
        </label>
        <p class="error">${escapeHtml(error)}</p>
        <button class="button" type="submit">Entrar</button>
      </form>
    </main>
  `;
    document.querySelector("#nickname-form")?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        const nickname = String(formData.get("nickname") ?? "").trim();
        if (!nickname || nickname.length > 40) {
            renderNicknameSetup("Escolha um nickname com até 40 caracteres.");
            return;
        }
        try {
            const payload = await api("/api/me/profile", {
                method: "PATCH",
                body: JSON.stringify({
                    avatarUrl: user?.avatarUrl ?? "",
                    nickname,
                    biography: user?.biography ?? "",
                    location: user?.location ?? "",
                    favoriteContentIds: user?.favoriteContentIds ?? []
                })
            });
            state.user = payload.user;
            await loadHome();
        }
        catch (error) {
            renderNicknameSetup(error instanceof Error ? error.message : "Não foi possível salvar o nickname.");
        }
    });
}
function renderShell() {
    if (state.reader?.content.pageTypes.includes("epub")) {
        const currentFrame = document.querySelector(".reader-epub");
        if (currentFrame && Number(currentFrame.dataset.readerPageIndex) === state.reader.page) {
            state.reader.epubOffset = getEpubCurrentOffset(currentFrame);
        }
    }
    releaseReaderImageWindow?.();
    releaseReaderImageWindow = null;
    if (routeLoading) {
        renderLoadingScreen(routeLoadingMensagem);
        return;
    }
    const activeLibrary = [...state.libraries, ...state.personalLibraries].find((library) => library.id === state.activeLibraryId);
    const activeSeries = getSelectedSeries();
    const filtered = filterContents(state.contents, state.search);
    const userName = state.user?.nickname || state.user?.displayName || state.user?.username || "Usuário";
    const mobileNavOpen = state.mobileNavOpen && isMobileViewport();
    document.documentElement.classList.toggle("mobile-menu-open", mobileNavOpen);
    document.body.classList.toggle("mobile-menu-open", mobileNavOpen);
    const readerRestorePage = state.reader?.mode === "vertical-scroll" && !state.reader.content.pageTypes.includes("pdf")
        ? (getVisibleReaderPage() ?? state.reader.page)
        : null;
    app.innerHTML = `
    <div class="app-shell${state.activeView === "settings" ? " settings-shell" : ""}${state.sidebarCollapsed ? " sidebar-collapsed" : ""}${mobileNavOpen ? " mobile-nav-open" : ""}${state.reader ? " reader-active" : ""}">
      ${renderTopbar(userName)}
      <aside class="sidebar">
        ${state.activeView === "settings" ? renderGroupedSettingsSidebar() : renderSidebar()}
      </aside>
      ${mobileNavOpen ? `<button class="mobile-nav-backdrop" id="mobile-nav-backdrop" type="button" aria-label="Fechar menu"></button>` : ""}
      <main class="main">
        ${state.reader
        ? renderReader(state.reader.content, state.reader.page, state.reader.mode)
        : renderMainView(activeLibrary, filtered, activeSeries)}
      </main>
      ${state.libraryModalOpen ? renderLibraryModal() : ""}
      ${state.collectionModalOpen ? renderCollectionModal() : ""}
      ${state.collectionShareModalOpen ? renderCollectionShareModal() : ""}
      ${state.deletingCollectionId ? renderCollectionDeleteModal() : ""}
      ${state.adminUserModalOpen ? renderAdminUserModal() : ""}
      ${state.adminUserDeleteId ? renderUserDeleteModal() : ""}
      ${globalSearchOpen && !state.reader ? renderGlobalSearchModal() : ""}
    </div>
  `;
    bindShellEvents();
    if (state.reader) {
        renderReaderOverlay();
        bindReaderPdfHomeButton();
        bindReaderEpubFrames();
        bindReaderEpubSearch();
        bindReaderMediaLoadState();
        bindReaderPdfViewer();
        const imageStage = document.getElementById("reader-stage");
        if (imageStage && state.reader.mode === "vertical-scroll")
            releaseReaderImageWindow = observeReaderImages(imageStage);
        preloadAdjacentReaderPages(state.reader.content, state.reader.page);
        if (readerRestorePage !== null && state.reader.mode === "vertical-scroll" && !state.reader.content.pageTypes.includes("epub")) {
            requestAnimationFrame(() => scrollReaderToPage(readerRestorePage));
        }
    }
}
// Menu changes must not recreate cards, PDF canvases, EPUB frames or their listeners.
const menuMarkup = new WeakMap();
function syncFloatingMenu(trigger, host, selector, markup) {
    if (!host)
        return;
    const previous = host.querySelector(`:scope > ${selector}`);
    trigger?.setAttribute("aria-expanded", String(Boolean(markup)));
    if (!markup) {
        const hadFocus = previous?.contains(document.activeElement);
        previous?.remove();
        if (hadFocus)
            trigger?.focus({ preventScroll: true });
        return;
    }
    if (previous && menuMarkup.get(previous) === markup)
        return;
    const focused = previous?.contains(document.activeElement) ? document.activeElement : null;
    const focusSelector = focused instanceof HTMLElement
        ? Array.from(focused.attributes).filter(attribute => attribute.name === "id" || attribute.name.startsWith("data-"))
            .map(attribute => `[${attribute.name}="${CSS.escape(attribute.value)}"]`).join("")
        : "";
    const template = document.createElement("template");
    template.innerHTML = markup.trim();
    const next = template.content.firstElementChild;
    if (!next)
        return;
    menuMarkup.set(next, markup);
    if (previous)
        previous.replaceWith(next);
    else
        host.append(next);
    bindShellEvents(next);
    if (focused)
        (focusSelector ? next.querySelector(focusSelector) ?? trigger : trigger)?.focus({ preventScroll: true });
}
function updateNavigationLayout() {
    const open = state.mobileNavOpen && isMobileViewport();
    document.documentElement.classList.toggle("mobile-menu-open", open);
    document.body.classList.toggle("mobile-menu-open", open);
    const shell = document.querySelector(".app-shell");
    shell?.classList.toggle("mobile-nav-open", open);
    shell?.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
    document.querySelector("#menu-button")?.setAttribute("aria-expanded", String(isMobileViewport() ? open : !state.sidebarCollapsed));
    const backdrop = document.querySelector("#mobile-nav-backdrop");
    if (!open)
        backdrop?.remove();
    else if (!backdrop && shell) {
        const button = document.createElement("button");
        button.id = "mobile-nav-backdrop";
        button.className = "mobile-nav-backdrop";
        button.type = "button";
        button.setAttribute("aria-label", "Fechar menu");
        button.addEventListener("click", () => { closeMobileNavigation(); updateNavigationLayout(); });
        shell.append(button);
    }
}
function renderNavigationMenus() {
    const userName = state.user?.nickname || state.user?.displayName || state.user?.username || "Usuário";
    syncFloatingMenu(document.querySelector("#account-button"), document.querySelector(".account-menu-shell"), "#account-menu", state.accountMenuOpen ? renderAccountMenu(userName) : "");
    syncFloatingMenu(document.querySelector("#stats-button"), document.querySelector(".stats-menu-shell"), "#stats-menu", state.statsMenuOpen ? renderStatsMenu() : "");
    const nav = document.querySelector("#mobile-sidebar");
    const vault = nav?.querySelector(".vault-nav-item");
    if (state.user?.role !== "admin" || state.vaultHiddenFromMenu)
        vault?.remove();
    else if (nav && !vault) {
        const template = document.createElement("template");
        template.innerHTML = renderVaultNavButton().trim();
        const next = template.content.firstElementChild;
        nav.insertBefore(next, nav.querySelector('[data-nav-view="people"]'));
        bindShellEvents(next);
    }
    syncFloatingMenu(document.querySelector("[data-vault-menu]"), document.querySelector(".vault-nav-item"), ".library-context-menu", state.vaultMenuOpen && !state.vaultHiddenFromMenu ? renderVaultContextMenu() : "");
    const librarySelector = '[data-library-menu-id][aria-expanded="true"]' + (state.openLibraryMenuId ? `, [data-library-menu-id="${CSS.escape(state.openLibraryMenuId)}"]` : "");
    document.querySelectorAll(librarySelector).forEach(button => {
        const library = state.libraries.find(item => item.id === button.dataset.libraryMenuId);
        syncFloatingMenu(button, button.closest(".library-nav-item"), ".library-context-menu", library && state.openLibraryMenuId === library.id ? renderLibraryContextMenu(library) : "");
    });
    const seriesSelector = '[data-series-menu-key][aria-expanded="true"]' + (state.openSeriesMenuId ? `, [data-series-menu-key="${CSS.escape(state.openSeriesMenuId)}"]` : "");
    document.querySelectorAll(seriesSelector).forEach(button => {
        const card = button.closest(".series-card");
        const id = card?.querySelector("[data-series-open]")?.dataset.seriesOpen;
        const content = id ? findContentById(id) : null;
        const key = button.dataset.seriesMenuKey ?? "";
        syncFloatingMenu(button, card, ".series-context-menu", content && state.openSeriesMenuId === key ? renderSeriesContextMenu(content, key) : "");
    });
    updateNavigationLayout();
}
function renderMainView(activeLibrary, contents, activeSeries) {
    if (activeSeries) {
        return renderSeriesView(activeSeries, activeLibrary);
    }
    if (state.activeView === "library") {
        return withFolderActionBar(renderLibraryView(activeLibrary, contents));
    }
    if (state.activeView === "bookmarks") {
        return renderMarkedPagesView();
    }
    if (state.activeView === "home") {
        return renderHomeView();
    }
    if (state.activeView === "all") {
        const contents = filterContents(state.homeContents, state.search);
        return `
      <section class="section-heading">
        <div>
          <h2>Todos os títulos</h2>
          <p class="muted">Todos os conteúdos disponíveis nas bibliotecas permitidas.</p>
        </div>
        <span class="muted">${contents.length} títulos</span>
      </section>
      ${contents.length ? `<section class="content-grid">${contents.map((content, index) => renderSeriesCard(content, `all-${content.id}-${index}`)).join("")}</section>` : state.search ? renderNoSearchResults() : renderEmptyMedia()}
    `;
    }
    if (state.activeView === "vault") {
        return renderVaultView();
    }
    if (state.activeView === "want") {
        return renderReadingNowView();
    }
    if (state.activeView === "lists") {
        return renderContentListView("Lista de leitura", "Fila de leitura pessoal na ordem em que as obras foram adicionadas.", getContentsByIds(state.readingList));
    }
    if (state.activeView === "collections") {
        return renderCollectionsView();
    }
    if (state.activeView === "people") {
        return renderPeopleView();
    }
    if (state.activeView === "profile") {
        return renderProfileView();
    }
    if (state.activeView === "settings") {
        return renderSettingsView();
    }
    const labels = {
        home: "Início",
        want: "Lendo agora",
        collections: "Coleções",
        lists: "Listas de leitura",
        bookmarks: "Marcadores",
        all: "Todos os títulos",
        vault: "Cofre pessoal",
        people: "Pessoas",
        library: "Biblioteca",
        profile: "Minhas Reviews",
        settings: "Configurações"
    };
    return renderPlaceholderView(labels[state.activeView], "Esta área está reservada para a próxima etapa da interface.");
}
function renderReadingNowView() {
    const readingNowContents = getReadingNowContents();
    const publicContentIds = new Set(readingNowContents.map((content) => content.id));
    const contentIds = state.progress
        .filter((progress) => publicContentIds.has(progress.contentId))
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .map((progress) => progress.contentId);
    return renderContentListView("Lendo agora", "Obras com progresso salvo, ordenadas pela última leitura.", getContentsByIdsFrom(readingNowContents, contentIds));
}
function renderSettingsView() {
    const sectionTitle = getSettingsSectionTitle();
    return `
    <section class="settings-content">
      <h1>${escapeHtml(sectionTitle)}</h1>
      ${renderSettingsSection()}
    </section>
  `;
}
function renderVaultView() {
    if (!state.vaultUnlocked) {
        return `
      <section class="settings-content vault-content">
        <h1>Cofre pessoal</h1>
        <p class="settings-lead">Confirme sua senha para acessar bibliotecas pessoais ocultas.</p>
        <form class="vault-unlock-form" id="vault-unlock-form">
          <label class="form-row">
            <span>Senha</span>
            <input class="input" id="vault-password-input" name="password" type="password" autocomplete="current-password" required />
          </label>
          ${state.vaultError ? `<p class="error vault-error">${escapeHtml(state.vaultError)}</p>` : ""}
          <button class="button" type="submit">Desbloquear cofre</button>
        </form>
      </section>
    `;
    }
    const contents = state.contents.filter((content) => state.personalLibraries.some((library) => library.id === content.libraryId));
    return `
    <section class="section-heading">
      <div>
        <h2>Cofre pessoal</h2>
        <p class="muted">Bibliotecas pessoais ficam ocultas fora desta área.</p>
      </div>
      <div class="vault-heading-actions">
        <button class="icon-button vault-lock-button" id="lock-vault-button" type="button" title="Bloquear cofre" aria-label="Bloquear cofre">${renderSidebarIcon("vaultClosed", "Bloquear cofre")}</button>
        <button class="button" id="add-personal-library-button" type="button">+ Biblioteca pessoal</button>
      </div>
    </section>
    ${state.personalLibraries.length
        ? `<section class="library-vault-list">${state.personalLibraries.map(renderPersonalLibraryRow).join("")}</section>`
        : `<p class="empty">Nenhuma biblioteca pessoal cadastrada.</p>`}
    ${contents.length ? `<section class="content-grid">${contents.map((content, index) => renderSeriesCard(content, `vault-${content.id}-${index}`)).join("")}</section>` : ""}
  `;
}
function renderPersonalLibraryRow(library) {
    const contentCount = state.contents.filter((content) => content.libraryId === library.id).length;
    return `
    <article class="personal-library-row">
      <button class="personal-library-main" data-library-id="${escapeHtml(library.id)}" type="button">
        <span class="nav-icon" aria-hidden="true">${renderIcon("lock")}</span>
        <strong>${escapeHtml(library.name)}</strong>
        <span>${contentCount} títulos</span>
      </button>
      <div class="personal-library-actions">
        <button class="icon-button" data-edit-personal-library="${escapeHtml(library.id)}" type="button" title="Editar biblioteca" aria-label="Editar biblioteca">${renderSidebarIcon("pencil", "Editar biblioteca")}</button>
        <button class="icon-button danger" data-delete-personal-library="${escapeHtml(library.id)}" type="button" title="Apagar biblioteca" aria-label="Apagar biblioteca">${renderSidebarIcon("trash", "Apagar biblioteca")}</button>
      </div>
    </article>
  `;
}
function renderProfileView() {
    // Perfil, avatar, senha e obras favoritas ficam no Pugoti Profile (pugotilab.com/auth/profile, 04/11/2026);
    // aqui fica só o que é do Pugotiread: as reviews publicadas.
    return `
    <section class="profile-page reviews-page">
      <section class="settings-panel">
        <div class="series-section-heading">
          <h1>Minhas Reviews</h1>
          <span>${state.profileReviews.length}</span>
        </div>
        ${state.profileReviews.length
        ? `<div class="profile-review-list">${state.profileReviews.map(renderProfileReview).join("")}</div>`
        : `<p class="empty compact">Nenhuma review publicada ainda.</p>`}
        <p class="reviews-profile-link">Para editar nome, foto, senha e obras favoritas, use o <a href="${escapeHtml(pugotiProfileUrl())}">Perfil Pugotilab</a>.</p>
      </section>
    </section>
  `;
}
function pugotiProfileUrl() {
    return `https://pugotilab.com/auth/profile?return=${encodeURIComponent(window.location.href)}`;
}
function renderProfileForm(favorites) {
    const user = state.user;
    const selectedIds = user?.favoriteContentIds ?? [];
    return `
    <form class="profile-form" id="profile-form">
      <section class="settings-panel">
        <div class="series-section-heading">
          <h2>Editar perfil</h2>
          <button class="button secondary" id="cancel-profile-edit" type="button">Cancelar</button>
        </div>
        <label class="form-row">
            <span>Avatar</span>
            <input class="input" id="profile-avatar-input" name="avatar" type="file" accept="image/*" />
        </label>
        ${user?.avatarUrl ? `<button class="button secondary" id="remove-profile-avatar" type="button">Remover avatar</button>` : ""}
        <label class="form-row">
            <span>Nickname</span>
            <input class="input" name="nickname" maxlength="40" value="${escapeHtml(user?.nickname ?? "")}" placeholder="Seu nome público" />
        </label>
        <label class="form-row">
            <span>Biografia</span>
            <textarea class="input" name="biography" maxlength="280" rows="4" placeholder="Conte um pouco sobre você">${escapeHtml(user?.biography ?? "")}</textarea>
        </label>
        <label class="form-row">
            <span>Local onde mora</span>
            <input class="input" name="location" maxlength="80" value="${escapeHtml(user?.location ?? "")}" placeholder="Cidade, Estado" />
        </label>
        <label class="form-row">
            <span>3 obras preferidas</span>
            <input class="input" id="profile-favorite-search" value="${escapeHtml(state.profileFavoriteSearch)}" placeholder="Pesquisar obra para fixar" autocomplete="off" />
        </label>
        <div class="profile-favorite-picker">
          <div class="profile-favorite-selected">
              ${favorites.length
        ? favorites.map((content) => `
                      <span class="profile-favorite-chip">
                        ${escapeHtml(content.title)}
                        <button data-remove-profile-favorite="${escapeHtml(content.id)}" type="button" aria-label="Remover ${escapeHtml(content.title)}">×</button>
                      </span>
                    `).join("")
        : `<span class="muted">Nenhuma obra selecionada.</span>`}
          </div>
          <div id="profile-favorite-results">
            ${renderProfileFavoriteResults(selectedIds)}
          </div>
          ${selectedIds.map((contentId) => `<input type="hidden" name="favoriteContentIds" value="${escapeHtml(contentId)}" />`).join("")}
        </div>
        ${state.profileError ? `<p class="error">${escapeHtml(state.profileError)}</p>` : ""}
        <div class="profile-actions">
          <button class="button" type="submit">Salvar perfil</button>
        </div>
      </section>
    </form>
  `;
}
function renderProfilePasswordSection() {
    const user = state.user;
    if (!user) {
        return "";
    }
    if (!user.canChangePassword) {
        return `
      <section class="settings-panel">
        <div class="series-section-heading">
          <h2>Senha</h2>
        </div>
        <p class="empty compact">Esta conta não pode alterar a própria senha.</p>
      </section>
    `;
    }
    if (user.passwordChangeRequiresEmailConfirmation) {
        return `
      <section class="settings-panel">
        <div class="series-section-heading">
          <h2>Senha</h2>
        </div>
        <p class="settings-lead">Esta conta confirma a troca por e-mail antes da senha ser alterada.</p>
        <button class="button" id="request-profile-password-reset" type="button">Enviar link para meu e-mail</button>
        ${state.profilePasswordMessage ? `<p class="scan-message" id="profile-password-message">${escapeHtml(state.profilePasswordMessage)}</p>` : ""}
        ${state.profilePasswordError ? `<p class="error" id="profile-password-error">${escapeHtml(state.profilePasswordError)}</p>` : ""}
      </section>
    `;
    }
    return `
    <form class="settings-panel" id="profile-password-form">
      <div class="series-section-heading">
        <h2>Senha</h2>
      </div>
      <div class="profile-password-grid">
        <label class="form-row">
          <span>Senha atual</span>
          <input class="input" name="currentPassword" type="password" autocomplete="current-password" required />
        </label>
        <label class="form-row">
          <span>Nova senha</span>
          <input class="input" name="newPassword" type="password" autocomplete="new-password" minlength="12" required />
        </label>
        <label class="form-row">
          <span>Confirmar nova senha</span>
          <input class="input" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" required />
        </label>
      </div>
      ${state.profilePasswordError ? `<p class="error">${escapeHtml(state.profilePasswordError)}</p>` : ""}
      ${state.profilePasswordMessage ? `<p class="scan-message">${escapeHtml(state.profilePasswordMessage)}</p>` : ""}
      <div class="profile-actions">
        <button class="button" type="submit">Alterar senha</button>
      </div>
    </form>
  `;
}
function renderProfileFavorite(content) {
    return `
    <article class="profile-favorite-card">
      ${content.coverUrl
        ? `<img src="${escapeHtml(content.coverUrl)}" alt="Capa de ${escapeHtml(content.title)}" />`
        : `<div class="cover-placeholder">${escapeHtml(content.title.slice(0, 1).toUpperCase())}</div>`}
      <strong>${escapeHtml(content.title)}</strong>
    </article>
  `;
}
function renderProfileReview(review) {
    const content = findPublicContentById(review.contentId);
    return `
    <article class="profile-review-card">
      ${content?.coverUrl
        ? `<img src="${escapeHtml(content.coverUrl)}" alt="Capa de ${escapeHtml(content.title)}" />`
        : `<div class="cover-placeholder">${escapeHtml((content?.title ?? "R").slice(0, 1).toUpperCase())}</div>`}
      <div>
        <div class="profile-review-header">
          <strong>${escapeHtml(content?.title ?? "Obra indisponível")}</strong>
          ${renderEstrelasReview(review.rating)}
        </div>
        <p>${escapeHtml(review.comment)}</p>
        <small>${escapeHtml(new Date(review.updatedAt).toLocaleString("pt-BR"))}</small>
      </div>
    </article>
  `;
}
function renderProfileFavoriteResults(selectedIds) {
    const selected = new Set(selectedIds);
    const query = normalizeText(state.profileFavoriteSearch);
    if (!query) {
        return `<p class="empty compact">Digite para buscar uma obra.</p>`;
    }
    const results = getPublicContents()
        .filter((content) => !selected.has(content.id) && normalizeText(content.title).includes(query))
        .slice(0, 8);
    if (selected.size >= 3) {
        return `<p class="empty compact">Limite de 3 obras preferidas atingido.</p>`;
    }
    if (results.length === 0) {
        return `<p class="empty compact">Nenhuma obra encontrada.</p>`;
    }
    return `
    <div class="profile-favorite-results">
      ${results.map((content) => `
        <button class="profile-favorite-result" data-add-profile-favorite="${escapeHtml(content.id)}" type="button">
          ${content.coverUrl
        ? `<img src="${escapeHtml(content.coverUrl)}" alt="" />`
        : `<span>${escapeHtml(content.title.slice(0, 1).toUpperCase())}</span>`}
          <strong>${escapeHtml(content.title)}</strong>
        </button>
      `).join("")}
    </div>
  `;
}
function updateProfileFavoriteResults() {
    const container = document.querySelector("#profile-favorite-results");
    if (!container) {
        return;
    }
    const selectedIds = state.user?.favoriteContentIds ?? [];
    container.innerHTML = renderProfileFavoriteResults(selectedIds);
}
function getSettingsSectionTitle() {
    const titles = {
        account: "Conta",
        aparencia: "Aparência",
        download: "Download",
        server: state.serverSection === "users"
            ? "Usuários"
            : state.serverSection === "sync"
                ? "Sincronizar"
                : state.serverSection === "sheets"
                    ? "Fichas preenchidas"
                : state.serverSection === "startup"
                    ? "Página inicial"
                : state.serverSection === "vault"
                    ? "Cofre pessoal"
                    : state.serverSection === "reading"
                        ? "Modo de leitura"
                        : "Bibliotecas"
    };
    return titles[state.settingsSection];
}
function renderSettingsSection() {
    // Temas Pugotilab (PQA-286): o seletor vem do pugoti-conta.js, encaixado em [data-pugoti-aparencia].
    if (state.settingsSection === "aparencia") {
        return `<div class="settings-panel pugoti-aparencia" data-pugoti-aparencia></div>`;
    }
    if (state.settingsSection === "download") {
        return state.user?.role === "admin" || state.user?.role === "superuser"
            ? renderDownloadSettings()
            : `<p class="empty">Esta área é exclusiva para administradores.</p>`;
    }
    if (state.settingsSection === "server") {
        if (state.user?.role !== "admin") {
            return `<p class="empty">Esta área é exclusiva para administradores.</p>`;
        }
        if (state.serverSection === "users")
            return renderUsersSettings();
        if (state.serverSection === "sync")
            return renderSyncSettings();
        if (state.serverSection === "vault")
            return renderVaultSettings();
        if (state.serverSection === "reading")
            return renderReadingModeSettings();
        if (state.serverSection === "sheets")
            return renderPdfSheetsSettings();
        if (state.serverSection === "startup")
            return renderStartupSettings().replace('<section class="startup-settings"><h3>Página inicial</h3>', '<section class="startup-settings startup-settings-page">');
        return renderLibrariesSettings();
    }
    return `
    <p class="settings-lead">Dados básicos da conta logada.</p>
    <div class="settings-panel">
      <div class="settings-row">
        <span>Usuário</span>
        <strong>${escapeHtml(state.user?.displayName ?? "Usuário")}</strong>
      </div>
      <div class="settings-row">
        <span>Tipo</span>
        <strong>${escapeHtml(state.user?.role === "admin" ? "Administrador" : state.user?.role === "superuser" ? "Superuser" : "Usuário padrão")}</strong>
      </div>
    </div>
  `;
}
function renderLibrariesSettings() {
    return `
    <div class="settings-toolbar">
      <p class="settings-lead">Bibliotecas cadastradas pelo administrador. Cada biblioteca aponta para uma pasta real montada no servidor.</p>
      <button class="button" id="add-library-button" type="button">+ Adicionar biblioteca</button>
    </div>
    ${state.scanMessage ? `<p class="scan-message">${escapeHtml(state.scanMessage)}</p>` : ""}
    ${state.libraries.length
        ? `<div class="library-settings-list">${state.libraries.map(renderLibrarySettingsRow).join("")}</div>`
        : `<p class="empty">Nenhuma biblioteca cadastrada. Crie uma biblioteca apontando para uma pasta dentro de /media.</p>`}
  `;
}
// Pastas de um sistema de RPG (ex.: "Fichas") viram botões à direita, na mesma linha do caminho.
// O views/library.js vem da imagem; aqui só se junta o caminho e as subpastas numa barra.
const FOLDER_BUTTON_ICON = '<svg class="library-folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3v4a1 1 0 0 0 1 1h4M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2zM9 13h6M9 17h6"/></svg>';
// fichas automatizadas de RPG (PQA-295): ao lado do botão "Fichas" de um sistema de RPG, abre /fichas.
const FICHAS_AUTO_ICON = '<svg class="library-folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2zM9 7h6M9 11h6M9 15h4"/></svg>';
function fichasAutomaticasLink(links) {
    return />Fichas<\/a>/.test(links) ? `<a class="library-folder-link" href="/fichas" data-fichas-automaticas>${FICHAS_AUTO_ICON}Fichas automáticas</a>` : "";
}
function withFolderActionBar(html) {
    return html.replace(/(<nav class="library-breadcrumbs"[^>]*>[\s\S]*?<\/nav>)(<nav class="library-subfolders"[^>]*>)([\s\S]*?)(<\/nav>)/, (match, breadcrumbs, open, links, close) => links.trim()
        ? `<div class="library-folder-bar">${breadcrumbs}${open}${links.replace(/(<a class="library-folder-link[^"]*"[^>]*>)/g, `$1${FOLDER_BUTTON_ICON}`)}${fichasAutomaticasLink(links)}${close}</div>`
        : `<div class="library-folder-bar">${breadcrumbs}</div>`);
}
// ===== Fichas preenchidas (Configurações > Servidor) =====
// Menu de Configurações agrupado por assunto: Conta, Bibliotecas e Servidor.
// Substitui o do sidebar.js (que vem da imagem); usa os mesmos data-* e as mesmas permissões.
function renderGroupedSettingsSidebar() {
    const isAdmin = state.user?.role === "admin";
    const canDownload = isAdmin || state.user?.role === "superuser";
    const account = (section, label) => `<button class="settings-nav-button${state.settingsSection === section ? " active" : ""}" data-settings-section="${section}" type="button"${state.settingsSection === section ? ' aria-current="page"' : ""}>${escapeHtml(label)}</button>`;
    const server = (section, label) => {
        const active = state.settingsSection === "server" && state.serverSection === section;
        return `<button class="settings-nav-button${active ? " active" : ""}" data-server-section="${section}" type="button"${active ? ' aria-current="page"' : ""}>${escapeHtml(label)}</button>`;
    };
    const group = (title, items) => items.length ? `<div class="settings-group"><h3>${title}</h3>${items.join("")}</div>` : "";
    return `
    <nav class="settings-sidebar" aria-label="Configurações">
      ${group("Conta", [account("account", "Conta"), account("aparencia", "Aparência"), ...(isAdmin ? [server("vault", "Cofre pessoal")] : [])])}
      ${group("Bibliotecas", [
        ...(isAdmin ? [server("libraries", "Bibliotecas"), server("sheets", "Fichas preenchidas"), server("reading", "Modo de leitura"), server("sync", "Sincronizar")] : []),
        ...(canDownload ? [account("download", "Download")] : [])
    ])}
      ${isAdmin ? group("Servidor", [server("users", "Usuários"), server("startup", "Página inicial")]) : ""}
    </nav>
  `;
}
const SHEET_VISIBILITY = {
    private: { label: "Só o proprietário", short: "Só o dono", help: "Apenas o proprietário (e administradores) abre a ficha.", icon: "M5 13a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2zM8 11V7a4 4 0 1 1 8 0v4" },
    shared: { label: "Pessoas escolhidas", short: "Compartilhada", help: "O proprietário e as pessoas marcadas abaixo.", icon: "M9 7a4 4 0 1 0 0 8a4 4 0 0 0 0-8zM3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M16 3.13a4 4 0 0 1 0 7.75M21 21v-2a4 4 0 0 0-3-3.85" },
    public: { label: "Todos da biblioteca", short: "Todos", help: "Qualquer pessoa com acesso à biblioteca da ficha.", icon: "M3 12a9 9 0 1 0 18 0a9 9 0 0 0-18 0zM3.6 9h16.8M3.6 15h16.8M11.5 3a17 17 0 0 0 0 18M12.5 3a17 17 0 0 1 0 18" }
};
function renderSheetIcon(path, className = "sheet-svg") {
    return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
}
const SHEET_FILE_ICON = "M14 3v4a1 1 0 0 0 1 1h4M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2zM9 13h6M9 17h6M9 9h1";
// "Tormenta RPG/Fichas" e "Tormenta RPG/Fichas de Usuários/sekiro" viram "Tormenta RPG": as pastas de organização
// (Fichas, Módulos Básicos, Submódulos, Fichas Padrão, Fichas de Usuários/<usuário>) não dizem nada sobre o sistema.
const PASTAS_DE_ORGANIZACAO_RPG = new Set(["fichas", "ficha", "módulos básicos", "submódulos", "fichas padrão", "fichas de usuários"]);
function sheetSystemLabel(system) {
    const parts = String(system || "").split("/").map(part => part.trim()).filter(Boolean);
    const corte = parts.findIndex(part => PASTAS_DE_ORGANIZACAO_RPG.has(part.normalize("NFC").toLocaleLowerCase("pt-BR")));
    return (corte < 0 ? parts : parts.slice(0, corte)).join(" / ") || "Sem sistema";
}
function sheetOwner(copy) {
    return state.adminUsers.find(person => person.id === copy.ownerUserId) ?? null;
}
function sheetPersonName(person) {
    return person?.displayName || person?.username || "Usuário removido";
}
function sheetFileTitle(copy) {
    const content = state.homeContents.find(item => item.id === copy.contentId);
    return content?.fileTitle ?? copy.title ?? content?.title ?? "Ficha PDF";
}
// Nome mostrado: o personagem preenchido na ficha, com o sistema entre parênteses; sem nome, o arquivo.
function sheetTitle(copy) {
    return copy.characterName || sheetFileTitle(copy);
}
function sheetFullTitle(copy) {
    const system = sheetSystemLabel(copy.system);
    return copy.characterName && system !== "Sem sistema" ? `${copy.characterName} (${system})` : sheetTitle(copy);
}
function sheetVisibilityText(copy) {
    if (copy.visibility === "shared") {
        const total = copy.sharedWithUserIds.filter(id => id !== copy.ownerUserId).length;
        return total ? `Compartilhada com ${total} ${total === 1 ? "pessoa" : "pessoas"}` : "Compartilhada com ninguém";
    }
    return SHEET_VISIBILITY[copy.visibility]?.label ?? "Só o proprietário";
}
function renderPdfSheetCard(copy) {
    const owner = sheetOwner(copy);
    const title = sheetFullTitle(copy);
    const fileTitle = sheetFileTitle(copy);
    const system = sheetSystemLabel(copy.system);
    const visibility = SHEET_VISIBILITY[copy.visibility] ? copy.visibility : "private";
    const canOpen = Boolean(findContentById(copy.contentId));
    const search = `${title} ${fileTitle} ${sheetPersonName(owner)} ${owner?.username ?? ""} ${system}`.toLocaleLowerCase("pt-BR");
    return `<article class="sheet-card" data-sheet-id="${escapeHtml(copy.contentId)}" data-sheet-visibility="${visibility}" data-sheet-search="${escapeHtml(search)}">
      <span class="sheet-card-icon">${renderSheetIcon(SHEET_FILE_ICON)}</span>
      <div class="sheet-card-main">
        <strong class="sheet-card-title" title="${escapeHtml(title)}">${copy.characterName ? `${escapeHtml(copy.characterName)}${system !== "Sem sistema" ? ` <span class="sheet-card-system">(${escapeHtml(system)})</span>` : ""}` : escapeHtml(title)}</strong>
        <span class="sheet-card-owner">${renderAvatar(owner ?? { displayName: "?" }, "avatar sheet-avatar")}<span class="sheet-card-owner-name">${escapeHtml(sheetPersonName(owner))}</span>${copy.characterName ? `<span class="sheet-card-file" title="Arquivo: ${escapeHtml(fileTitle)}">${renderSheetIcon(SHEET_FILE_ICON)}<span>${escapeHtml(fileTitle)}</span></span>` : ""}</span>
      </div>
      <span class="sheet-badge sheet-badge-${visibility}">${renderSheetIcon(SHEET_VISIBILITY[visibility].icon)}<span>${escapeHtml(sheetVisibilityText(copy))}</span></span>
      <div class="sheet-card-actions">
        ${canOpen ? `<button class="button secondary sheet-open" data-sheet-open="${escapeHtml(copy.contentId)}" type="button" aria-label="Abrir ${escapeHtml(title)}">Abrir</button>` : ""}
        <button class="button sheet-edit" data-sheet-edit="${escapeHtml(copy.contentId)}" type="button" aria-label="Editar acesso de ${escapeHtml(title)}">Editar acesso</button>
      </div>
    </article>`;
}
function renderPdfSheetsSettings() {
    const copies = [...state.pdfFormCopies].sort((a, b) => sheetTitle(a).localeCompare(sheetTitle(b), "pt-BR", { numeric: true }));
    const groups = new Map();
    for (const copy of copies) {
        const label = sheetSystemLabel(copy.system);
        if (!groups.has(label))
            groups.set(label, []);
        groups.get(label).push(copy);
    }
    const ordered = [...groups.entries()].sort(([a], [b]) => (a === "Sem sistema") - (b === "Sem sistema") || a.localeCompare(b, "pt-BR"));
    const count = (visibility) => copies.filter(copy => copy.visibility === visibility).length;
    const filter = state.sheetsFilter ?? { search: "", system: "", visibility: "" };
    const chip = (value, label, total) => `<button class="sheet-filter-chip${filter.visibility === value ? " active" : ""}" data-sheet-filter-visibility="${value}" type="button" aria-pressed="${filter.visibility === value}"><span>${label}</span><strong>${total}</strong></button>`;
    return `<div class="sheets-page">
      <p class="settings-lead">Fichas de personagem preenchidas pelos usuários. Cada ficha pertence a quem criou a cópia; aqui você transfere a ficha para outra pessoa ou define quem pode abri-la.</p>
      ${copies.length ? `
      <div class="sheets-toolbar">
        <div class="sheet-filter-chips" role="group" aria-label="Filtrar por acesso">
          ${chip("", "Todas", copies.length)}${chip("private", "Só o dono", count("private"))}${chip("shared", "Compartilhadas", count("shared"))}${chip("public", "Todos", count("public"))}
        </div>
        <div class="sheets-search-row">
          <label class="sheets-search">${renderSheetIcon("M21 21l-4.35-4.35M19 11a8 8 0 1 1-16 0a8 8 0 0 1 16 0")}<span class="sr-only">Buscar ficha</span><input class="input" id="sheets-search-input" type="search" value="${escapeHtml(filter.search)}" placeholder="Buscar por ficha, dono ou sistema" autocomplete="off" /></label>
          ${ordered.length > 1 ? `<select class="input sheets-system-select" id="sheets-system-select" aria-label="Filtrar por sistema"><option value="">Todos os sistemas</option>${ordered.map(([label]) => `<option value="${escapeHtml(label)}" ${filter.system === label ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select>` : ""}
        </div>
      </div>
      <div class="sheets-groups">
        ${ordered.map(([label, items]) => `<section class="sheet-group" data-sheet-group="${escapeHtml(label)}">
          <h3 class="sheet-group-title"><span>${escapeHtml(label)}</span><small data-sheet-group-count>${items.length}</small></h3>
          <div class="sheet-list">${items.map(renderPdfSheetCard).join("")}</div>
        </section>`).join("")}
      </div>
      <p class="empty sheets-no-results" hidden>Nenhuma ficha com esses filtros.</p>` : `<div class="sheets-empty">${renderSheetIcon(SHEET_FILE_ICON, "sheet-svg sheets-empty-icon")}<strong>Nenhuma ficha preenchida ainda</strong><p>Quando alguém salvar uma cópia preenchida de uma ficha PDF, ela aparece aqui.</p></div>`}
    </div>`;
}
// Busca e filtros só escondem cartões: nada é redesenhado, então o campo de busca mantém o foco.
function applyPdfSheetsFilter() {
    const page = app.querySelector(".sheets-page");
    if (!page)
        return;
    const filter = state.sheetsFilter ?? { search: "", system: "", visibility: "" };
    const terms = filter.search.toLocaleLowerCase("pt-BR").split(/\s+/).filter(Boolean);
    let visibleTotal = 0;
    page.querySelectorAll("[data-sheet-group]").forEach(group => {
        let visible = 0;
        const systemOk = !filter.system || group.dataset.sheetGroup === filter.system;
        group.querySelectorAll(".sheet-card").forEach(card => {
            const show = systemOk && (!filter.visibility || card.dataset.sheetVisibility === filter.visibility) && terms.every(term => card.dataset.sheetSearch.includes(term));
            card.hidden = !show;
            if (show)
                visible++;
        });
        group.hidden = visible === 0;
        group.querySelector("[data-sheet-group-count]").textContent = String(visible);
        visibleTotal += visible;
    });
    const empty = page.querySelector(".sheets-no-results");
    if (empty)
        empty.hidden = visibleTotal > 0;
    page.querySelectorAll("[data-sheet-filter-visibility]").forEach(button => {
        const active = button.dataset.sheetFilterVisibility === filter.visibility;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
    });
}
function bindPdfSheetsSettings(root) {
    const page = root.querySelector(".sheets-page");
    if (!page)
        return;
    state.sheetsFilter ??= { search: "", system: "", visibility: "" };
    page.querySelector("#sheets-search-input")?.addEventListener("input", event => { state.sheetsFilter.search = event.target.value; applyPdfSheetsFilter(); });
    page.querySelector("#sheets-system-select")?.addEventListener("change", event => { state.sheetsFilter.system = event.target.value; applyPdfSheetsFilter(); });
    page.querySelectorAll("[data-sheet-filter-visibility]").forEach(button => button.addEventListener("click", () => { state.sheetsFilter.visibility = button.dataset.sheetFilterVisibility ?? ""; applyPdfSheetsFilter(); }));
    page.querySelectorAll("[data-sheet-open]").forEach(button => button.addEventListener("click", () => {
        const content = findContentById(button.dataset.sheetOpen ?? "");
        if (content)
            openReaderAtPageAndRender(content, 0);
    }));
    page.querySelectorAll("[data-sheet-edit]").forEach(button => button.addEventListener("click", () => openPdfSheetEditor(button.dataset.sheetEdit ?? "", button)));
    applyPdfSheetsFilter();
}
// Janela de acesso: proprietário, visibilidade em cartões, pessoas (só em "Pessoas escolhidas") e sistema.
function openPdfSheetEditor(contentId, opener) {
    const copy = state.pdfFormCopies.find(item => item.contentId === contentId);
    if (!copy)
        return;
    document.querySelector(".sheet-editor-backdrop")?.remove();
    const title = sheetFullTitle(copy);
    const systems = [...new Set(state.pdfFormCopies.map(item => item.system).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
    const people = [...state.adminUsers].sort((a, b) => sheetPersonName(a).localeCompare(sheetPersonName(b), "pt-BR"));
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop sheet-editor-backdrop";
    backdrop.setAttribute("role", "presentation");
    backdrop.innerHTML = `<section class="modal-panel sheet-editor" role="dialog" aria-modal="true" aria-labelledby="sheet-editor-title">
      <header class="modal-header">
        <div class="sheet-editor-heading"><h2 id="sheet-editor-title">Acesso da ficha</h2><p>${escapeHtml(title)}</p></div>
        <button class="icon-button sheet-editor-close" data-sheet-editor-close type="button" aria-label="Fechar">${renderSheetIcon("M18 6L6 18M6 6l12 12")}</button>
      </header>
      <form class="sheet-editor-form">
        <div class="modal-body">
          <div class="sheet-editor-grid">
            <label class="form-row"><span>Proprietário</span><select class="input" name="ownerUserId">${people.map(person => `<option value="${escapeHtml(person.id)}" ${person.id === copy.ownerUserId ? "selected" : ""}>${escapeHtml(sheetPersonName(person))}${person.username && person.username !== person.displayName ? ` (${escapeHtml(person.username)})` : ""}</option>`).join("")}</select></label>
            <label class="form-row"><span>Sistema</span><input class="input" name="system" maxlength="80" value="${escapeHtml(copy.system)}" placeholder="Ex.: Tormenta RPG" list="sheet-systems" autocomplete="off" /><datalist id="sheet-systems">${systems.map(system => `<option value="${escapeHtml(system)}"></option>`).join("")}</datalist></label>
          </div>
          <fieldset class="sheet-visibility-options"><legend>Quem pode abrir</legend>
            ${Object.entries(SHEET_VISIBILITY).map(([value, option]) => `<label class="sheet-visibility-option"><input type="radio" name="visibility" value="${value}" ${copy.visibility === value ? "checked" : ""} /><span class="sheet-visibility-card">${renderSheetIcon(option.icon)}<strong>${option.label}</strong><small>${option.help}</small></span></label>`).join("")}
          </fieldset>
          <fieldset class="sheet-people" ${copy.visibility === "shared" ? "" : "hidden"}>
            <legend>Pessoas com acesso <span class="sheet-people-count" aria-live="polite"></span></legend>
            <label class="sheets-search sheet-people-search">${renderSheetIcon("M21 21l-4.35-4.35M19 11a8 8 0 1 1-16 0a8 8 0 0 1 16 0")}<span class="sr-only">Buscar pessoa</span><input class="input" type="search" placeholder="Buscar pessoa" autocomplete="off" data-sheet-people-search /></label>
            <div class="sheet-people-list">${people.map(person => `<label class="sheet-person" data-sheet-person="${escapeHtml(person.id)}" data-sheet-person-search="${escapeHtml(`${sheetPersonName(person)} ${person.username ?? ""}`.toLocaleLowerCase("pt-BR"))}"><input type="checkbox" name="sharedWithUserIds" value="${escapeHtml(person.id)}" ${copy.sharedWithUserIds.includes(person.id) ? "checked" : ""} />${renderAvatar(person, "avatar sheet-avatar")}<span>${escapeHtml(sheetPersonName(person))}</span></label>`).join("")}</div>
            <p class="sheet-people-empty" hidden>Ninguém encontrado.</p>
          </fieldset>
          <p class="error sheet-editor-error" role="alert" hidden></p>
        </div>
        <footer class="modal-actions">
          <button class="button secondary" data-sheet-editor-close type="button">Cancelar</button>
          <button class="button" type="submit">Salvar acesso</button>
        </footer>
      </form>
    </section>`;
    const form = backdrop.querySelector("form");
    const peopleBox = backdrop.querySelector(".sheet-people");
    const close = () => { backdrop.remove(); if (opener?.isConnected) opener.focus(); };
    const sync = () => {
        const owner = form.elements.ownerUserId.value;
        // O dono sempre tem acesso: some da lista de pessoas.
        backdrop.querySelectorAll("[data-sheet-person]").forEach(row => { row.classList.toggle("is-owner", row.dataset.sheetPerson === owner); });
        const term = backdrop.querySelector("[data-sheet-people-search]").value.toLocaleLowerCase("pt-BR").trim();
        let shown = 0;
        backdrop.querySelectorAll("[data-sheet-person]").forEach(row => {
            const show = row.dataset.sheetPerson !== owner && (!term || row.dataset.sheetPersonSearch.includes(term));
            row.hidden = !show;
            if (show)
                shown++;
        });
        backdrop.querySelector(".sheet-people-empty").hidden = shown > 0;
        const selected = [...form.querySelectorAll("[name=sharedWithUserIds]:checked")].filter(input => input.value !== owner).length;
        backdrop.querySelector(".sheet-people-count").textContent = selected ? `· ${selected} ${selected === 1 ? "selecionada" : "selecionadas"}` : "· nenhuma selecionada";
        peopleBox.hidden = form.elements.visibility.value !== "shared";
    };
    form.addEventListener("change", sync);
    backdrop.querySelector("[data-sheet-people-search]").addEventListener("input", sync);
    backdrop.querySelectorAll("[data-sheet-editor-close]").forEach(button => button.addEventListener("click", close));
    backdrop.addEventListener("mousedown", event => { if (event.target === backdrop) close(); });
    backdrop.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
        }
    });
    form.addEventListener("submit", async event => {
        event.preventDefault();
        const submit = form.querySelector("[type=submit]");
        const error = backdrop.querySelector(".sheet-editor-error");
        const owner = form.elements.ownerUserId.value;
        submit.disabled = true;
        submit.textContent = "Salvando…";
        error.hidden = true;
        try {
            const result = await api(`/api/admin/pdf-form-copies/${encodeURIComponent(contentId)}`, {
                method: "PATCH",
                body: JSON.stringify({
                    ownerUserId: owner,
                    visibility: form.elements.visibility.value,
                    system: form.elements.system.value,
                    sharedWithUserIds: [...form.querySelectorAll("[name=sharedWithUserIds]:checked")].map(input => input.value).filter(id => id !== owner)
                })
            });
            // A resposta não traz o título da obra; mantém o que a lista já tinha.
            state.pdfFormCopies = state.pdfFormCopies.map(item => item.contentId === contentId ? { ...item, ...result.copy, title: item.title } : item);
            backdrop.remove();
            renderShell();
            const card = app.querySelector(`.sheet-card[data-sheet-id="${CSS.escape(contentId)}"]`);
            if (card) {
                card.classList.add("just-saved");
                card.querySelector(".sheet-edit")?.focus({ preventScroll: true });
                card.scrollIntoView({ block: "nearest" });
                window.setTimeout(() => card.classList.remove("just-saved"), 1800);
            }
        }
        catch (failure) {
            error.textContent = failure instanceof Error ? failure.message : "Não foi possível salvar. Tente novamente.";
            error.hidden = false;
            submit.disabled = false;
            submit.textContent = "Salvar acesso";
        }
    });
    document.body.append(backdrop);
    sync();
    form.elements.ownerUserId.focus();
}
function renderStartupSettings() {
    const user = state.adminUsers.find(item => item.id === startupSelectedUserId) ?? state.adminUsers[0];
    startupSelectedUserId = user?.id ?? "";
    return `<section class="startup-settings"><h3>Página inicial</h3>
    <p class="settings-lead">Selecione o usuário e escolha onde ele inicia ao abrir o Pugotiread. A escolha é salva automaticamente.</p>
    <div class="startup-setting-row">
      <label>Usuário<select class="input" id="startup-user-select" ${user ? "" : "disabled"}>
        ${state.adminUsers.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === user?.id ? "selected" : ""}>${escapeHtml(item.username || item.displayName)}</option>`).join("")}
      </select></label>
      <label>Biblioteca inicial<select class="input" data-startup-user="${escapeHtml(user?.id ?? "")}" ${user ? "" : "disabled"}><option value="">Início</option>
        ${state.libraries.filter(library => user && !library.isPersonal && (user.role === "admin" || user.allowedLibraryIds.includes(library.id))).map(library => `<option value="${escapeHtml(library.id)}" ${startupLibraries[user.id] === library.id ? "selected" : ""}>${escapeHtml(library.name)}</option>`).join("")}
      </select></label>
      <span data-startup-status role="status" aria-live="polite"></span>
    </div></section>`;
}
function renderUsersSettings() {
    return `
    <div class="settings-toolbar">
      <p class="settings-lead">Usuários cadastrados no sistema. Aqui o administrador define acesso, permissões e convites.</p>
      <div class="settings-toolbar-actions">
        <button class="button secondary" id="invite-user-button" type="button">+ Convite</button>
        <button class="button" id="add-user-button" type="button">+ Adicionar usuário</button>
      </div>
    </div>
    ${state.adminUserInviteUrl ? renderInviteBanner(state.adminUserInviteUrl) : ""}
    ${state.adminUsers.length
        ? `<div class="user-table">${state.adminUsers.map(renderUserRow).join("")}</div>`
        : `<p class="empty">Nenhum usuário cadastrado.</p>`}
  `;
}
function renderSyncSettings() {
    const libraries = state.libraries.filter((library) => ["manga", "manhwa", "comic", "other"].includes(library.kind));
    const selectedLibraryId = libraries.some((library) => library.id === state.syncLibraryId)
        ? state.syncLibraryId
        : libraries[0]?.id ?? "";
    state.syncLibraryId = selectedLibraryId;
    const contents = state.homeContents
        .filter((content) => content.libraryId === selectedLibraryId)
        .sort((left, right) => left.title.localeCompare(right.title, "pt-BR", { numeric: true }));
    if (state.syncContentId && !contents.some((content) => content.id === state.syncContentId)) {
        state.syncContentId = "";
    }
    return `
    <form class="settings-panel" id="sync-settings-form">
      <p class="settings-lead">Baixe capítulos novos de todas as obras de uma biblioteca ou de uma obra específica.</p>
      ${libraries.length
        ? `
            <label class="form-row">
              <span>Biblioteca</span>
              <select class="input" id="sync-library-select" name="libraryId">
                ${libraries.map((library) => `
                  <option value="${escapeHtml(library.id)}" ${library.id === selectedLibraryId ? "selected" : ""}>${escapeHtml(library.name)}</option>
                `).join("")}
              </select>
            </label>
            <label class="form-row">
              <span>Obra</span>
              <select class="input" name="contentId">
                <option value="">Todas as obras</option>
                ${contents.map((content) => `
                  <option value="${escapeHtml(content.id)}" ${content.id === state.syncContentId ? "selected" : ""}>${escapeHtml(content.title)}</option>
                `).join("")}
              </select>
            </label>
            <p class="modal-help">Somente obras com <code>manga_url.txt</code> são processadas pelo sincronizador.</p>
            ${state.syncError ? `<p class="error">${escapeHtml(state.syncError)}</p>` : ""}
            ${state.syncMessage ? `<p class="scan-message">${escapeHtml(state.syncMessage)}</p>` : ""}
            <div class="settings-actions">
              <button class="button" type="submit" ${state.syncRunning ? "disabled" : ""}>
                ${state.syncRunning ? "Sincronizando..." : "Sincronizar"}
              </button>
            </div>
          `
        : `<p class="empty">Nenhuma biblioteca compatível com sincronização foi cadastrada.</p>`}
    </form>
  `;
}
function renderVaultSettings() {
    return `
    <form class="settings-panel vault-settings-form" id="vault-settings-form">
      <p class="settings-lead">Defina por quanto tempo o cofre pessoal fica aberto sem atividade antes de bloquear automaticamente.</p>
      <label class="form-row">
        <span>Tempo sem atividade em minutos</span>
        <input class="input" name="vaultTimeoutMinutes" type="number" min="1" step="1" inputmode="numeric" value="${escapeHtml(state.vaultSettingsDraft)}" required />
      </label>
      ${state.vaultSettingsError ? `<p class="error">${escapeHtml(state.vaultSettingsError)}</p>` : ""}
      ${state.vaultSettingsMessage ? `<p class="scan-message">${escapeHtml(state.vaultSettingsMessage)}</p>` : ""}
      <div class="settings-actions">
        <button class="button" type="submit">Salvar configuração</button>
      </div>
    </form>
  `;
}
function renderDownloadSettings() {
    const running = state.syncRunning || state.syncStatus?.state === "running";
    return `
    <form class="settings-panel download-settings-form" id="direct-download-form">
      <p class="settings-lead">Cole o link de uma obra para iniciar um download individual pelo Pugotidownloader.</p>
      <label class="form-row">
        <span>Tipo de obra</span>
        <select class="input" name="kind" required>
          <option value="manga">Mangá</option>
          <option value="manhwa">Manhwa</option>
          ${state.vaultUnlocked ? `<option value="vault">Cofre</option>` : ""}
        </select>
      </label>
      <label class="form-row">
        <span>Link da obra</span>
        <input class="input" name="url" type="url" placeholder="https://..." autocomplete="off" required />
      </label>
      <p class="modal-help">O link deve ser HTTP/HTTPS e compatível com um conector do Pugotidownloader. Se houver uma sincronização ativa, o download será adicionado à fila automaticamente.</p>
      ${state.syncError ? `<p class="error">${escapeHtml(state.syncError)}</p>` : ""}
      ${state.syncMessage ? `<p class="scan-message">${escapeHtml(state.syncMessage)}</p>` : ""}
      <div class="settings-actions">
        <button class="button" type="submit" ${directDownloadSubmitting ? "disabled" : ""}>${directDownloadSubmitting ? "Adicionando..." : running ? "Adicionar à fila" : "Iniciar download"}</button>
      </div>
    </form>
  `;
}
function renderReadingModeSettings() {
    const kinds = ["manga", "manhwa", "comic", "book", "lightNovel", "other"];
    return `
    <form class="settings-panel reading-settings-form" id="reading-settings-form">
      <p class="settings-lead">Defina como o leitor abre por padrão em cada tipo de biblioteca.</p>
      <div class="library-settings-list">
        ${kinds.map((kind) => renderReadingDefaultsRow(kind)).join("")}
      </div>
      ${state.readingSettingsError ? `<p class="error">${escapeHtml(state.readingSettingsError)}</p>` : ""}
      ${state.readingSettingsMessage ? `<p class="scan-message">${escapeHtml(state.readingSettingsMessage)}</p>` : ""}
      <div class="settings-actions">
        <button class="button" type="submit">Salvar configuração</button>
      </div>
    </form>
  `;
}
function renderReadingDefaultsRow(kind) {
    const defaults = state.readingSettingsDraft[kind];
    const textReader = kind === "book" || kind === "lightNovel";
    return `
    <article class="library-settings-row reading-settings-row${textReader ? " reading-settings-text" : ""}">
      <div class="library-settings-row-info">
        <strong>${escapeHtml(getLibraryKindLabel(kind))}</strong>
        <p>Controles usados ao abrir obras desta biblioteca.</p>
      </div>
      <label class="compact-field">
        <span>Modo</span>
        <select class="input" name="${kind}.mode">
          <option value="horizontal" ${defaults.mode === "horizontal" ? "selected" : ""}>${textReader ? "Páginas" : "Horizontal"}</option>
          <option value="vertical-scroll" ${defaults.mode !== "horizontal" ? "selected" : ""}>${textReader ? "Rolagem" : "Scroll"}</option>
        </select>
      </label>
      ${textReader ? "" : `<label class="compact-field">
        <span>Ajuste</span>
        <select class="input" name="${kind}.fitting">
          <option value="height" ${defaults.fitting === "height" ? "selected" : ""}>Página inteira</option>
          <option value="width" ${defaults.fitting === "width" ? "selected" : ""}>Preencher largura</option>
          <option value="original" ${defaults.fitting === "original" ? "selected" : ""}>Tamanho real</option>
        </select>
      </label>`}
      <label class="toggle-field">
        <input type="checkbox" name="${kind}.controlsVisible" ${defaults.controlsVisible ? "checked" : ""} />
        <span>Controles visíveis</span>
      </label>
    </article>
  `;
}
function renderInviteBanner(inviteUrl) {
    return `
    <div class="invite-banner">
      <strong>Link de convite gerado</strong>
      <div class="invite-banner-row">
        <input class="input" value="${escapeHtml(inviteUrl)}" readonly />
        <button class="button secondary" data-copy-invite type="button">Copiar</button>
      </div>
    </div>
  `;
}
function renderUserRow(user) {
    const libraryNames = user.allowedLibraryIds
        .map((libraryId) => state.libraries.find((library) => library.id === libraryId)?.name)
        .filter((value) => Boolean(value));
    return `
    <article class="user-row">
      <div class="user-main">
        ${renderAvatar(user, "avatar user-avatar")}
        <div>
          <strong>${escapeHtml(user.displayName || user.username)}</strong>
          <p>${escapeHtml(user.email || "Sem e-mail")}</p>
          <small>${escapeHtml(user.lastActiveAt ? `Ultimo acesso: ${new Date(user.lastActiveAt).toLocaleString("pt-BR")}` : "Nunca acessou")}</small>
        </div>
      </div>
      <div class="user-libraries">
        ${libraryNames.length ? libraryNames.map((name) => `<span>${escapeHtml(name)}</span>`).join("") : `<span class="muted">Sem bibliotecas</span>`}
      </div>
      <div class="user-permissions">
        <span class="${user.canLogin ? "active" : ""}">Login</span>
        <span class="${user.canDownload ? "active" : ""}">Download</span>
        <span class="${user.canChangePassword ? "active" : ""}">Senha</span>
      </div>
      <div class="user-actions">
        <button class="icon-button" data-edit-user="${escapeHtml(user.id)}" type="button" title="Editar usuário" aria-label="Editar usuário">${renderSidebarIcon("pencil", "Editar usuário")}</button>
        <button class="icon-button danger" data-delete-user="${escapeHtml(user.id)}" type="button" title="Apagar usuário" aria-label="Apagar usuário">${renderSidebarIcon("trash", "Apagar usuário")}</button>
      </div>
    </article>
  `;
}
function renderLibrarySettingsRow(library) {
    const contentCount = state.homeContents.filter((content) => content.libraryId === library.id).length;
    return `
    <article class="library-settings-row">
      <div class="library-settings-row-info">
        <strong>${escapeHtml(library.name)}</strong>
        <p>${escapeHtml(library.path)}</p>
      </div>
      <span>${escapeHtml(library.kind)}</span>
      <span>${contentCount} títulos</span>
      <button class="button secondary" type="button" data-scan-library-id="${library.id}">Escanear</button>
      <div class="library-settings-row-actions">
        <button class="icon-button" data-edit-library="${escapeHtml(library.id)}" type="button" title="Editar biblioteca" aria-label="Editar biblioteca">${renderSidebarIcon("pencil", "Editar biblioteca")}</button>
        <button class="icon-button danger" data-delete-library="${escapeHtml(library.id)}" type="button" title="Apagar biblioteca" aria-label="Apagar biblioteca">${renderSidebarIcon("trash", "Apagar biblioteca")}</button>
      </div>
    </article>
  `;
}
function renderLibraryModal() {
    const isEditing = Boolean(state.editingLibraryId);
    return `
    <div class="modal-backdrop" role="presentation">
      <section class="modal-panel library-modal" role="dialog" aria-modal="true" aria-labelledby="library-modal-title">
        <header class="modal-header">
          <h2 id="library-modal-title">${isEditing
        ? (state.libraryDraft.isPersonal ? "Editar biblioteca pessoal" : "Editar biblioteca")
        : (state.libraryDraft.isPersonal ? "Adicionar biblioteca pessoal" : "Adicionar biblioteca")}</h2>
          <button class="icon-button" id="close-library-modal" type="button" aria-label="Fechar">${renderIcon("close")}</button>
        </header>
        <div class="modal-body">
          <nav class="library-modal-tabs" aria-label="Etapas da biblioteca">
            ${renderLibraryModalStepButton("general", "Geral")}
            ${renderLibraryModalStepButton("folder", "Pasta")}
            ${renderLibraryModalStepButton("cover", "Capa")}
            ${renderLibraryModalStepButton("advanced", "Avançado")}
          </nav>
          <div class="library-modal-content">
            ${renderLibraryModalStep()}
            <p class="error">${escapeHtml(state.libraryModalError)}</p>
          </div>
        </div>
        <footer class="modal-actions">
          <button class="button secondary" id="library-back-button" type="button" ${state.libraryModalStep === "general" ? "disabled" : ""}>Voltar</button>
          <button class="button secondary" id="cancel-library-modal" type="button">Cancelar</button>
          ${state.libraryModalStep === "advanced"
        ? `<button class="button" id="create-library-button" type="button">${isEditing ? "Salvar biblioteca" : "Criar biblioteca"}</button>`
        : `<button class="button" id="library-next-button" type="button">Próximo</button>`}
        </footer>
      </section>
    </div>
  `;
}
function renderLibraryModalStepButton(step, label) {
    const active = state.libraryModalStep === step ? " active" : "";
    return `<button class="library-step-button${active}" data-library-modal-step="${step}" type="button">${escapeHtml(label)}</button>`;
}
function renderLibraryModalStep() {
    if (state.libraryModalStep === "folder") {
        return renderLibraryFolderStep();
    }
    if (state.libraryModalStep === "cover") {
        return `
      <p class="modal-help">A capa será detectada automaticamente pela primeira imagem encontrada dentro de cada obra.</p>
      <p class="modal-help">Configuração manual de capa da biblioteca será implementada depois.</p>
    `;
    }
    if (state.libraryModalStep === "advanced") {
        return `
      <p class="modal-help">Revise os dados antes de criar a biblioteca.</p>
      <div class="review-list">
        <span>Nome</span><strong>${escapeHtml(state.libraryDraft.name || "Não definido")}</strong>
        <span>Tipo</span><strong>${escapeHtml(getLibraryKindLabel(state.libraryDraft.kind))}</strong>
        <span>Visibilidade</span><strong>${state.libraryDraft.isPersonal ? "Cofre pessoal" : "Biblioteca pública"}</strong>
        <span>Pasta</span><strong>${escapeHtml(state.libraryDraft.path || "Não selecionada")}</strong>
      </div>
    `;
    }
    return `
    <label class="form-row">
      <span>Nome</span>
      <input class="input" id="library-name-input" value="${escapeHtml(state.libraryDraft.name)}" placeholder="Mangás" required />
    </label>
    <label class="form-row">
      <span>Tipo</span>
      <select class="input" id="library-kind-input" required>
        <option value="manga" ${state.libraryDraft.kind === "manga" ? "selected" : ""}>Mangás</option>
        <option value="book" ${state.libraryDraft.kind === "book" ? "selected" : ""}>Livros</option>
        <option value="manhwa" ${state.libraryDraft.kind === "manhwa" ? "selected" : ""}>Manhwas</option>
        <option value="comic" ${state.libraryDraft.kind === "comic" ? "selected" : ""}>Quadrinhos</option>
        <option value="lightNovel" ${state.libraryDraft.kind === "lightNovel" ? "selected" : ""}>Light Novels</option>
        <option value="other" ${state.libraryDraft.kind === "other" ? "selected" : ""}>Outros</option>
      </select>
    </label>
    <p class="modal-help">${state.libraryDraft.isPersonal ? "Esta biblioteca ficará oculta fora do cofre pessoal." : "Escolha o nome e o tipo da biblioteca. A pasta real será selecionada na próxima etapa."}</p>
  `;
}
function renderLibraryFolderStep() {
    const browser = state.folderBrowser;
    return `
    <p class="modal-help">Selecione uma pasta real dentro da raiz de mídia do servidor.</p>
    <label class="form-row">
      <span>Pasta selecionada</span>
      <input class="input" id="library-path-input" value="${escapeHtml(state.libraryDraft.path)}" placeholder="Selecione uma pasta abaixo" readonly />
    </label>
    <div class="folder-browser">
      <div class="folder-browser-header">
        <strong>${escapeHtml(browser?.path ?? "Carregando...")}</strong>
        <button class="button secondary" type="button" id="select-current-folder" ${browser ? "" : "disabled"}>Usar esta pasta</button>
      </div>
      <div class="folder-list">
        ${browser?.parent ? `<button class="folder-row" data-folder-path="${escapeHtml(browser.parent)}" type="button">..</button>` : ""}
        ${browser
        ? browser.directories.length
            ? browser.directories.map((directory) => `<button class="folder-row" data-folder-path="${escapeHtml(directory.path)}" type="button">${escapeHtml(directory.name)}</button>`).join("")
            : `<p class="empty compact">Esta pasta não possui subpastas.</p>`
        : `<p class="empty compact">Lendo pastas...</p>`}
      </div>
    </div>
  `;
}
function getLibraryKindLabel(kind) {
    const labels = {
        manga: "Mangás",
        book: "Livros",
        manhwa: "Manhwas",
        comic: "Quadrinhos",
        lightNovel: "Light Novels",
        other: "Outros"
    };
    return labels[kind];
}
function getNextLibraryModalStep(step) {
    const steps = ["general", "folder", "cover", "advanced"];
    return steps[Math.min(steps.indexOf(step) + 1, steps.length - 1)] ?? "advanced";
}
function getPreviousLibraryModalStep(step) {
    const steps = ["general", "folder", "cover", "advanced"];
    return steps[Math.max(steps.indexOf(step) - 1, 0)] ?? "general";
}
function resetLibraryDraft() {
    state.libraryModalStep = "general";
    state.libraryModalError = "";
    state.editingLibraryId = null;
    state.libraryDraft = { name: "", kind: "manga", path: "", isPersonal: false };
    state.folderBrowser = null;
}
async function loadFolderBrowser(path) {
    const params = new URLSearchParams();
    if (path) {
        params.set("path", path);
    }
    else if (state.libraryDraft.isPersonal) {
        params.set("scope", "vault");
    }
    const query = params.toString() ? `?${params.toString()}` : "";
    state.folderBrowser = await api(`/api/admin/folders${query}`);
}
async function openLibraryModal() {
    resetLibraryDraft();
    state.libraryModalOpen = true;
    renderShell();
    try {
        await loadFolderBrowser();
        renderShell();
    }
    catch (error) {
        state.libraryModalError = error instanceof Error ? error.message : "Não foi possível carregar as pastas.";
        renderShell();
    }
}
async function openPersonalLibraryModal() {
    resetLibraryDraft();
    state.libraryDraft.isPersonal = true;
    state.libraryModalOpen = true;
    renderShell();
    try {
        await loadFolderBrowser();
        renderShell();
    }
    catch (error) {
        state.libraryModalError = error instanceof Error ? error.message : "Não foi possível carregar as pastas.";
        renderShell();
    }
}
async function openPersonalLibraryEditModal(libraryId) {
    const library = state.personalLibraries.find((item) => item.id === libraryId);
    if (!library) {
        return;
    }
    resetLibraryDraft();
    state.editingLibraryId = library.id;
    state.libraryDraft = {
        name: library.name,
        kind: library.kind,
        path: library.path,
        isPersonal: true
    };
    state.libraryModalOpen = true;
    renderShell();
    try {
        await loadFolderBrowser(library.path);
        renderShell();
    }
    catch (error) {
        state.libraryModalError = error instanceof Error ? error.message : "Não foi possível carregar as pastas.";
        renderShell();
    }
}
async function openLibraryEditModal(libraryId) {
    const library = state.libraries.find((item) => item.id === libraryId);
    if (!library) {
        return;
    }
    resetLibraryDraft();
    state.editingLibraryId = library.id;
    state.libraryDraft = {
        name: library.name,
        kind: library.kind,
        path: library.path,
        isPersonal: false
    };
    state.libraryModalOpen = true;
    renderShell();
    try {
        await loadFolderBrowser(library.path);
        renderShell();
    }
    catch (error) {
        state.libraryModalError = error instanceof Error ? error.message : "Não foi possível carregar as pastas.";
        renderShell();
    }
}
function resetCollectionDraft() {
    state.collectionModalError = "";
    state.collectionDraft = { name: "", description: "" };
}
function openCollectionModal() {
    resetCollectionDraft();
    state.collectionModalOpen = true;
    renderShell();
}
function closeCollectionModal() {
    state.collectionModalOpen = false;
    resetCollectionDraft();
    renderShell();
}
async function openCollectionShareModal(collectionId) {
    const collection = state.collections.find((item) => item.id === collectionId);
    if (!collection || collection.userId !== state.user?.id) {
        return;
    }
    state.sharingCollectionId = collectionId;
    state.collectionShareModalOpen = true;
    state.collectionShareError = "";
    renderShell();
    try {
        const { users } = await api("/api/users");
        state.collectionShareUsers = users;
        renderShell();
    }
    catch (error) {
        state.collectionShareError = error instanceof Error ? error.message : "Não foi possível carregar usuários.";
        renderShell();
    }
}
function closeCollectionShareModal() {
    state.collectionShareModalOpen = false;
    state.collectionShareError = "";
    state.collectionShareUsers = [];
    state.sharingCollectionId = null;
    renderShell();
}
function openCollectionDeleteModal(collectionId) {
    const collection = state.collections.find((item) => item.id === collectionId);
    if (!collection || collection.userId !== state.user?.id) {
        return;
    }
    state.deletingCollectionId = collectionId;
    state.collectionDeleteError = "";
    renderShell();
}
function closeCollectionDeleteModal() {
    state.deletingCollectionId = null;
    state.collectionDeleteError = "";
    renderShell();
}
function resetAdminUserDraft() {
    state.adminUserDraft = {
        email: "",
        displayName: "",
        username: "",
        password: "",
        role: "user",
        allowedLibraryIds: [],
        canLogin: true,
        canDownload: true,
        canChangePassword: true
    };
    state.adminUserModalError = "";
    state.adminUserInviteUrl = "";
    state.adminUserEditingId = null;
}
function openAdminUserModal(mode, userId = null) {
    state.adminUserModalMode = mode;
    state.adminUserModalOpen = true;
    state.adminUserModalError = "";
    state.adminUserInviteUrl = "";
    state.adminUserEditingId = userId;
    if (mode === "edit" && userId) {
        const user = state.adminUsers.find((item) => item.id === userId);
        if (user) {
            state.adminUserDraft = {
                email: user.email,
                displayName: user.displayName,
                username: user.username,
                password: "",
                role: user.role,
                allowedLibraryIds: [...user.allowedLibraryIds],
                canLogin: user.canLogin,
                canDownload: user.canDownload,
                canChangePassword: user.canChangePassword
            };
        }
    }
    else {
        resetAdminUserDraft();
    }
    renderShell();
}
function closeAdminUserModal() {
    state.adminUserModalOpen = false;
    resetAdminUserDraft();
    renderShell();
}
function openAdminUserDeleteModal(userId) {
    state.adminUserDeleteId = userId;
    state.adminUserModalError = "";
    renderShell();
}
function closeAdminUserDeleteModal() {
    state.adminUserDeleteId = null;
    state.adminUserModalError = "";
    renderShell();
}
function syncAdminUserDraftFromInputs(form) {
    const formData = new FormData(form);
    state.adminUserDraft = {
        email: String(formData.get("email") ?? ""),
        displayName: String(formData.get("displayName") ?? ""),
        username: String(formData.get("username") ?? ""),
        password: String(formData.get("password") ?? ""),
        role: (() => { const r = String(formData.get("role") ?? "user"); return r === "admin" || r === "superuser" ? r : "user"; })(),
        allowedLibraryIds: formData.getAll("allowedLibraryIds").map((value) => String(value)),
        canLogin: formData.get("canLogin") === "on",
        canDownload: formData.get("canDownload") === "on",
        canChangePassword: formData.get("canChangePassword") === "on"
    };
}
async function submitAdminUserForm(form) {
    syncAdminUserDraftFromInputs(form);
    const mode = state.adminUserModalMode;
    const payload = {
        email: state.adminUserDraft.email.trim(),
        displayName: state.adminUserDraft.displayName.trim(),
        username: state.adminUserDraft.username.trim(),
        password: state.adminUserDraft.password,
        role: state.adminUserDraft.role,
        allowedLibraryIds: state.adminUserDraft.allowedLibraryIds,
        canLogin: state.adminUserDraft.canLogin,
        canDownload: state.adminUserDraft.canDownload,
        canChangePassword: state.adminUserDraft.canChangePassword
    };
    try {
        state.adminUserModalError = "";
        state.adminUserInviteUrl = "";
        if (mode === "invite") {
            const { inviteUrl } = await api("/api/admin/invites", {
                method: "POST",
                body: JSON.stringify(payload)
            });
            state.adminUserInviteUrl = inviteUrl;
            state.adminUserModalOpen = true;
            await refreshAdminUsers();
            renderShell();
            return;
        }
        if (mode === "edit" && state.adminUserEditingId) {
            await api(`/api/admin/users/${encodeURIComponent(state.adminUserEditingId)}`, {
                method: "PATCH",
                body: JSON.stringify(payload)
            });
        }
        else {
            await api("/api/admin/users", {
                method: "POST",
                body: JSON.stringify(payload)
            });
        }
        state.adminUserModalOpen = false;
        resetAdminUserDraft();
        await refreshAdminUsers();
        renderShell();
    }
    catch (error) {
        state.adminUserModalError = error instanceof Error ? error.message : "Não foi possível salvar o usuário.";
        renderShell();
    }
}
async function createLinkOnlyInvite(form) {
    syncAdminUserDraftFromInputs(form);
    try {
        state.adminUserModalError = "";
        state.adminUserInviteUrl = "";
        const { inviteUrl } = await api("/api/admin/invites", {
            method: "POST",
            body: JSON.stringify({
                role: state.adminUserDraft.role,
                linkOnly: true,
                allowedLibraryIds: state.adminUserDraft.allowedLibraryIds,
                canLogin: true,
                canDownload: true,
                canChangePassword: false
            })
        });
        state.adminUserInviteUrl = inviteUrl;
        state.adminUserModalOpen = true;
        renderShell();
    }
    catch (error) {
        state.adminUserModalError = error instanceof Error ? error.message : "Não foi possível gerar o link de convite.";
        renderShell();
    }
}
async function deleteAdminUser() {
    if (!state.adminUserDeleteId) {
        return;
    }
    try {
        state.adminUserModalError = "";
        await api(`/api/admin/users/${encodeURIComponent(state.adminUserDeleteId)}`, { method: "DELETE" });
        state.adminUserDeleteId = null;
        await refreshAdminUsers();
        renderShell();
    }
    catch (error) {
        state.adminUserModalError = error instanceof Error ? error.message : "Não foi possível apagar o usuário.";
        renderShell();
    }
}
async function refreshAdminUsers() {
    if (state.user?.role !== "admin") {
        return;
    }
    const { users } = await api("/api/admin/users");
    state.adminUsers = users;
}
async function deleteCollection() {
    const collectionId = state.deletingCollectionId;
    if (!collectionId) {
        return;
    }
    try {
        state.collectionDeleteError = "";
        await api(`/api/collections/${encodeURIComponent(collectionId)}`, { method: "DELETE" });
        state.deletingCollectionId = null;
        await refreshUserLists();
        renderShell();
    }
    catch (error) {
        state.collectionDeleteError = error instanceof Error ? error.message : "Não foi possível apagar a coleção.";
        renderShell();
    }
}
async function readAvatarInput(input) {
    const file = input.files?.[0];
    if (!file) {
        return null;
    }
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
        reader.addEventListener("error", () => reject(new Error("Não foi possível ler a imagem.")));
        reader.readAsDataURL(file);
    });
}
async function saveProfile(form) {
    const formData = new FormData(form);
    const favoriteContentIds = formData.getAll("favoriteContentIds").map((value) => String(value)).slice(0, 3);
    const avatarInput = form.querySelector("#profile-avatar-input");
    try {
        state.profileError = "";
        const avatarFromInput = avatarInput ? await readAvatarInput(avatarInput) : null;
        const payload = await api("/api/me/profile", {
            method: "PATCH",
            body: JSON.stringify({
                avatarUrl: avatarFromInput ?? state.user?.avatarUrl ?? "",
                nickname: String(formData.get("nickname") ?? ""),
                biography: String(formData.get("biography") ?? ""),
                location: String(formData.get("location") ?? ""),
                favoriteContentIds
            })
        });
        state.user = payload.user;
        state.profileEditing = false;
        state.profileFavoriteSearch = "";
        renderShell();
    }
    catch (error) {
        state.profileError = error instanceof Error ? error.message : "Não foi possível salvar o perfil.";
        renderShell();
    }
}
async function removeProfileAvatar() {
    if (!state.user) {
        return;
    }
    try {
        state.profileError = "";
        const payload = await api("/api/me/profile", {
            method: "PATCH",
            body: JSON.stringify({
                avatarUrl: "",
                nickname: state.user.nickname,
                biography: state.user.biography,
                location: state.user.location,
                favoriteContentIds: state.user.favoriteContentIds
            })
        });
        state.user = payload.user;
        renderShell();
    }
    catch (error) {
        state.profileError = error instanceof Error ? error.message : "Não foi possível remover o avatar.";
        renderShell();
    }
}
function addProfileFavorite(contentId) {
    if (!state.user || !contentId || state.user.favoriteContentIds.includes(contentId) || state.user.favoriteContentIds.length >= 3) {
        return;
    }
    state.user = {
        ...state.user,
        favoriteContentIds: [...state.user.favoriteContentIds, contentId]
    };
    state.profileFavoriteSearch = "";
    renderShell();
}
function removeProfileFavorite(contentId) {
    if (!state.user || !contentId) {
        return;
    }
    state.user = {
        ...state.user,
        favoriteContentIds: state.user.favoriteContentIds.filter((item) => item !== contentId)
    };
    renderShell();
}
async function setProfileFavoriteFromMenu(contentId, enabled) {
    if (!state.user || !contentId)
        return;
    const currentIds = state.user.favoriteContentIds ?? [];
    const favoriteContentIds = enabled
        ? currentIds.includes(contentId)
            ? currentIds
            : [...currentIds, contentId].slice(0, 3)
        : currentIds.filter((item) => item !== contentId);
    if (enabled && !currentIds.includes(contentId) && currentIds.length >= 3) {
        state.profileError = "Você pode fixar no máximo 3 obras favoritas.";
        state.openSeriesMenuId = null;
        renderShell();
        return;
    }
    try {
        state.profileError = "";
        const payload = await api("/api/me/profile", {
            method: "PATCH",
            body: JSON.stringify({
                avatarUrl: state.user.avatarUrl ?? "",
                nickname: state.user.nickname ?? "",
                biography: state.user.biography ?? "",
                location: state.user.location ?? "",
                favoriteContentIds
            })
        });
        state.user = payload.user;
        state.openSeriesMenuId = null;
        state.openSeriesAddMenuId = null;
        state.openSeriesRemoveMenuId = null;
        renderShell();
    }
    catch (error) {
        state.profileError = error instanceof Error ? error.message : "Não foi possível atualizar favoritas.";
        renderShell();
    }
}
async function saveCollectionSharing(form) {
    const collectionId = state.sharingCollectionId;
    if (!collectionId) {
        return;
    }
    const formData = new FormData(form);
    const userIds = formData.getAll("userId").map((value) => String(value));
    try {
        state.collectionShareError = "";
        await api(`/api/collections/${encodeURIComponent(collectionId)}/sharing`, {
            method: "PUT",
            body: JSON.stringify({ userIds })
        });
        state.collectionShareModalOpen = false;
        state.collectionShareUsers = [];
        state.sharingCollectionId = null;
        await refreshUserLists();
        renderShell();
    }
    catch (error) {
        state.collectionShareError = error instanceof Error ? error.message : "Não foi possível compartilhar a coleção.";
        renderShell();
    }
}
async function savePersonCollectionRecommendations(form) {
    const userId = form.dataset.personRecommendationForm ?? "";
    if (!userId) {
        return;
    }
    const selectedCollectionIds = new Set(new FormData(form).getAll("collectionId").map((value) => String(value)));
    const ownedCollections = getOwnedCollections();
    try {
        state.peopleShareError = "";
        await Promise.all(ownedCollections.map((collection) => {
            const sharedWithUserIds = new Set(collection.sharedWithUserIds);
            if (selectedCollectionIds.has(collection.id)) {
                sharedWithUserIds.add(userId);
            }
            else {
                sharedWithUserIds.delete(userId);
            }
            return api(`/api/collections/${encodeURIComponent(collection.id)}/sharing`, {
                method: "PUT",
                body: JSON.stringify({ userIds: [...sharedWithUserIds] })
            });
        }));
        await refreshUserLists();
        renderShell();
    }
    catch (error) {
        state.peopleShareError = error instanceof Error ? error.message : "Não foi possível salvar as indicações.";
        renderShell();
    }
}
function syncCollectionDraftFromInputs() {
    const nameInput = document.querySelector("#collection-name-input");
    const descriptionInput = document.querySelector("#collection-description-input");
    if (nameInput) {
        state.collectionDraft.name = nameInput.value;
    }
    if (descriptionInput) {
        state.collectionDraft.description = descriptionInput.value;
    }
}
async function createCollection() {
    syncCollectionDraftFromInputs();
    const name = state.collectionDraft.name.trim();
    const description = state.collectionDraft.description.trim();
    if (!name) {
        state.collectionModalError = "Informe o nome da coleção.";
        renderShell();
        return;
    }
    try {
        state.collectionModalError = "";
        await api("/api/collections", {
            method: "POST",
            body: JSON.stringify({ name, description })
        });
        state.collectionModalOpen = false;
        resetCollectionDraft();
        await refreshUserLists();
        renderShell();
    }
    catch (error) {
        state.collectionModalError = error instanceof Error ? error.message : "Não foi possível criar a coleção.";
        renderShell();
    }
}
function startCollectionEdit(collectionId) {
    const collection = state.collections.find((item) => item.id === collectionId);
    if (!collection) {
        return;
    }
    state.editingCollectionId = collection.id;
    state.collectionEditError = "";
    state.collectionEditDraft = {
        name: collection.name,
        description: collection.description
    };
    renderShell();
}
function cancelCollectionEdit() {
    state.editingCollectionId = null;
    state.collectionEditError = "";
    state.collectionEditDraft = { name: "", description: "" };
    renderShell();
}
async function saveCollectionEdit(form) {
    const collectionId = form.dataset.collectionEditForm ?? "";
    const formData = new FormData(form);
    const name = String(formData.get("name") ?? "").trim();
    const description = String(formData.get("description") ?? "").trim();
    if (!collectionId || !name) {
        state.collectionEditError = "Informe o nome da coleção.";
        renderShell();
        return;
    }
    try {
        state.collectionEditError = "";
        await api(`/api/collections/${encodeURIComponent(collectionId)}`, {
            method: "PATCH",
            body: JSON.stringify({ name, description })
        });
        state.editingCollectionId = null;
        state.collectionEditDraft = { name: "", description: "" };
        await refreshUserLists();
        renderShell();
    }
    catch (error) {
        state.collectionEditError = error instanceof Error ? error.message : "Não foi possível salvar a coleção.";
        renderShell();
    }
}
function syncLibraryDraftFromInputs() {
    const nameInput = document.querySelector("#library-name-input");
    const kindInput = document.querySelector("#library-kind-input");
    if (nameInput) {
        state.libraryDraft.name = nameInput.value;
    }
    if (kindInput) {
        state.libraryDraft.kind = kindInput.value;
    }
}
function canMoveLibraryStep(nextStep) {
    syncLibraryDraftFromInputs();
    state.libraryModalError = "";
    if ((nextStep === "folder" || nextStep === "cover" || nextStep === "advanced") && !state.libraryDraft.name.trim()) {
        state.libraryModalError = "Informe o nome da biblioteca.";
        return false;
    }
    if ((nextStep === "cover" || nextStep === "advanced") && !state.libraryDraft.path.trim()) {
        state.libraryModalError = "Selecione a pasta da biblioteca.";
        return false;
    }
    return true;
}
async function refreshLibraries() {
    const { libraries } = await api("/api/libraries");
    state.libraries = libraries;
    state.homeContents = await loadLibraryContents(getGloballyListedLibraries(libraries));
    state.readingNowContents = await loadLibraryContents(getGloballyListedLibraries(libraries));
}
async function refreshLibraryAfterSync(libraryId) {
    if (!libraryId) {
        await refreshLibraries();
        return;
    }
    const { libraries } = await api("/api/libraries");
    const library = libraries.find((item) => item.id === libraryId);
    if (!library) {
        state.libraries = libraries;
        return;
    }
    const { contents } = await api(`/api/libraries/${encodeURIComponent(libraryId)}/contents`);
    const replaceLibraryContents = (current, includeLibrary) => [
        ...current.filter((content) => content.libraryId !== libraryId),
        ...(includeLibrary ? contents : [])
    ];
    state.libraries = libraries;
    state.homeContents = replaceLibraryContents(state.homeContents, !library.isPersonal && globallyListedLibraryKinds.has(library.kind));
    state.readingNowContents = replaceLibraryContents(state.readingNowContents, !library.isPersonal && globallyListedLibraryKinds.has(library.kind));
    if (state.activeLibraryId === libraryId) {
        state.contents = contents;
    }
}
function updateStatsMenu() {
    if (!state.statsMenuOpen) {
        return;
    }
    const current = document.querySelector(".stats-menu");
    if (current) {
        current.outerHTML = renderStatsMenu();
    }
}
async function refreshSyncStatus() {
    if (state.user?.role !== "admin") {
        return;
    }
    try {
        const { sync } = await api("/api/admin/sync/status");
        const wasRunning = state.syncRunning;
        const shouldApplyFinished = Boolean(sync.finishedAt &&
            sync.finishedAt !== lastAppliedSyncFinishedAt &&
            (sync.state === "completed" || sync.state === "error"));
        state.syncStatus = sync;
        state.syncRunning = sync.state === "running";
        updateStatsMenu();
        if (shouldApplyFinished && sync.finishedAt) {
            lastAppliedSyncFinishedAt = sync.finishedAt;
            state.syncMessage = sync.state === "completed" ? sync.message : "";
            state.syncError = sync.state === "error" ? sync.message : "";
            if (sync.state === "completed") {
                await refreshLibraryAfterSync(sync.libraryId);
            }
            renderShell();
        }
        else if (wasRunning !== state.syncRunning) {
            // O estado pode mudar sem uma nova finalização (por exemplo, ao
            // carregar a página durante uma execução). Nesse caso, a interface
            // também precisa ser redesenhada para liberar/bloquear os controles.
            renderShell();
        }
    }
    catch {
        // Status polling must not interrupt reading or other navigation.
    }
}
function startSyncStatusPolling() {
    if (state.user?.role !== "admin" || syncStatusTimer !== null) {
        return;
    }
    void refreshSyncStatus();
    syncStatusTimer = window.setInterval(() => {
        void refreshSyncStatus();
    }, 1500);
}
async function refreshPersonalVault() {
    if (!state.vaultUnlocked) {
        return;
    }
    state.contents = await loadLibraryContents(state.personalLibraries);
}
async function deletePersonalLibrary(libraryId) {
    const library = state.personalLibraries.find((item) => item.id === libraryId);
    if (!library || !confirm(`Apagar a biblioteca "${library.name}" do cofre? Os arquivos da pasta não serão removidos.`)) {
        return;
    }
    try {
        await api(`/api/libraries/${encodeURIComponent(libraryId)}`, { method: "DELETE" });
        state.personalLibraries = state.personalLibraries.filter((item) => item.id !== libraryId);
        state.contents = state.contents.filter((content) => content.libraryId !== libraryId);
        if (state.activeLibraryId === libraryId) {
            await router.replaceRoute({ kind: "view", view: "vault" });
        }
        renderShell();
    }
    catch (error) {
        state.vaultError = error instanceof Error ? error.message : "Não foi possível apagar a biblioteca.";
        renderShell();
    }
}
async function deletePublicLibrary(libraryId) {
    const library = state.libraries.find((item) => item.id === libraryId);
    if (!library || !confirm(`Apagar a biblioteca "${library.name}"? Os arquivos da pasta não serão removidos.`)) {
        return;
    }
    try {
        await api(`/api/libraries/${encodeURIComponent(libraryId)}`, { method: "DELETE" });
        state.libraries = state.libraries.filter((item) => item.id !== libraryId);
        state.homeContents = state.homeContents.filter((content) => content.libraryId !== libraryId);
        state.readingNowContents = state.readingNowContents.filter((content) => content.libraryId !== libraryId);
        if (state.activeLibraryId === libraryId) {
            await router.replaceRoute({ kind: "view", view: "home" });
        }
        renderShell();
    }
    catch (error) {
        state.libraryModalError = error instanceof Error ? error.message : "Não foi possível apagar a biblioteca.";
        renderShell();
    }
}
async function unlockPersonalVault(form) {
    const formData = new FormData(form);
    try {
        state.vaultError = "";
        const payload = await api("/api/personal-vault/unlock", {
            method: "POST",
            body: JSON.stringify({ password: String(formData.get("password") ?? "") })
        });
        state.personalLibraries = payload.libraries;
        state.vaultToken = payload.vaultToken;
        state.vaultTimeoutMinutes = payload.vaultTimeoutMinutes;
        state.vaultSettingsDraft = String(payload.vaultTimeoutMinutes);
        state.vaultUnlocked = true;
        lastVaultTouchAt = Date.now();
        startVaultInactivityTimer();
        state.contents = await loadLibraryContents(payload.libraries);
        renderShell();
    }
    catch (error) {
        state.vaultError = error instanceof Error ? error.message : "Não foi possível desbloquear o cofre.";
        renderShell();
    }
}
async function lockPersonalVault() {
    const wasPersonal = state.activeView === "vault" || state.personalLibraries.some((library) => library.id === state.activeLibraryId);
    await api("/api/personal-vault/lock", { method: "POST" }).catch(() => undefined);
    clearVaultInactivityTimer();
    state.vaultUnlocked = false;
    state.vaultToken = "";
    state.vaultError = "";
    state.vaultMenuOpen = false;
    lastVaultTouchAt = 0;
    state.personalLibraries = [];
    if (wasPersonal) {
        state.contents = [];
        await router.replaceRoute({ kind: "view", view: "vault" });
    }
    renderShell();
}
function openPersonalVaultFromShortcut() {
    if (state.user?.role !== "admin") {
        return;
    }
    state.vaultHiddenFromMenu = false;
    closeNavigationPanels();
    closeMobileNavigation();
    openView("vault");
    if (!state.vaultUnlocked) {
        requestAnimationFrame(() => document.querySelector("#vault-password-input")?.focus());
    }
}
async function lockAndHidePersonalVaultFromShortcut() {
    if (state.user?.role !== "admin") {
        return;
    }
    state.vaultHiddenFromMenu = true;
    closeNavigationPanels();
    closeMobileNavigation();
    if (state.activeView === "vault") {
        openView("home");
    }
    renderShell();
    await lockPersonalVault();
}
function toggleVaultMenuVisibility() {
    if (state.user?.role !== "admin") {
        return;
    }
    state.vaultHiddenFromMenu = !state.vaultHiddenFromMenu;
    state.vaultMenuOpen = false;
    if (state.vaultHiddenFromMenu && state.activeView === "vault") {
        openView("home");
    }
    renderNavigationMenus();
}
function clearVaultInactivityTimer() {
    if (vaultInactivityTimer) {
        window.clearTimeout(vaultInactivityTimer);
        vaultInactivityTimer = null;
    }
}
function startVaultInactivityTimer() {
    clearVaultInactivityTimer();
    if (!state.vaultUnlocked) {
        return;
    }
    vaultInactivityTimer = window.setTimeout(() => {
        void lockPersonalVault();
    }, state.vaultTimeoutMinutes * 60 * 1000);
}
function registerVaultActivity() {
    if (state.vaultUnlocked) {
        startVaultInactivityTimer();
        void touchPersonalVault();
    }
}
async function touchPersonalVault() {
    if (!state.vaultUnlocked || vaultTouchInFlight) {
        return;
    }
    const minTouchIntervalMs = Math.max(30_000, Math.min(60_000, state.vaultTimeoutMinutes * 30_000));
    if (Date.now() - lastVaultTouchAt < minTouchIntervalMs) {
        return;
    }
    vaultTouchInFlight = true;
    try {
        const payload = await api("/api/personal-vault/touch", { method: "POST" });
        state.vaultToken = payload.vaultToken;
        state.vaultTimeoutMinutes = payload.vaultTimeoutMinutes;
        state.vaultSettingsDraft = String(payload.vaultTimeoutMinutes);
        lastVaultTouchAt = Date.now();
    }
    catch {
        await lockPersonalVault();
    }
    finally {
        vaultTouchInFlight = false;
    }
}
async function saveVaultSettings(form) {
    const formData = new FormData(form);
    const rawMinutes = String(formData.get("vaultTimeoutMinutes") ?? "").trim();
    const minutes = Number(rawMinutes);
    state.vaultSettingsDraft = rawMinutes;
    if (!Number.isInteger(minutes) || minutes < 1) {
        state.vaultSettingsError = "Informe um número inteiro maior que zero.";
        state.vaultSettingsMessage = "";
        renderShell();
        return;
    }
    try {
        const { settings } = await api("/api/admin/settings", {
            method: "PATCH",
            body: JSON.stringify({ vaultTimeoutMinutes: minutes })
        });
        state.vaultTimeoutMinutes = settings.vaultTimeoutMinutes;
        state.vaultSettingsDraft = String(settings.vaultTimeoutMinutes);
        state.vaultSettingsError = "";
        state.vaultSettingsMessage = "Configuração salva.";
        if (state.vaultUnlocked) {
            lastVaultTouchAt = 0;
            startVaultInactivityTimer();
            void touchPersonalVault();
        }
        renderShell();
    }
    catch (error) {
        state.vaultSettingsError = error instanceof Error ? error.message : "Não foi possível salvar a configuração.";
        state.vaultSettingsMessage = "";
        renderShell();
    }
}
function readReadingDefaultsForm(form) {
    const formData = new FormData(form);
    const kinds = ["manga", "manhwa", "book", "comic", "lightNovel", "other"];
    return Object.fromEntries(kinds.map((kind) => {
        const current = state.readingSettingsDraft[kind];
        const mode = String(formData.get(`${kind}.mode`) ?? current.mode);
        const fitting = String(formData.get(`${kind}.fitting`) ?? current.fitting);
        const direction = "ltr";
        return [kind, {
                mode,
                fitting,
                direction,
                controlsVisible: formData.has(`${kind}.controlsVisible`)
            }];
    }));
}
async function saveReadingModeSettings(form) {
    const readingDefaults = readReadingDefaultsForm(form);
    state.readingSettingsDraft = readingDefaults;
    try {
        const { settings } = await api("/api/admin/settings", {
            method: "PATCH",
            body: JSON.stringify({ readingDefaults })
        });
        state.readingSettingsDraft = settings.readingDefaults;
        state.readingSettingsError = "";
        state.readingSettingsMessage = "Configuração salva.";
        renderShell();
    }
    catch (error) {
        state.readingSettingsError = error instanceof Error ? error.message : "Não foi possível salvar a configuração.";
        state.readingSettingsMessage = "";
        renderShell();
    }
}
async function scanLibraryById(libraryId) {
    const library = state.libraries.find((item) => item.id === libraryId);
    state.scanMessage = library ? `Escaneando ${library.name}...` : "Escaneando biblioteca...";
    renderShell();
    try {
        const { contents } = await api(`/api/libraries/${libraryId}/scan`, {
            method: "POST"
        });
        await refreshLibraries();
        if (state.activeLibraryId === libraryId) {
            state.contents = contents;
        }
        state.scanMessage = library
            ? `${library.name}: ${contents.length} obras detectadas.`
            : `${contents.length} obras detectadas.`;
        renderShell();
    }
    catch (error) {
        state.scanMessage = error instanceof Error ? error.message : "Não foi possível escanear a biblioteca.";
        renderShell();
    }
}
async function synchronizeLibrary(form) {
    if (state.syncRunning) {
        return;
    }
    const formData = new FormData(form);
    const libraryId = String(formData.get("libraryId") ?? "");
    const contentId = String(formData.get("contentId") ?? "");
    const library = state.libraries.find((item) => item.id === libraryId);
    const content = state.homeContents.find((item) => item.id === contentId);
    state.syncLibraryId = libraryId;
    state.syncContentId = contentId;
    state.syncRunning = true;
    state.syncError = "";
    state.syncMessage = content
        ? `Sincronizando ${content.title}...`
        : `Sincronizando todas as obras de ${library?.name ?? "biblioteca"}...`;
    renderShell();
    try {
        const { sync } = await api("/api/admin/sync", {
            method: "POST",
            body: JSON.stringify({ libraryId, contentId: contentId || null })
        });
        state.syncStatus = sync;
        state.syncRunning = true;
        state.syncMessage = `${sync.target}: sincronização iniciada em segundo plano.`;
    }
    catch (error) {
        state.syncRunning = false;
        state.syncMessage = "";
        state.syncError = error instanceof Error ? error.message : "Não foi possível sincronizar.";
    }
    renderShell();
}
async function startDirectDownload(form) {
    const formData = new FormData(form);
    const kind = String(formData.get("kind") ?? "");
    const url = String(formData.get("url") ?? "").trim();
    directDownloadSubmitting = true;
    state.syncError = "";
    state.syncMessage = "Validando o link e preparando o download...";
    renderShell();
    try {
        const { sync, queued, queuePosition } = await api("/api/admin/download", {
            method: "POST",
            body: JSON.stringify({ kind, url })
        });
        state.syncStatus = sync;
        state.syncMessage = kind === "vault"
            ? queued
                ? `Atualização do cofre adicionada à fila (posição ${queuePosition}).`
                : "Atualizando o cofre."
            : queued
                ? `Download adicionado à fila (posição ${queuePosition}).`
                : `${sync.target}: download iniciado em segundo plano.`;
        form.reset();
    }
    catch (error) {
        state.syncMessage = "";
        state.syncError = error instanceof Error ? error.message : "Não foi possível iniciar o download.";
    }
    finally {
        directDownloadSubmitting = false;
    }
    renderShell();
}
function closeLibraryModal() {
    state.libraryModalOpen = false;
    resetLibraryDraft();
    renderShell();
}
function getScopedLibraryOnly(search) {
    const parsed = parseSearch(search);
    if (!parsed.libraryId || parsed.query.length > 0) {
        return null;
    }
    return state.libraries.find((library) => library.id === parsed.libraryId) ?? null;
}
function getLibraryAutocomplete(value) {
    const trimmedStart = value.trimStart();
    if (!trimmedStart.startsWith(">")) {
        return null;
    }
    const afterMarker = trimmedStart.slice(1);
    if (afterMarker.includes(" ")) {
        return null;
    }
    const partial = normalizeText(afterMarker);
    const library = state.libraries.find((item) => normalizeText(item.name).startsWith(partial));
    if (!library || normalizeText(library.name) === partial) {
        return null;
    }
    return `>${library.name} `;
}
function getGlobalSearchResults(query) {
    const normalizedQuery = normalizeText(query.trim());
    if (!normalizedQuery)
        return [];
    const allowedIds = new Set([...state.libraries, ...(state.vaultUnlocked ? state.personalLibraries : [])].map((library) => library.id));
    const contents = new Map([...getAvailableContents(), ...globalSearchExtraContents]
        .filter((content) => allowedIds.has(content.libraryId)).map((content) => [content.id, content]));
    return [...contents.values()].filter((content) => normalizeText([
        content.title,
        ...(content.authors ?? []),
        ...(content.artists ?? [])
    ].join(" ")).includes(normalizedQuery)).slice(0, 12);
}
function renderGlobalSearchResults(query = globalSearchQuery) {
    if (!query.trim()) {
        return `<div class="global-search-empty" aria-hidden="true">${renderIcon("search")}</div>`;
    }
    const results = getGlobalSearchResults(query);
    if (!results.length) {
        return `<p class="global-search-no-results">Nenhuma obra encontrada.</p>`;
    }
    return `<div class="global-search-results">${results.map((content) => {
        const library = [...state.libraries, ...state.personalLibraries].find((item) => item.id === content.libraryId);
        const creators = [...(content.authors ?? []), ...(content.artists ?? [])]
            .filter((name, index, values) => Boolean(name) && values.indexOf(name) === index)
            .join(", ");
        return `
      <button class="global-search-result" data-global-search-result="${escapeHtml(content.id)}" data-library-id="${escapeHtml(content.libraryId)}" type="button">
        <span class="global-search-cover">${content.coverUrl ? `<img src="${escapeHtml(content.coverUrl)}" alt="" loading="lazy" />` : renderIcon("book")}</span>
        <span class="global-search-copy">
          <strong>${escapeHtml(content.title)}</strong>
          <small>${escapeHtml([creators, library?.name ?? ""].filter(Boolean).join(" · "))}</small>
        </span>
        ${renderIcon("caretRight")}
      </button>`;
    }).join("")}</div>`;
}
function renderGlobalSearchModal() {
    return `
    <div class="global-search-backdrop" data-global-search-close="backdrop">
      <section class="global-search-panel" role="dialog" aria-modal="true" aria-label="Buscar obras">
        <div class="global-search-field">
          ${renderIcon("search")}
          <input id="global-search-input" type="search" value="${escapeHtml(globalSearchQuery)}" placeholder="Buscar obras…" autocomplete="off" aria-label="Buscar por título, autor ou artista" />
          <button class="global-search-escape" data-global-search-close="button" type="button" aria-label="Fechar busca">ESC</button>
        </div>
        <div class="global-search-content" id="global-search-results" aria-live="polite">${renderGlobalSearchResults()}</div>
      </section>
    </div>`;
}
function updateSearchSuggestion(input) {
    const ghost = document.querySelector("#search-ghost");
    if (!ghost) {
        return;
    }
    const suggestion = getLibraryAutocomplete(input.value);
    if (!suggestion) {
        ghost.textContent = "";
        return;
    }
    const typed = input.value;
    const completion = suggestion.slice(typed.length);
    ghost.innerHTML = `
    <span class="search-ghost-typed">${escapeHtml(typed)}</span><span>${escapeHtml(completion)}</span><span class="search-tab-hint">Tab</span>
  `;
}
function renderCollectionsView() {
    return `
    <section class="section-heading">
      <div>
        <h2>Minhas Coleções</h2>
        <p class="muted">Crie listas pessoais para organizar obras por tema, recomendação ou qualquer critério seu.</p>
      </div>
      <div class="section-actions">
        <span class="muted">${state.collections.length} coleções</span>
        <button class="button" id="add-collection-button" type="button">Nova coleção</button>
      </div>
    </section>
    ${state.collections.length
        ? `<div class="collection-list">${state.collections.map(renderCollectionSection).join("")}</div>`
        : `<p class="empty">Nenhuma coleção criada ainda.</p>`}
  `;
}
function getUserLabel(user) {
    return user.nickname || user.displayName || user.username || "Usuário";
}
function getOwnedCollections() {
    return state.collections.filter((collection) => collection.userId === state.user?.id);
}
function renderPeopleView() {
    if (state.activePeopleUserId) {
        const user = state.peopleUsers.find((item) => item.id === state.activePeopleUserId);
        if (user) {
            return renderPublicUserProfile(user);
        }
    }
    const ownedCollections = getOwnedCollections();
    const people = state.peopleUsers.filter((user) => user.id !== state.user?.id);
    return `
    <section class="section-heading">
      <div>
        <h2>Pessoas</h2>
        <p class="muted">Veja perfis, obras favoritas e indique suas coleções para outros usuários.</p>
      </div>
      <span class="muted">${people.length} pessoas</span>
    </section>
    ${state.peopleShareError ? `<p class="error">${escapeHtml(state.peopleShareError)}</p>` : ""}
    ${people.length
        ? `<div class="people-list">${people.map((user) => renderPersonCard(user, ownedCollections)).join("")}</div>`
        : `<p class="empty">Nenhum outro usuário cadastrado.</p>`}
  `;
}
function renderPersonCard(user, ownedCollections) {
    const userName = getUserLabel(user);
    const favorites = getContentsByIds(user.favoriteContentIds);
    const indicatedCount = ownedCollections.filter((collection) => collection.sharedWithUserIds.includes(user.id)).length;
    return `
    <article class="person-card">
      <button class="person-card-open" data-open-person="${escapeHtml(user.id)}" type="button">
        ${renderAvatar(user, "avatar user-avatar")}
        <div>
          <h3>
            <span>${escapeHtml(userName)}</span>
            <small>${user.reviewCount} ${user.reviewCount === 1 ? "review" : "reviews"}</small>
          </h3>
          <p>${escapeHtml(user.username)}</p>
        </div>
      </button>
      <div class="person-favorites">
        ${favorites.length
        ? favorites.map(renderPersonFavorite).join("")
        : `<span class="muted">Nenhuma obra favorita definida.</span>`}
      </div>
      ${indicatedCount ? `<p class="person-indication-count">${indicatedCount} ${indicatedCount === 1 ? "coleção indicada" : "coleções indicadas"}</p>` : ""}
    </article>
  `;
}
function renderPersonFavorite(content) {
    return `
    <span class="person-favorite-cover" title="${escapeHtml(content.title)}">
      ${content.coverUrl
        ? `<img src="${escapeHtml(content.coverUrl)}" alt="" aria-hidden="true" />`
        : `<span>${escapeHtml(content.title.slice(0, 1).toUpperCase())}</span>`}
    </span>
  `;
}
function renderPublicUserProfile(user) {
    const userName = getUserLabel(user);
    const ownedCollections = getOwnedCollections();
    const sharedCollections = ownedCollections.filter((collection) => collection.sharedWithUserIds.includes(user.id));
    const favorites = getContentsByIds(user.favoriteContentIds);
    return `
    <section class="profile-page public-profile-page">
      <button class="button secondary" id="back-to-people" type="button">Voltar</button>
      <div class="profile-hero">
        ${renderAvatar(user, "profile-avatar")}
        <div class="profile-hero-info">
          <h2>${escapeHtml(userName)}</h2>
          <p>${escapeHtml(user.biography || "Sem biografia.")}</p>
          ${user.location ? `<span>${escapeHtml(user.location)}</span>` : ""}
        </div>
        <span class="public-profile-review-count">${user.reviewCount} ${user.reviewCount === 1 ? "review publicada" : "reviews publicadas"}</span>
      </div>
      <section class="profile-section">
        <h3>Coleções indicadas</h3>
        ${sharedCollections.length
        ? `<div class="person-collection-list">${sharedCollections.map((collection) => `<span class="person-collection-pill">${escapeHtml(collection.name)}</span>`).join("")}</div>`
        : `<p class="empty compact">Nenhuma coleção compartilhada.</p>`}
      </section>
      <section class="profile-section">
        <h3>Indicar minhas coleções</h3>
        ${renderPersonCollectionRecommendationForm(user, ownedCollections)}
      </section>
      <section class="profile-section">
        <h3>Obras preferidas</h3>
        ${favorites.length
        ? `<div class="profile-favorites">${favorites.map(renderProfileFavorite).join("")}</div>`
        : `<p class="empty compact">Nenhuma obra preferida definida.</p>`}
      </section>
    </section>
  `;
}
function renderPersonCollectionRecommendationForm(user, ownedCollections) {
    if (ownedCollections.length === 0) {
        return `<p class="empty compact">Crie uma coleção pessoal antes de indicar.</p>`;
    }
    return `
    <form class="person-recommendation-form" data-person-recommendation-form="${escapeHtml(user.id)}">
      <div class="person-recommendation-list">
        ${ownedCollections.map((collection) => `
          <label class="person-recommendation-row">
            <input type="checkbox" name="collectionId" value="${escapeHtml(collection.id)}" ${collection.sharedWithUserIds.includes(user.id) ? "checked" : ""} />
            <span>
              <strong>${escapeHtml(collection.name)}</strong>
              ${collection.description ? `<small>${escapeHtml(collection.description)}</small>` : ""}
            </span>
          </label>
        `).join("")}
      </div>
      <button class="button" type="submit">Salvar indicações</button>
    </form>
  `;
}
function renderCollectionSection(collection) {
    const contents = getContentsByIds(collection.contentIds);
    const editing = state.editingCollectionId === collection.id;
    const owner = collection.userId === state.user?.id;
    return `
    <section class="collection-section${owner ? "" : " shared"}">
      ${editing
        ? renderCollectionEditForm(collection, contents.length)
        : `
            <div class="series-section-heading">
              <div>
                <h2>${escapeHtml(collection.name)}</h2>
                ${collection.description ? `<p>${escapeHtml(collection.description)}</p>` : ""}
                ${owner ? "" : `<p class="collection-owner">Compartilhada por ${escapeHtml(collection.ownerDisplayName)}</p>`}
              </div>
              <div class="collection-heading-actions">
                <span>${contents.length} títulos</span>
                ${owner
            ? `
                      <button class="icon-button collection-share-button" data-share-collection="${escapeHtml(collection.id)}" type="button" title="Compartilhar coleção">${renderIcon("share")}</button>
                      <button class="icon-button collection-edit-button" data-edit-collection="${escapeHtml(collection.id)}" type="button" title="Editar coleção" aria-label="Editar coleção">${renderSidebarIcon("pencil", "Editar coleção")}</button>
                      <button class="icon-button collection-delete-button" data-delete-collection="${escapeHtml(collection.id)}" type="button" title="Apagar coleção" aria-label="Apagar coleção">${renderSidebarIcon("trash", "Apagar coleção")}</button>
                    `
            : ""}
              </div>
            </div>
          `}
      ${contents.length
        ? `<div class="content-grid">${contents.map((content, index) => renderCollectionContentCard(collection, content, index, editing)).join("")}</div>`
        : `<p class="empty compact">Coleção vazia.</p>`}
    </section>
  `;
}
function renderCollectionEditForm(collection, contentCount) {
    return `
    <form class="collection-edit-form" data-collection-edit-form="${escapeHtml(collection.id)}">
      <div class="collection-edit-grid">
        <label class="form-row">
          <span>Nome</span>
          <input class="input" name="name" maxlength="80" value="${escapeHtml(state.collectionEditDraft.name)}" required />
        </label>
        <label class="form-row">
          <span>Descrição</span>
          <textarea class="input" name="description" rows="3" maxlength="240">${escapeHtml(state.collectionEditDraft.description)}</textarea>
        </label>
      </div>
      <div class="collection-edit-actions">
        <span class="muted">${contentCount} títulos</span>
        <button class="button secondary" data-cancel-collection-edit="${escapeHtml(collection.id)}" type="button">Cancelar</button>
        <button class="button" type="submit">Salvar</button>
      </div>
      ${state.collectionEditError ? `<p class="error">${escapeHtml(state.collectionEditError)}</p>` : ""}
    </form>
  `;
}
function renderCollectionContentCard(collection, content, index, editing = false) {
    const owner = collection.userId === state.user?.id;
    return `
    <div class="collection-card-shell">
      ${renderSeriesCard(content, `collection-${collection.id}-${content.id}-${index}`)}
      ${owner && editing ? `<button class="collection-remove-button" data-remove-collection-content="${escapeHtml(collection.id)}" data-content-id="${escapeHtml(content.id)}" type="button" aria-label="Remover ${escapeHtml(content.title)} da coleção">×</button>` : ""}
    </div>
  `;
}
function renderCollectionModal() {
    return `
    <div class="modal-backdrop" role="presentation">
      <section class="modal-panel collection-modal" role="dialog" aria-modal="true" aria-labelledby="collection-modal-title">
        <header class="modal-header">
          <h2 id="collection-modal-title">Nova coleção</h2>
          <button class="icon-button" id="close-collection-modal" type="button" aria-label="Fechar">${renderIcon("close")}</button>
        </header>
        <form id="collection-form">
          <div class="modal-body">
            <label class="form-row">
              <span>Nome da coleção</span>
              <input class="input" id="collection-name-input" name="name" value="${escapeHtml(state.collectionDraft.name)}" maxlength="80" placeholder="Tem anime" required />
            </label>
            <label class="form-row">
              <span>Descrição</span>
              <textarea class="input" id="collection-description-input" name="description" rows="4" maxlength="240" placeholder="Lista das obras que estou lendo e possuem versão animada">${escapeHtml(state.collectionDraft.description)}</textarea>
            </label>
            <p class="modal-help">Depois de criar, use o menu de cada obra para adicioná-la à coleção.</p>
            ${state.collectionModalError ? `<p class="error">${escapeHtml(state.collectionModalError)}</p>` : ""}
          </div>
          <footer class="modal-actions">
            <button class="button secondary" id="cancel-collection-modal" type="button">Cancelar</button>
            <button class="button" type="submit">Criar coleção</button>
          </footer>
        </form>
      </section>
    </div>
  `;
}
function renderCollectionShareModal() {
    const collection = state.collections.find((item) => item.id === state.sharingCollectionId);
    const selectedIds = new Set(collection?.sharedWithUserIds ?? []);
    const users = state.collectionShareUsers.filter((user) => user.id !== state.user?.id);
    return `
    <div class="modal-backdrop" role="presentation">
      <section class="modal-panel collection-modal" role="dialog" aria-modal="true" aria-labelledby="collection-share-title">
        <header class="modal-header">
          <h2 id="collection-share-title">Compartilhar coleção</h2>
          <button class="icon-button" id="close-collection-share-modal" type="button" aria-label="Fechar">${renderIcon("close")}</button>
        </header>
        <form id="collection-share-form">
          <div class="modal-body">
            <p class="modal-help">Escolha quais usuários poderão ver "${escapeHtml(collection?.name ?? "esta coleção")}".</p>
            <div class="share-user-list">
              ${users.length
        ? users.map((user) => `
                      <label class="share-user-row">
                        <input type="checkbox" name="userId" value="${escapeHtml(user.id)}" ${selectedIds.has(user.id) ? "checked" : ""} />
                        <span>
                          <strong>${escapeHtml(user.displayName)}</strong>
                          <small>${escapeHtml(user.username)}</small>
                        </span>
                      </label>
                    `).join("")
        : `<p class="empty compact">Nenhum outro usuário cadastrado.</p>`}
            </div>
            ${state.collectionShareError ? `<p class="error">${escapeHtml(state.collectionShareError)}</p>` : ""}
          </div>
          <footer class="modal-actions">
            <button class="button secondary" id="cancel-collection-share-modal" type="button">Cancelar</button>
            <button class="button" type="submit">Salvar</button>
          </footer>
        </form>
      </section>
    </div>
  `;
}
function renderCollectionDeleteModal() {
    const collection = state.collections.find((item) => item.id === state.deletingCollectionId);
    return `
    <div class="modal-backdrop" role="presentation">
      <section class="modal-panel confirm-modal" role="dialog" aria-modal="true" aria-labelledby="collection-delete-title">
        <header class="modal-header">
          <h2 id="collection-delete-title">Apagar coleção</h2>
          <button class="icon-button" id="close-collection-delete-modal" type="button" aria-label="Fechar">${renderIcon("close")}</button>
        </header>
        <div class="modal-body">
          <p>Tem certeza que deseja apagar "${escapeHtml(collection?.name ?? "esta coleção")}"?</p>
          <p class="modal-help">As obras não serão apagadas da biblioteca, apenas a coleção será removida.</p>
          ${state.collectionDeleteError ? `<p class="error">${escapeHtml(state.collectionDeleteError)}</p>` : ""}
        </div>
        <footer class="modal-actions">
          <button class="button secondary" id="cancel-collection-delete-modal" type="button">Cancelar</button>
          <button class="button danger" id="confirm-collection-delete" type="button">Apagar</button>
        </footer>
      </section>
    </div>
  `;
}
function renderAdminUserModal() {
    const modeTitle = {
        create: "Adicionar usuário",
        edit: "Editar usuário",
        invite: "Gerar convite"
    };
    const isEdit = state.adminUserModalMode === "edit";
    const isInvite = state.adminUserModalMode === "invite";
    return `
    <div class="modal-backdrop" role="presentation">
      <section class="modal-panel user-modal" role="dialog" aria-modal="true" aria-labelledby="user-modal-title">
        <header class="modal-header">
          <h2 id="user-modal-title">${modeTitle[state.adminUserModalMode]}</h2>
          <button class="icon-button" id="close-user-modal" type="button" aria-label="Fechar">${renderIcon("close")}</button>
        </header>
        <form id="user-form">
          <div class="modal-body user-modal-body">
            <div class="user-modal-grid${isInvite ? " invite-user-modal-grid" : ""}">
              <label class="form-row">
                <span>Nome de exibição</span>
                <input class="input" name="displayName" value="${escapeHtml(state.adminUserDraft.displayName)}" placeholder="Nome público" required />
              </label>
              <label class="form-row">
                <span>E-mail</span>
                <input class="input" name="email" type="email" value="${escapeHtml(state.adminUserDraft.email)}" placeholder="email@dominio.com" required />
              </label>
              <label class="form-row">
                <span>Usuário</span>
                <input class="input" name="username" value="${escapeHtml(state.adminUserDraft.username)}" placeholder="usuario" required />
              </label>
              <label class="form-row">
                <span>Permissão</span>
                <select class="input" name="role">
                  <option value="user"${state.adminUserDraft.role === "user" ? " selected" : ""}>Usuário</option>
                  <option value="superuser"${state.adminUserDraft.role === "superuser" ? " selected" : ""}>Superuser</option>
                  <option value="admin"${state.adminUserDraft.role === "admin" ? " selected" : ""}>Admin</option>
                </select>
              </label>
              ${isInvite
        ? `
                    <div class="modal-help user-modal-note">Preencha os campos ou gere um link único direto.</div>
                    <div class="invite-link-only">
                      <button class="button secondary" id="create-link-invite-button" type="button">Convidar com link</button>
                    </div>
                  `
        : `
                    <label class="form-row">
                      <span>${isEdit ? "Nova senha" : "Senha"}</span>
                      <input class="input" name="password" type="password" value="${escapeHtml(state.adminUserDraft.password)}" ${isEdit ? "" : "required"} placeholder="${isEdit ? "Deixe em branco para manter" : "Senha inicial"}" />
                    </label>
                  `}
            </div>
            ${isInvite
        ? state.libraries.map((library) => `<input type="hidden" name="allowedLibraryIds" value="${escapeHtml(library.id)}" />`).join("")
        : `
                  <fieldset class="user-library-fieldset">
                    <legend>Bibliotecas visíveis</legend>
                    <div class="user-library-list">
                      ${state.libraries.map((library) => `
                        <label class="toggle-row">
                          <input type="checkbox" name="allowedLibraryIds" value="${escapeHtml(library.id)}" ${state.adminUserDraft.allowedLibraryIds.includes(library.id) ? "checked" : ""} />
                          <span>${escapeHtml(library.name)}</span>
                        </label>
                      `).join("")}
                    </div>
                  </fieldset>
                `}
            <div class="user-permissions-grid${isInvite ? " invite-permissions-grid" : ""}">
              <input type="hidden" name="canDownload" value="on" />
              ${isInvite
        ? `
                    <input type="hidden" name="canLogin" value="on" />
                  `
        : `
                    <label class="toggle-row">
                      <input type="checkbox" name="canLogin" ${state.adminUserDraft.canLogin ? "checked" : ""} />
                      <span>Permitir login</span>
                    </label>
                  `}
              ${isInvite
        ? ""
        : `
                    <label class="toggle-row">
                      <input type="checkbox" name="canChangePassword" ${state.adminUserDraft.canChangePassword ? "checked" : ""} />
                      <span>Permitir alterar a própria senha</span>
                    </label>
                  `}
            </div>
            ${state.adminUserModalError ? `<p class="error">${escapeHtml(state.adminUserModalError)}</p>` : ""}
            ${state.adminUserInviteUrl ? `<div class="invite-banner compact"><strong>Convite gerado</strong><button class="button secondary" data-copy-invite type="button">Copiar link</button></div>` : ""}
          </div>
          <footer class="modal-actions">
            <button class="button secondary" id="cancel-user-modal" type="button">Cancelar</button>
            <button class="button" type="submit">${isInvite ? "Gerar convite" : isEdit ? "Salvar usuário" : "Criar usuário"}</button>
          </footer>
        </form>
      </section>
    </div>
  `;
}
function renderUserDeleteModal() {
    const user = state.adminUsers.find((item) => item.id === state.adminUserDeleteId);
    return `
    <div class="modal-backdrop" role="presentation">
      <section class="modal-panel confirm-modal" role="dialog" aria-modal="true" aria-labelledby="user-delete-title">
        <header class="modal-header">
          <h2 id="user-delete-title">Apagar usuário</h2>
          <button class="icon-button" id="close-user-delete-modal" type="button" aria-label="Fechar">${renderIcon("close")}</button>
        </header>
        <div class="modal-body">
          <p>Tem certeza que deseja apagar "${escapeHtml(user?.displayName || user?.username || "este usuário")}"?</p>
          <p class="modal-help">Isso remove acesso, progresso, bookmarks, coleções e reviews dessa conta.</p>
          ${state.adminUserModalError ? `<p class="error">${escapeHtml(state.adminUserModalError)}</p>` : ""}
        </div>
        <footer class="modal-actions">
          <button class="button secondary" id="cancel-user-delete-modal" type="button">Cancelar</button>
          <button class="button danger" id="confirm-user-delete" type="button">Apagar</button>
        </footer>
      </section>
    </div>
  `;
}
function renderContinueReading() {
    if (state.progress.length === 0) {
        return "";
    }
    return `
    <section class="empty">
      <strong>Continue lendo</strong>
      <p class="muted">A API já registra o progresso por usuário. A próxima etapa liga esses registros às capas e páginas reais.</p>
    </section>
  `;
}
function renderSeriesView(content, activeLibrary) {
    const marked = state.seriesMarks.includes(content.id);
    const progress = getProgressForContent(content.id);
    const seriesLibrary = state.libraries.find((library) => library.id === content.libraryId) ?? activeLibrary;
    if (content.pageTypes.length === 1 && content.pageTypes[0] === 'pdf') {
        const bookmarks = getBookmarksForContent(content.id);
        return renderPdfDetails(content, seriesLibrary, progress, marked, bookmarks.length ? renderMarkedPageRows(bookmarks, [content]) : '', bookmarks.length);
    }
    const chapterLabel = content.chapterCount === 1 ? "capítulo" : "capítulos";
    const mainChapters = content.chapters.filter((chapter) => !chapter.isSpecial);
    const specialChapters = content.chapters.filter((chapter) => chapter.isSpecial);
    const progressLabel = getProgressChapterLabel(content, progress);
    const activeReviews = state.seriesReviews[content.id] ?? [];
    const reviewCount = activeReviews.length;
    const visibleChapters = state.seriesTab === "specials" ? specialChapters : mainChapters;
    const chapters = getOrderedChapters(visibleChapters, progress);
    const releaseYear = getReleaseYear(content.releaseDate);
    const authors = content.authors?.filter(name => name.trim()).join(", ") || "N/A";
    const artists = content.artists?.filter(name => name.trim()).join(", ") || "N/A";
    const genres = content.genres.slice(0, 6);
    const isBook = seriesLibrary?.kind === "book";
    const googleRating = isBook ? (content.externalRating ?? null) : null;
    const personalRating = activeReviews.find((review) => review.userId === state.user?.id)?.rating ?? null;
    return `
    <section class="series-detail">
      <button class="series-back-link" data-series-back type="button">${renderIcon("back")} <span>Voltar</span></button>
      <div class="series-detail-hero">
        <div class="series-detail-cover">
          ${content.coverUrl
        ? `<img class="series-detail-image" src="${escapeHtml(content.coverUrl)}" alt="Capa de ${escapeHtml(content.title)}" loading="eager" />`
        : `<div class="series-detail-placeholder">${escapeHtml(content.title.slice(0, 1).toUpperCase())}</div>`}
        </div>
        <div class="series-detail-info">
          <div class="series-kicker-row">
            <span class="series-library-chip">${escapeHtml(getSeriesKindLabel(seriesLibrary?.kind))}</span>
            <span class="series-status-chip">${progress ? "Em leitura" : "Disponível"}</span>
            ${(seriesLibrary?.kind === "manga" || seriesLibrary?.kind === "manhwa") && isPublicationCompleted(content.publicationStatus) ? '<span class="series-status-chip publication-completed">Finalizada</span>' : ""}
          </div>
          <h1>${escapeHtml(content.title)}</h1>
          <div class="series-original-title">${escapeHtml(seriesLibrary?.name ?? "Biblioteca")}</div>
          <div class="series-genre-row"${genres.length ? "" : ' aria-hidden="true"'}>${genres.map((genre) => `<span>${escapeHtml(genre)}</span>`).join("")}</div>
          <div class="series-detail-stats" aria-label="Resumo da obra">
            <div class="series-stat-card">
              ${isBook
        ? `<div class="series-rating-sources">
                    <div class="series-rating-source">
                      <span class="series-rating-label">Google Books<small>Nota da comunidade</small></span>
                      ${renderSeriesRatingDisplay(googleRating, "/5")}
                    </div>
                    <div class="series-rating-source">
                      <span class="series-rating-label">Minha avaliação<small>Sua nota para a obra</small></span>
                      ${renderPersonalRatingDisplay(personalRating)}
                    </div>
                  </div>`
        : `<div class="series-rating-sources"><div class="series-rating-source"><span class="series-rating-label">Nota da fonte</span>${renderSeriesRatingDisplay(content.rating)}</div><div class="series-rating-source"><span class="series-rating-label">Minha avaliação</span><span class="series-personal-rating-group">${renderPersonalRatingDisplay(personalRating)}<button class="series-stat-note series-reviews-link" data-series-tab="reviews" type="button">${reviewCount} ${reviewCount === 1 ? "review" : "reviews"}</button></span></div></div>`}
            </div>
            <div class="series-stat-card">
              <span class="series-stat-icon">${renderIcon("release")}</span>
              <strong>${escapeHtml(releaseYear)}</strong>
              <span>Lançamento</span>
            </div>
          </div>
          <div class="series-detail-actions">
            <button class="series-primary-action" data-series-continue="${content.id}" type="button">
              ${renderIcon("continue")} ${progress ? "Continuar leitura" : "Ler primeiro"}
            </button>
            <button class="series-secondary-action${marked ? " active-mark" : ""}" data-series-mark-toggle="${content.id}" type="button">
              ${renderIcon(marked ? "ratingFilled" : "rating")} ${marked ? "Favoritado" : "Favoritar"}
            </button>
            <span class="series-secondary-action inert">${renderIcon("progress")} ${escapeHtml(progressLabel)}</span>
            <span class="series-secondary-action inert series-count-action">
              ${renderIcon("bookmarks")} <strong>${content.chapterCount}</strong> ${chapterLabel}
            </span>
            <span class="series-secondary-action inert series-count-action">
              ${renderIcon("all")} <strong>${content.pageCount}</strong> páginas
            </span>
          </div>
          <div class="series-creator-grid">
            <div><span>Autor(es):</span> <strong>${escapeHtml(authors)}</strong></div>
            <div><span>Artista(s):</span> <strong>${escapeHtml(artists)}</strong></div>
          </div>
        </div>
        <section class="series-description-card" aria-label="Sinopse">
          <h2>Sinopse</h2>
          <p class="series-description${content.description ? "" : " muted"}">${escapeHtml(content.description?.trim() || "Sem sinopse disponível para esta obra.")}</p>
        </section>
      </div>
      ${seriesLibrary?.kind === 'other' && content.pageTypes.includes('pdf') ? '<section class="rpg-panel" data-rpg-panel><p class="muted">Carregando módulos e fichas…</p></section>' : ''}
      <div class="series-tabs" role="tablist" aria-label="Seções da série">
        ${renderSeriesTabButton("chapters", "Capítulos", mainChapters.length)}
        ${renderSeriesTabButton("specials", "Especiais", specialChapters.length)}
        ${renderSeriesTabButton("reviews", "Reviews", reviewCount)}
        ${renderSeriesTabButton("bookmarks", "Páginas marcadas", getBookmarksForContent(content.id).length)}
      </div>
      <div class="series-detail-body">
        ${state.seriesTab === "reviews"
        ? renderSeriesReviewsTab(content, activeReviews)
        : state.seriesTab === "bookmarks" ? renderMarkedPageRows(getBookmarksForContent(content.id), [content]) : `
              <div class="series-controls">
                <label class="series-control-group">
                  <span class="series-control-label">Ordenação</span>
                  <select class="input series-control-select" data-series-order>
                    <option value="asc" ${state.seriesChapterOrder === "asc" ? "selected" : ""}>Do começo para o final</option>
                    <option value="desc" ${state.seriesChapterOrder === "desc" ? "selected" : ""}>Do final para o começo</option>
                    <option value="last-read" ${state.seriesChapterOrder === "last-read" ? "selected" : ""}>Último marcado como lido</option>
                  </select>
                </label>
                <div class="series-layout-toggle" role="group" aria-label="Modo de exibição dos capítulos">
                  <button class="series-layout-button${state.seriesChapterLayout === "list" ? " active" : ""}" data-series-layout="list" type="button">Lista</button>
                  <button class="series-layout-button${state.seriesChapterLayout === "grid" ? " active" : ""}" data-series-layout="grid" type="button">Grade</button>
                </div>
              </div>
              <section class="series-chapters">
                <div class="series-section-heading">
                  <h2>${state.seriesTab === "specials" ? "Especiais" : "Capítulos"}</h2>
                  <span>${visibleChapters.length} ${state.seriesTab === "specials" ? "especiais" : chapterLabel}</span>
                </div>
                ${chapters.length
            ? `<div class="chapter-list ${state.seriesChapterLayout === "grid" ? "grid" : "list"}">${chapters.map((chapter, index) => renderChapterCard(content, chapter, index, state.seriesChapterLayout)).join("")}</div>`
            : `<p class="empty compact">Nenhum ${state.seriesTab === "specials" ? "especial" : "capítulo"} detectado.</p>`}
              </section>
            `}
      </div>
    </section>
  `;
}
function getSeriesKindLabel(kind) {
    const labels = {
        manga: "Mangá",
        manhwa: "Manhwa",
        book: "Livro",
        comic: "Quadrinho",
        lightNovel: "Light Novel",
        other: "Obra"
    };
    return kind ? labels[kind] : "Obra";
}
function getReleaseYear(releaseDate) {
    if (!releaseDate) {
        return "N/A";
    }
    const yearMatch = releaseDate.match(/\d{4}/);
    return yearMatch?.[0] ?? releaseDate;
}
function renderSeriesRatingDisplay(rating, scale = "") {
    const checked = validRating(rating);
    const value = checked !== null ? Number.parseFloat(checked) : Number.NaN;
    if (!scale && checked?.includes("/"))
        scale = "/" + checked.split("/")[1].trim();
    const displayValue = Number.isFinite(value) ? value.toFixed(1) : "N/A";
    const ratingClass = getRatingClass(rating);
    return `
    <span class="series-rating-display ${ratingClass}">
      <strong>${escapeHtml(displayValue)}</strong>
      ${scale ? `<small>${escapeHtml(scale)}</small>` : ""}
      ${renderIcon("ratingFilled")}
    </span>
  `;
}
function renderPersonalRatingDisplay(rating) {
    const conteudo = typeof rating === "number" && Number.isFinite(rating) ? renderEstrelasReview(rating) : "<strong>N/A</strong>";
    return `<span class="personal-rating-display">${conteudo}</span>`;
}
// Estrela do Tabler Icons em duas camadas: o contorno e o preenchimento, inteiro ("cheia") ou só na metade esquerda ("meia").
function renderEstrelaTabler(estado = "") {
    const estrela = "M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z";
    return `<svg class="review-estrela${estado ? ` ${estado}` : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${estrela}"/><path class="preenchimento" d="${estrela}"/></svg>`;
}
function notaEmEstrelas(nota) {
    return Math.min(5, Math.max(0, Math.round((Number(nota) || 0) * 2) / 2));
}
function formatarNotaEstrelas(nota) {
    return String(nota).replace(".", ",");
}
function renderEstrelasReview(nota) {
    const estrelas = notaEmEstrelas(nota);
    const icones = [1, 2, 3, 4, 5].map((posicao) => renderEstrelaTabler(estrelas >= posicao ? "cheia" : estrelas >= posicao - 0.5 ? "meia" : ""));
    return `<span class="review-estrelas" role="img" aria-label="${formatarNotaEstrelas(estrelas)} de 5 estrelas">${icones.join("")}</span>`;
}
function renderCampoEstrelasReview(notaAtual) {
    const estrelas = notaEmEstrelas(notaAtual);
    const opcao = (valor, lado) => `<label class="${lado}" title="${formatarNotaEstrelas(valor)} de 5"><input type="radio" name="rating" value="${valor}" aria-label="${formatarNotaEstrelas(valor)} de 5 estrelas" required${valor === estrelas ? " checked" : ""} /></label>`;
    // A nota mínima é 1, então a primeira estrela não tem metade.
    const pares = [1, 2, 3, 4, 5].map((posicao) => `<span class="review-estrela-par">${renderEstrelaTabler()}${posicao > 1 ? opcao(posicao - 0.5, "esquerda") : ""}${opcao(posicao, posicao > 1 ? "direita" : "direita inteira")}</span>`);
    return `<fieldset class="review-estrelas-campo">
            <legend>Nota</legend>
            <div class="review-estrelas-opcoes">${pares.join("")}</div>
          </fieldset>`;
}
function renderSeriesTabButton(tab, label, count) {
    const active = state.seriesTab === tab ? " active" : "";
    return `
    <button class="series-tab-button${active}" data-series-tab="${tab}" type="button" role="tab" aria-selected="${state.seriesTab === tab}">
      <span>${escapeHtml(label)}</span>
      <span class="series-tab-count">${count}</span>
    </button>
  `;
}
function renderSeriesReviewsTab(content, reviews) {
    const currentUserReview = reviews.find((review) => review.userId === state.user?.id) ?? null;
    return `
    <section class="series-reviews">
      <form class="review-form" data-review-form>
        <div class="series-section-heading">
          <h2>Escreva sua review</h2>
          <span>${reviews.length} ${reviews.length === 1 ? "review" : "reviews"}</span>
        </div>
        <div class="review-form-grid">
          ${renderCampoEstrelasReview(currentUserReview?.rating)}
          <label class="form-row review-comment">
            <span>Comentário</span>
            <textarea class="input" name="comment" rows="5" placeholder="Compartilhe sua opinião com outros leitores...">${escapeHtml(currentUserReview?.comment ?? "")}</textarea>
          </label>
        </div>
        <div class="review-form-actions">
          <button class="button" type="submit">Publicar review</button>
          ${state.seriesReviewError ? `<p class="error">${escapeHtml(state.seriesReviewError)}</p>` : ""}
        </div>
      </form>
      <div class="series-review-list">
        ${reviews.length
        ? reviews.map((review) => renderReviewCard(review)).join("")
        : `<p class="empty compact">Ainda não há reviews para esta obra.</p>`}
      </div>
    </section>
  `;
}
function renderReviewCard(review) {
    return `
    <article class="review-card">
      <div class="review-card-header">
        <div>
          <strong>${escapeHtml(review.displayName)}</strong>
          <p>${escapeHtml(review.role === "admin" ? "Administrador" : review.role === "superuser" ? "Superuser" : "Usuário")}</p>
        </div>
        ${renderEstrelasReview(review.rating)}
      </div>
      <p class="review-comment-text">${escapeHtml(review.comment)}</p>
      <p class="review-date">${escapeHtml(new Date(review.updatedAt).toLocaleString("pt-BR"))}</p>
    </article>
  `;
}
function renderSeriesMetaItem(label, value, icon, extraClass = "") {
    const classes = ["series-meta-item", extraClass].filter(Boolean).join(" ");
    return `
    <div class="${classes}">
      <span class="series-meta-icon" aria-hidden="true">${icon}</span>
      <div>
        <span class="series-meta-label">${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    </div>
  `;
}
function getProgressChapterLabel(content, progress) {
    if (!progress) {
        return "Sem progresso";
    }
    const chapter = content.chapters.find((item) => {
        const endPage = item.startPage + item.pageCount - 1;
        return progress.currentPage >= item.startPage && progress.currentPage <= endPage;
    });
    if (!chapter) {
        return `Página ${progress.currentPage + 1}`;
    }
    return chapter.name;
}
function renderChapterCard(content, chapter, index, layout) {
    return `
    <button class="chapter-card ${layout === "grid" ? "grid" : "list"}" data-chapter-open="${escapeHtml(content.id)}" data-chapter-start="${chapter.startPage}" type="button">
      <span class="chapter-card-index">${index + 1}</span>
      <span class="chapter-card-name">${escapeHtml(chapter.name)}</span>
      <span class="chapter-card-meta">${chapter.pageCount} páginas</span>
      ${chapter.isSpecial ? `<span class="chapter-badge">Especial</span>` : ""}
    </button>
  `;
}
function getOrderedChapters(chapters, progress) {
    const ordered = [...chapters];
    if (state.seriesChapterOrder === "desc") {
        return ordered.sort((a, b) => b.startPage - a.startPage);
    }
    if (state.seriesChapterOrder === "last-read") {
        const currentPage = progress?.currentPage ?? 0;
        const activeIndex = ordered.findIndex((chapter) => {
            const endPage = chapter.startPage + chapter.pageCount - 1;
            return currentPage >= chapter.startPage && currentPage <= endPage;
        });
        if (activeIndex > 0) {
            const [activeChapter] = ordered.splice(activeIndex, 1);
            if (activeChapter) {
                return [activeChapter, ...ordered.sort((a, b) => a.startPage - b.startPage)];
            }
        }
    }
    return ordered.sort((a, b) => a.startPage - b.startPage);
}
function getRatingClass(rating) {
    const checked = validRating(rating);
    const value = checked !== null ? Number.parseFloat(checked) : Number.NaN;
    if (Number.isNaN(value)) {
        return "rating-empty";
    }
    if (value >= 8) {
        return "rating-blue";
    }
    if (value >= 4) {
        return "rating-yellow";
    }
    return "rating-white";
}
function getReaderModeLabel(mode) {
    const labels = {
        horizontal: "Horizontal",
        "paged-vertical": "Vertical paginado",
        "vertical-scroll": "Scroll"
    };
    return labels[mode];
}
function getReaderModeIconLabel(mode) {
    const icons = {
        horizontal: renderIcon("readerHorizontal"),
        "paged-vertical": renderIcon("readerPagedVertical"),
        "vertical-scroll": renderIcon("readerScroll")
    };
    return icons[mode];
}
function getNextReaderMode(mode) {
    if (mode === "vertical-scroll")
        return "horizontal";
    return "vertical-scroll";
}
function getFittingLabel(fitting) {
    const labels = {
        height: "Página inteira",
        width: "Preencher largura",
        original: "Tamanho real"
    };
    return labels[fitting];
}
function getFittingShortLabel(fitting) {
    const labels = {
        height: "Inteira",
        width: "Largura",
        original: "Real"
    };
    return labels[fitting];
}
function getNextFittingMode(fitting) {
    if (fitting === "height")
        return "width";
    if (fitting === "width")
        return "original";
    return "height";
}
function clampReaderZoom(zoom) {
    return Math.min(Math.max(Math.round(zoom), 50), 250);
}
function setReaderZoom(zoom) {
    if (!state.reader)
        return;
    state.reader.zoom = clampReaderZoom(zoom);
    state.reader.controlsVisible = true;
    if (state.reader.content.pageTypes.includes("pdf")) {
        // Zoom PDF: vincula o valor à escala real dos canvases re-renderizando apenas
        // as páginas visíveis/próximas da viewport, sem reinicializar o documento
        // (evita renderShell / iniciarLeitorPdf) e preservando a posição.
        atualizarRotuloZoomPdf();
        aplicarZoomPdf(state.reader.zoom / 100, obterPaginaAtualPdf());
        return;
    }
    if (state.reader.content.pageTypes.includes("epub")) {
        const frame = document.querySelector(".reader-epub");
        if (frame) {
            state.reader.epubOffset = getEpubCurrentOffset(frame);
            applyEpubAppearance(frame, true);
        }
        renderEpubOverlay();
        return;
    }
    renderShell();
    if (state.reader.mode === "vertical-scroll" && !state.reader.content.pageTypes.includes("epub")) {
        requestAnimationFrame(() => scrollReaderToPage(state.reader?.page ?? 0));
    }
}
function atualizarRotuloZoomPdf() {
    const rotulo = document.querySelector(".reader-pdf-zoom-value");
    const zoom = state.reader?.zoom ?? 100;
    if (rotulo) {
        rotulo.textContent = `${zoom}%`;
        rotulo.setAttribute("aria-label", `Zoom ${zoom}%. Voltar a 100%`);
        rotulo.title = `Zoom ${zoom}% · Voltar a 100%`;
    }
    const diminuir = document.querySelector(".reader-pdf-zoom-control [data-reader-action=zoom-out]");
    const aumentar = document.querySelector(".reader-pdf-zoom-control [data-reader-action=zoom-in]");
    if (diminuir)
        diminuir.disabled = zoom <= 50;
    if (aumentar)
        aumentar.disabled = zoom >= 250;
}
function getContentProgressPercent(content, page) {
    if (content.pageCount <= 1) {
        return content.pageCount === 0 ? 0 : 100;
    }
    return Math.round((page / (content.pageCount - 1)) * 100);
}
function getChapterForPage(content, page) {
    return content.chapters.find((chapter) => {
        const endPage = chapter.startPage + chapter.pageCount - 1;
        return page >= chapter.startPage && page <= endPage;
    }) ?? null;
}
function getReaderChapterProgress(content, page) {
    const chapter = getChapterForPage(content, page);
    const startPage = chapter?.startPage ?? 0;
    const pageCount = Math.max(chapter?.pageCount ?? content.pageCount, 1);
    const endPage = Math.min(startPage + pageCount - 1, Math.max(content.pageCount - 1, 0));
    return {
        startPage,
        endPage,
        currentPage: Math.min(Math.max(page - startPage + 1, 1), pageCount),
        pageCount
    };
}
function hasAdjacentChapter(content, page, direction) {
    const chapters = [...content.chapters].sort((a, b) => a.startPage - b.startPage);
    if (chapters.length <= 1) {
        return false;
    }
    const currentIndex = chapters.findIndex((chapter) => {
        const endPage = chapter.startPage + chapter.pageCount - 1;
        return page >= chapter.startPage && page <= endPage;
    });
    const fallbackIndex = chapters.findIndex((chapter) => chapter.startPage > page);
    const index = currentIndex >= 0 ? currentIndex : fallbackIndex >= 0 ? fallbackIndex : chapters.length - 1;
    return direction < 0 ? index > 0 : index < chapters.length - 1;
}
function getAdjacentChapterStartPage(content, page, direction) {
    const chapters = [...content.chapters].sort((a, b) => a.startPage - b.startPage);
    if (chapters.length === 0) {
        return page;
    }
    const currentIndex = chapters.findIndex((chapter) => {
        const endPage = chapter.startPage + chapter.pageCount - 1;
        return page >= chapter.startPage && page <= endPage;
    });
    const fallbackIndex = chapters.findIndex((chapter) => chapter.startPage > page);
    const index = currentIndex >= 0 ? currentIndex : fallbackIndex >= 0 ? fallbackIndex : chapters.length - 1;
    const next = chapters[Math.min(Math.max(index + direction, 0), chapters.length - 1)];
    return next?.startPage ?? page;
}
function closeReader() {
    void exitReaderFullscreen().catch(() => undefined);
    const reader = state.reader;
    if (!reader)
        return;
    epubPanel = "none";
    if (reader.content.pageTypes.includes("epub")) {
        const frame = document.querySelector(".reader-epub");
        if (frame) {
            reader.epubOffset = getEpubCurrentOffset(frame);
            scheduleReaderProgressSave(reader.content, reader.page, reader.epubOffset);
        }
    }
    if (reader.mode === "vertical-scroll" && !reader.content.pageTypes.includes("pdf")) {
        const visiblePage = getVisibleReaderPage();
        if (visiblePage !== null && visiblePage !== reader.page) {
            reader.page = visiblePage;
            scheduleReaderProgressSave(reader.content, visiblePage);
        }
    }
    clearReaderLoadingTimer();
    readerPrefetchGeneration += 1;
    epubPrefetch?.abort();
    epubPrefetch = null;
    readerImageCache.clear();
    releaseReaderImageWindow?.();
    releaseReaderImageWindow = null;
    encerrarLeitorPdf();
    pendingReaderPage = null;
    readerNavigationId += 1;
    router.backTo({ kind: "title", libraryId: reader.content.libraryId, contentId: reader.content.id });
}
function bindReaderPdfHomeButton() {
    document.querySelector(".reader-pdf-back")?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeReader();
    });
}
function renderContadorAbsoluto(content, safePage) {
    if (content.pageTypes.includes("epub")) {
        const total = content.chapters.length > 0 ? content.chapters.length : Math.max(content.pageCount, 1);
        const indiceCapitulo = content.chapters.findIndex((capitulo) => {
            const fim = capitulo.startPage + capitulo.pageCount - 1;
            return safePage >= capitulo.startPage && safePage <= fim;
        });
        const atual = Math.max((indiceCapitulo >= 0 ? indiceCapitulo + 1 : safePage + 1), 1);
        return ` · Capítulo ${atual}/${total}`;
    }
    if (content.pageTypes.includes("pdf")) {
        return ` · Página ${obterPaginaAtualPdf()}/${obterTotalPaginasPdf()}`;
    }
    return ` · Página ${Math.min(safePage + 1, Math.max(content.pageCount, 1))}/${Math.max(content.pageCount, 1)}`;
}
function atualizarContadorAbsoluto() {
    if (!state.reader)
        return;
    const elemento = document.querySelector("[data-reader-absolute-progress]");
    if (!elemento)
        return;
    elemento.textContent = renderContadorAbsoluto(state.reader.content, state.reader.page);
}
function renderReaderOverlay() {
    if (!state.reader)
        return;
    const { content, page, mode, fitting, direction, zoom, brightness, controlsVisible } = state.reader;
    if (content.pageTypes.includes("pdf")) {
        const readerSection = document.querySelector(".reader-pdf-reader");
        readerSection?.classList.toggle("controls-visible", controlsVisible);
        if (pdfControlsHideTimer !== null) window.clearTimeout(pdfControlsHideTimer);
        pdfControlsHideTimer = controlsVisible ? window.setTimeout(() => {
            if (!state.reader?.content.pageTypes.includes("pdf")) return;
            if (marcadoresPdfAbertos()) { pdfControlsHideTimer = null; return; }
            state.reader.controlsVisible = false;
            document.querySelector(".reader-pdf-reader")?.classList.remove("controls-visible");
            pdfControlsHideTimer = null;
        }, 3000) : null;
        atualizarRotuloZoomPdf();
        atualizarBotaoMarcadorPdf(page);
        updateReaderFullscreenButton();
        return;
    }
    if (content.pageTypes.includes("epub")) {
        renderEpubOverlay();
        return;
    }
    const safePage = safeReaderPage(content, page);
    const pageBookmarked = isPageBookmarked(content.id, safePage);
    const chapterProgress = getReaderChapterProgress(content, safePage);
    const modeIcon = getReaderModeIconLabel(mode);
    const modeLabel = getReaderModeLabel(mode);
    const fittingLabel = getFittingLabel(fitting);
    const topHtml = `
    <div class="reader-overlay-inner">
      <button class="reader-btn-icon reader-back-btn" data-reader-action="close" type="button" aria-label="Voltar" title="Voltar (Esc)" aria-keyshortcuts="Escape">${renderIcon("back")}</button>
      <div class="reader-title-group">
        <div class="reader-title-text">${escapeHtml(content.title)}</div>
        <div class="reader-subtitle">${escapeHtml(getChapterForPage(content, safePage)?.name ?? `Página ${safePage + 1}`)} · ${getContentProgressPercent(content, safePage)}%<span class="reader-absolute-progress" data-reader-absolute-progress>${renderContadorAbsoluto(content, safePage)}</span></div>
      </div>
      <div class="reader-overlay-right">
        <button class="reader-btn-icon reader-image-bookmark${pageBookmarked ? " is-active" : ""}" data-reader-action="bookmark" type="button" aria-label="${pageBookmarked ? "Remover marcador" : "Marcar página"}" aria-pressed="${pageBookmarked}" title="${pageBookmarked ? "Remover marcador" : "Marcar página"} (B)" aria-keyshortcuts="B">${renderIcon("bookmarks")}</button>
      </div>
    </div>
  `;
    const bottomHtml = `
    <div class="reader-slider-row">
      <div class="reader-slider-inner" ${direction === "rtl" && mode !== "vertical-scroll" ? 'dir="rtl"' : ""}>
        <button class="reader-btn-icon" data-reader-action="chapter-prev" type="button" title="Capítulo anterior" aria-label="Capítulo anterior">${renderIcon("rewind")}</button>
        <button class="reader-btn-icon" data-reader-action="page-prev" type="button" title="Página anterior" aria-label="Página anterior">${renderIcon("back")}</button>
        <div class="reader-slider-track">
          <span>${chapterProgress.currentPage}</span>
          <input data-reader-page-slider type="range" min="${chapterProgress.startPage}" max="${Math.max(chapterProgress.endPage, 0)}" value="${safePage}" aria-label="Página" />
          <span>${chapterProgress.pageCount}</span>
        </div>
        <button class="reader-btn-icon reader-next-page-btn" data-reader-action="page-next" type="button" title="Próxima página" aria-label="Próxima página">${renderIcon("back")}</button>
        <button class="reader-btn-icon" data-reader-action="chapter-next" type="button" title="Próximo capítulo" aria-label="Próximo capítulo">${renderIcon("fastForward")}</button>
      </div>
    </div>
    <div class="reader-action-row">
      <button class="reader-action-btn" data-reader-action="toggle-fitting" type="button" title="${fittingLabel}. Mudar para ${getFittingLabel(getNextFittingMode(fitting))}" aria-label="Ajuste da imagem: ${fittingLabel}. Mudar para ${getFittingLabel(getNextFittingMode(fitting))}">
        <span class="icon">${renderFittingIcon(fitting)}</span>
        <span class="label">${getFittingShortLabel(fitting)}</span>
      </button>
      <button class="reader-action-btn" data-reader-action="toggle-mode" type="button" title="${modeLabel} (M)" aria-keyshortcuts="M">
        <span class="icon">${modeIcon}</span>
        <span class="label">${modeLabel}</span>
      </button>
      <button class="reader-action-btn reader-fullscreen" data-reader-action="fullscreen" type="button" aria-label="${escapeHtml(getReaderFullscreenLabel())}" title="${escapeHtml(getReaderFullscreenLabel())} (F)" aria-keyshortcuts="F" ${isReaderFullscreenAvailable() ? "" : "disabled"}>
        <span class="icon">${renderReaderFullscreenIcon()}</span>
        <span class="label">Tela cheia</span>
      </button>
      <div class="reader-zoom-control" aria-label="Zoom">
        <button class="reader-btn-icon compact" data-reader-action="zoom-out" type="button" title="Diminuir zoom" aria-label="Diminuir zoom">${renderIcon("minus")}</button>
        <button class="reader-zoom-value" data-reader-action="zoom-reset" type="button" title="Resetar zoom" aria-label="Resetar zoom">${zoom}%</button>
        <button class="reader-btn-icon compact" data-reader-action="zoom-in" type="button" title="Aumentar zoom" aria-label="Aumentar zoom">${renderIcon("plus")}</button>
      </div>
      <div class="reader-brightness-control">
        <span>${renderIcon("sun")}</span>
        <input data-reader-brightness type="range" min="10" max="100" value="${brightness}" aria-label="Brilho" />
      </div>
    </div>
  `;
    const topOverlay = document.querySelector(".reader-overlay.top");
    const bottomOverlay = document.querySelector(".reader-overlay.bottom");
    const readerSection = document.querySelector(".reader");
    if (topOverlay) {
        topOverlay.innerHTML = topHtml;
        topOverlay.setAttribute("aria-hidden", String(!controlsVisible));
    }
    if (bottomOverlay) {
        bottomOverlay.innerHTML = bottomHtml;
        bottomOverlay.setAttribute("aria-hidden", String(!controlsVisible));
    }
    if (readerSection) {
        readerSection.classList.toggle("controls-visible", controlsVisible);
        readerSection.style.setProperty("--reader-brightness", `${brightness}%`);
        readerSection.style.setProperty("--reader-zoom-percent", `${zoom}%`);
        readerSection.style.setProperty("--reader-zoom-scale", String(zoom / 100));
        readerSection.style.setProperty("--reader-max-width", `${Math.round(980 * (zoom / 100))}px`);
    }
}
function renderEpubOverlay() {
    const reader = state.reader;
    if (!reader)
        return;
    const { content, page, controlsVisible, epubOffset, epubLengths } = reader;
    const percent = epubBookPercent(epubLengths.length === content.pageCount ? epubLengths : Array(content.pageCount).fill(1), page, epubOffset);
    const chapter = getChapterForPage(content, page);
    const top = document.querySelector(".reader-overlay.top");
    const bottom = document.querySelector(".reader-overlay.bottom");
    const section = document.querySelector(".reader");
    if (top) {
        top.innerHTML = `<div class="reader-overlay-inner epub-toolbar">
      <button class="reader-btn-icon reader-back-btn" data-reader-action="close" aria-label="Voltar" title="Voltar">${renderIcon("back")}</button>
      <div class="reader-title-group"><div class="reader-title-text">${escapeHtml(content.title)}</div><div class="reader-subtitle">${escapeHtml(chapter?.name ?? `Trecho ${page + 1}`)} · <span data-epub-progress>${percent}</span>%<span class="reader-absolute-progress" data-reader-absolute-progress>${renderContadorAbsoluto(content, page)}</span></div></div>
      <button class="reader-btn-icon" data-reader-action="epub-toc" aria-label="Sumário" title="Sumário">☰</button>
      <button class="reader-btn-icon" data-reader-action="bookmark" aria-label="${isPageBookmarked(content.id, page) ? "Remover marcador" : "Marcar trecho"}" title="Marcador (B)">${renderIcon(isPageBookmarked(content.id, page) ? "bookmarksFilled" : "bookmarks")}</button>
    </div>`;
        top.setAttribute("aria-hidden", String(!controlsVisible));
    }
    if (bottom) {
        bottom.innerHTML = `<div class="epub-bottom-inner">
      <div class="epub-progress-track" role="progressbar" aria-label="Progresso no livro" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div>
      <div class="reader-action-row epub-actions">
        <button class="reader-action-btn" data-reader-action="epub-appearance" aria-expanded="${epubPanel === "appearance"}"><span class="icon">Aa</span><span class="label">Aparência</span></button>
        <button class="reader-action-btn" data-reader-action="epub-view" title="${reader.mode === "vertical-scroll" ? "Mudar para páginas" : "Mudar para rolagem"}" aria-label="Modo de leitura: ${reader.mode === "vertical-scroll" ? "Rolagem" : "Páginas"}. ${reader.mode === "vertical-scroll" ? "Mudar para páginas" : "Mudar para rolagem"}"><span class="icon">${renderEpubViewIcon(reader.mode)}</span><span class="label">${reader.mode === "vertical-scroll" ? "Rolagem" : "Páginas"}</span></button>
        <button class="reader-action-btn" data-reader-action="epub-search" aria-expanded="false"><span class="icon">${renderIcon("search")}</span><span class="label">Buscar</span></button>
        <button class="reader-action-btn" data-reader-action="toggle-book-theme"><span class="icon">${renderIcon(reader.bookTheme === "dark" ? "moon" : "sun")}</span><span class="label">${reader.bookTheme === "light" ? "Claro" : reader.bookTheme === "sepia" ? "Sépia" : "Escuro"}</span></button>
        <button class="reader-action-btn reader-fullscreen" data-reader-action="fullscreen" aria-label="${escapeHtml(getReaderFullscreenLabel())}" ${isReaderFullscreenAvailable() ? "" : "disabled"}><span class="icon">${renderReaderFullscreenIcon()}</span><span class="label">Tela cheia</span></button>
        <div class="reader-zoom-control" role="group" aria-label="Zoom"><button class="reader-btn-icon compact" data-reader-action="zoom-out" aria-label="Diminuir zoom">${renderIcon("minus")}</button><button class="reader-zoom-value" data-reader-action="zoom-reset" aria-label="Zoom ${reader.zoom}%. Voltar a 100%">${reader.zoom}%</button><button class="reader-btn-icon compact" data-reader-action="zoom-in" aria-label="Aumentar zoom">${renderIcon("plus")}</button></div>
        <label class="reader-brightness-control">${renderIcon("sun")}<input data-reader-brightness type="range" min="10" max="100" value="${reader.brightness}" aria-label="Brilho" /></label>
      </div>
      ${epubPanel === "appearance" ? `<div class="epub-panel" role="group" aria-label="Aparência do livro">
        <label>Fonte<select data-epub-setting="font"><option value="serif" ${reader.epubFont === "serif" ? "selected" : ""}>Com serifa</option><option value="sans" ${reader.epubFont === "sans" ? "selected" : ""}>Sem serifa</option></select></label>
        <label>Tamanho <input data-epub-setting="size" type="range" min="14" max="32" value="${reader.epubFontSize}" /></label>
        <label>Entrelinhas <input data-epub-setting="line" type="range" min="1.3" max="2.2" step="0.1" value="${reader.epubLineHeight}" /></label>
        <label>Margens <input data-epub-setting="margin" type="range" min="12" max="64" value="${reader.epubMargin}" /></label>
        <div class="epub-appearance-actions">
        <button class="reader-btn-icon epub-appearance-reset" data-reader-action="epub-appearance-reset" type="button" aria-label="Restaurar aparência padrão" title="Restaurar fonte, tamanho, entrelinhas e margens">${renderIconeToolbarPdf("M4 7h16M10 11v6m4-6v6M5 7l1 13h12l1-13M9 7V4h6v3")}</button>
        <button class="reader-btn-icon" data-reader-action="epub-appearance-close" type="button" aria-label="Fechar aparência" title="Fechar aparência">${renderIconeToolbarPdf("M6 6l12 12M18 6 6 18")}</button>
        </div>
      </div>` : ""}
      ${epubPanel === "toc" ? `<div class="epub-panel epub-toc" role="navigation" aria-label="Sumário do livro">${content.chapters.map(ch => `<button data-reader-action="epub-goto" data-epub-page="${ch.startPage}" type="button">${escapeHtml(ch.name)}</button>`).join("")}</div>` : ""}
    </div>`;
        bottom.setAttribute("aria-hidden", String(!controlsVisible));
    }
    section?.classList.toggle("controls-visible", controlsVisible);
    section?.style.setProperty("--reader-brightness", `${reader.brightness}%`);
}
function renderEpubViewIcon(mode) {
    if (mode === "vertical-scroll") {
        return '<svg class="reader-pdf-toolbar-icon" data-epub-view-icon="scroll" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2h12v20H6zM9 6h6M9 9h6M9 12h6M12 15v4m-2-2 2 2 2-2"/></svg>';
    }
    return '<svg class="reader-pdf-toolbar-icon" data-epub-view-icon="pages" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5C9.5 3.5 6.5 3 3 4v15c3.5-1 6.5-.5 9 1 2.5-1.5 5.5-2 9-1V4c-3.5-1-6.5-.5-9 1zm0 0v15M5.5 8h4M5.5 11h4m5-3h4m-4 3h4"/></svg>';
}
function persistEpubAppearance() {
    const reader = state.reader;
    if (!reader?.content.pageTypes.includes("epub"))
        return;
    localStorage.setItem(`pugotiread-epub-appearance:${state.user?.id}`, JSON.stringify({
        theme: reader.bookTheme, font: reader.epubFont,
        size: reader.epubFontSize, line: reader.epubLineHeight, margin: reader.epubMargin
    }));
}
function renderFittingIcon(fitting) {
    const paths = {
        height: "M3 3h18v18H3zM9 5h6v14H9z",
        width: "M3 3h18v18H3zM5 12h14m-11-3-3 3 3 3m8-6 3 3-3 3",
        original: "M3 3h18v18H3zM7 7h3v3H7zM14 14h3v3h-3z"
    };
    return `<svg class="reader-pdf-toolbar-icon" data-fitting-icon="${fitting}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[fitting]}"/></svg>`;
}
function renderReader(content, page, mode) {
    const safePage = safeReaderPage(content, page);
    const controlsVisible = state.reader?.controlsVisible ?? false;
    const fitting = state.reader?.fitting ?? "height";
    const zoom = state.reader?.zoom ?? 100;
    const brightness = state.reader?.brightness ?? 100;
    const bookTheme = state.reader?.bookTheme ?? "light";
    const paginationClass = mode === "paged-vertical" ? "vertical" : "horizontal";
    const isPdfReader = content.pageTypes.includes("pdf");
    const isBookReader = content.pageTypes.includes("epub");
    const direction = state.reader?.direction ?? "ltr";
    const isRtl = direction === "rtl";
    return `
    <section class="reader ${isPdfReader ? "reader-pdf-reader" : ""} ${isBookReader ? "reader-book-reader" : ""} book-theme-${bookTheme} ${isRtl ? "reader-rtl" : ""} ${controlsVisible ? "controls-visible" : ""}" style="--reader-brightness: ${brightness}%; --reader-zoom-percent: ${zoom}%; --reader-zoom-scale: ${zoom / 100}; --reader-max-width: ${Math.round(980 * (zoom / 100))}px">
      ${isPdfReader ? `<nav class="reader-pdf-toolbar" aria-label="Controles do PDF">
        <button class="reader-pdf-back" data-reader-action="close" type="button" aria-label="Voltar para a página inicial" title="Voltar para a página inicial (Esc)" aria-keyshortcuts="Escape">${renderIconeToolbarPdf("M15 6l-6 6l6 6")}<span>Início</span></button>
        <form class="reader-pdf-page-form" data-pdf-page-form><label for="pdf-page-input">Página atual</label><input id="pdf-page-input" data-pdf-page-input type="number" inputmode="numeric" min="1" value="1" disabled aria-label="Ir para a página" /><span data-pdf-page-total aria-live="polite">/ …</span></form>
        <div class="reader-pdf-zoom-control" role="group" aria-label="Zoom do PDF">
          <button class="reader-pdf-zoom-button" data-reader-action="zoom-out" type="button" aria-label="Diminuir zoom" title="Diminuir zoom">${renderIconeToolbarPdf("M5 12h14")}</button>
          <button class="reader-pdf-zoom-value" data-reader-action="zoom-reset" type="button" aria-label="Zoom ${zoom}%. Voltar a 100%" title="Voltar a 100%">${zoom}%</button>
          <button class="reader-pdf-zoom-button" data-reader-action="zoom-in" type="button" aria-label="Aumentar zoom" title="Aumentar zoom">${renderIconeToolbarPdf("M12 5v14M5 12h14")}</button>
        </div>
        <button class="reader-pdf-fullscreen" data-reader-action="fullscreen" type="button" aria-label="${escapeHtml(getReaderFullscreenLabel())}" title="${escapeHtml(getReaderFullscreenLabel())} (F)" aria-keyshortcuts="F" ${isReaderFullscreenAvailable() ? "" : "disabled"}><span class="icon">${renderIconeToolbarPdf("M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3")}</span></button>
      </nav>
      <nav class="reader-pdf-side-toolbar" aria-label="Ferramentas do PDF">
        <button class="reader-pdf-outline-button" data-reader-action="pdf-outline" type="button" aria-label="Abrir sumário" title="Sumário">${renderIconeToolbarPdf("M4 5h16M4 12h16M4 19h16")}</button>
        <button class="reader-pdf-search-button" data-reader-action="pdf-search" type="button" aria-label="Pesquisar no PDF" title="Pesquisar no PDF (/ ou Ctrl+F)" aria-keyshortcuts="/ Control+F Meta+F">${renderIconeToolbarPdf("M21 21l-4.35-4.35m2.35-5.65a8 8 0 1 1-16 0a8 8 0 0 1 16 0")}</button>
        <button class="reader-pdf-bookmark" data-reader-action="bookmark" type="button" aria-label="Marcar página" title="Marcar página (B)" aria-keyshortcuts="B"><span class="icon">${renderIconeMarcadorPdf(isPageBookmarked(content.id, safePage))}</span></button>
        <button class="reader-pdf-marks-button" data-reader-action="pdf-marks" type="button" aria-label="Páginas marcadas" title="Páginas marcadas" aria-controls="pdf-marks-panel" aria-expanded="false">${renderIconeToolbarPdf("M15 10v11l-5-3l-5 3V10a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3zM11 3h5a3 3 0 0 1 3 3v11")}<span class="reader-pdf-marks-count" aria-hidden="true" hidden></span></button>
        ${renderBotaoFotoPersonagem(content)}
        <button class="reader-pdf-print-button" data-reader-action="pdf-print" type="button" aria-label="Imprimir PDF" title="Imprimir PDF">${renderIconeImprimirPdf()}</button>
        <details class="reader-pdf-options">
          <summary aria-label="Ajustar brilho" title="Ajustar brilho">${renderIconeToolbarPdf("M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6L7 7m10 10l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0a4 4 0 0 1 8 0")}</summary>
          <label class="reader-pdf-brightness-panel">Brilho<input data-reader-brightness type="range" min="10" max="100" value="${brightness}" aria-label="Brilho" /></label>
        </details>
      </nav><div class="reader-pdf-feedback" role="status" aria-live="polite" hidden></div>${renderPainelFotoPersonagem(content)}` : ""}
      <div class="reader-pagination ${paginationClass}">
        <button class="zone prev" data-reader-action="page-prev" aria-label="Página anterior"></button>
        <button class="zone next" data-reader-action="page-next" aria-label="Próxima página"></button>
      </div>
      <div class="reader-stage ${mode === "vertical-scroll" ? "vertical-scroll" : ""} ${fitting === "width" ? "fit-width" : fitting === "original" ? "fit-original" : "fit-height"}" id="reader-stage">
        ${renderReaderPages(content, safePage, mode)}
      </div>
      ${isPdfReader ? `<form class="reader-pdf-search" data-pdf-search hidden role="search"><label for="pdf-search-input">Pesquisar no PDF</label><input id="pdf-search-input" data-pdf-search-input type="search" autocomplete="off" placeholder="Pesquisar" /><button data-pdf-search-previous type="button" aria-label="Resultado anterior" title="Resultado anterior">${renderIconeToolbarPdf("M6 15l6-6l6 6")}</button><button data-pdf-search-next type="button" aria-label="Próximo resultado" title="Próximo resultado">${renderIconeToolbarPdf("M6 9l6 6l6-6")}</button><button data-pdf-search-close type="button" aria-label="Fechar pesquisa" title="Fechar pesquisa">${renderIconeToolbarPdf("M18 6L6 18M6 6l12 12")}</button><output data-pdf-search-status aria-live="polite"></output></form>` : ""}
      ${isBookReader ? `<form class="reader-epub-search" data-epub-search hidden role="search"><label for="epub-search-input">Pesquisar no livro</label><input id="epub-search-input" data-epub-search-input type="search" autocomplete="off" placeholder="Pesquisar" /><button data-epub-search-previous type="button" aria-label="Resultado anterior" title="Resultado anterior">${renderIconeToolbarPdf("M6 15l6-6l6 6")}</button><button data-epub-search-next type="button" aria-label="Próximo resultado" title="Próximo resultado">${renderIconeToolbarPdf("M6 9l6 6l6-6")}</button><button data-epub-search-close type="button" aria-label="Fechar pesquisa" title="Fechar pesquisa">${renderIconeToolbarPdf("M18 6L6 18M6 6l12 12")}</button><output data-epub-search-status aria-live="polite"></output></form>` : ""}
      <div class="reader-load-status" data-reader-load-status hidden aria-live="polite" aria-atomic="true">
        <span class="reader-load-spinner" aria-hidden="true"></span>
        <span data-reader-load-message>Carregando página…</span>
        <button class="reader-load-retry" data-reader-action="retry-page" type="button" hidden>Tentar novamente</button>
      </div>
      ${isPdfReader ? "" : `<div class="reader-overlay top" aria-hidden="${controlsVisible ? "false" : "true"}"></div>
      <div class="reader-overlay bottom" aria-hidden="${controlsVisible ? "false" : "true"}"></div>`}
    </section>
  `;
}
function renderReaderPages(content, page, mode) {
    if (content.pageCount === 0) {
        return `<div class="reader-page-message">Nenhuma página encontrada.</div>`;
    }
    if (content.pageTypes.includes("pdf")) {
        return `<div class="reader-media-shell">${renderPageMedia(content, page, false)}</div>`;
    }
    if (content.pageTypes.includes("epub")) {
        return renderPageMedia(content, page, mode === "vertical-scroll", true);
    }
    if (mode === "vertical-scroll") {
        const chapter = getChapterForPage(content, page);
        if (chapter) {
            const start = chapter.startPage;
            const end = start + chapter.pageCount;
            return Array.from({ length: end - start }, (_, index) => {
                const absolutePage = start + index;
                return renderPageMedia(content, absolutePage, true, index === 0 || absolutePage === page);
            }).join("");
        }
        return renderPageMedia(content, page, true, true);
    }
    return `
    <div class="reader-media-shell">
      ${renderPageMedia(content, page, false)}
    </div>
  `;
}
function renderPageMedia(content, page, vertical, eager = true) {
    const isPdf = content.pageTypes.includes("pdf");
    const src = getPageUrl(content, isPdf ? 0 : page);
    const pageType = isPdf ? "pdf" : content.pageTypes[page] ?? "image";
    const className = vertical ? "reader-image vertical-page" : "reader-image";
    if (pageType === "pdf") {
        return `<div class="reader-pdf" data-reader-page-index="${page}" data-pdf-url="${escapeHtml(src)}" role="document" aria-label="${escapeHtml(content.title)}"><div class="pdf-status" data-pdf-status role="status" aria-live="polite">PDF carregando…</div><div class="pdf-pages" data-pdf-pages></div></div>`;
    }
    if (pageType === "epub") {
        return `
      <iframe
        class="reader-epub ${vertical ? "vertical-page" : ""}"
        data-reader-page-index="${page}"
        data-epub-mode="${state.reader?.mode ?? "horizontal"}"
        src="${escapeHtml(src)}"
        title="${escapeHtml(content.title)} capítulo ${page + 1}"
      ></iframe>
    `;
    }
    return `<img class="${className}" data-reader-page-index="${page}" src="${escapeHtml(src)}" alt="${escapeHtml(content.title)} página ${page + 1}" loading="${vertical && !eager ? "lazy" : "eager"}" fetchpriority="${!vertical || eager ? "high" : "low"}" decoding="async" />`;
}
function bindReaderPdfViewer() {
    const viewer = document.querySelector(".reader-pdf[data-pdf-url]");
    if (!viewer)
        return;
    void iniciarLeitorPdf(viewer.dataset.pdfUrl ?? "", (state.reader?.page ?? 0) + 1, (state.reader?.zoom ?? 100) / 100);
    document.querySelector("[data-pdf-search]")?.addEventListener("submit", (event) => {
        event.preventDefault();
        void pesquisarPdf();
    });
    document.querySelector("[data-pdf-search-next]")?.addEventListener("click", () => proximoResultadoPdf(1));
    document.querySelector("[data-pdf-search-previous]")?.addEventListener("click", () => proximoResultadoPdf(-1));
    document.querySelector("[data-pdf-search-close]")?.addEventListener("click", fecharPesquisaPdf);
    document.querySelector("[data-pdf-search-input]")?.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            event.preventDefault();
            fecharPesquisaPdf();
        }
    });
    document.querySelector("[data-pdf-page-input]")?.addEventListener("change", (event) => {
        const campo = event.currentTarget;
        campo.value = String(navegarParaPaginaPdf(Number(campo.value)));
    });
    document.querySelector("[data-pdf-page-form]")?.addEventListener("submit", (event) => {
        event.preventDefault();
        const campo = event.currentTarget.querySelector("[data-pdf-page-input]");
        if (!campo)
            return;
        campo.value = String(navegarParaPaginaPdf(Number(campo.value)));
        campo.blur();
    });
}
let epubResultados = [];
let epubIndiceResultado = -1;
function pesquisaEpubAberta() {
    const pesquisa = document.querySelector("[data-epub-search]");
    return Boolean(pesquisa && !pesquisa.hidden);
}
function abrirPesquisaEpub() {
    const pesquisa = document.querySelector("[data-epub-search]");
    const campo = document.querySelector("[data-epub-search-input]");
    if (!pesquisa || !campo)
        return;
    pesquisa.hidden = false;
    const botao = document.querySelector('[data-reader-action="epub-search"]');
    if (botao)
        botao.setAttribute("aria-expanded", "true");
    campo.focus();
    campo.select();
}
function fecharPesquisaEpub() {
    const pesquisa = document.querySelector("[data-epub-search]");
    if (pesquisa)
        pesquisa.hidden = true;
    const botao = document.querySelector('[data-reader-action="epub-search"]');
    if (botao)
        botao.setAttribute("aria-expanded", "false");
}
function atualizarBotoesPesquisaEpub() {
    document.querySelectorAll("[data-epub-search-next], [data-epub-search-previous]").forEach((botao) => {
        botao.disabled = epubResultados.length === 0;
    });
}
async function pesquisarEpub() {
    if (!state.reader)
        return;
    const content = state.reader.content;
    const campo = document.querySelector("[data-epub-search-input]");
    const status = document.querySelector("[data-epub-search-status]");
    const termo = (campo?.value ?? "").trim();
    epubResultados = [];
    epubIndiceResultado = -1;
    atualizarBotoesPesquisaEpub();
    if (!termo || !content.pageTypes.includes("epub")) {
        if (status)
            status.textContent = "Digite um termo.";
        return;
    }
    if (status)
        status.textContent = "Buscando no livro…";
    try {
        const url = `/api/contents/${encodeURIComponent(content.id)}/epub-search?q=${encodeURIComponent(termo)}`;
        const data = await api(url);
        epubResultados = data.results.sort((a, b) => a.chapterIndex - b.chapterIndex);
        atualizarBotoesPesquisaEpub();
        if (epubResultados.length === 0) {
            if (status)
                status.textContent = "Nenhum resultado.";
            return;
        }
        const total = epubResultados.reduce((soma, r) => soma + r.count, 0);
        if (status)
            status.textContent = `${total} ocorrência${total === 1 ? "" : "s"} · ${epubResultados.length} ${epubResultados.length === 1 ? "capítulo" : "capítulos"}`;
        await irParaResultadoEpub(0);
    }
    catch (erro) {
        if (status)
            status.textContent = "Não foi possível buscar no livro.";
        console.error(erro);
    }
}
async function irParaResultadoEpub(indice) {
    if (epubResultados.length === 0)
        return;
    epubIndiceResultado = (indice + epubResultados.length) % epubResultados.length;
    const resultado = epubResultados[epubIndiceResultado];
    const status = document.querySelector("[data-epub-search-status]");
    const termo = (document.querySelector("[data-epub-search-input]")?.value ?? "").trim();
    await setReaderPage(resultado.chapterIndex, true);
    const frame = document.querySelector(`.reader-epub[data-reader-page-index="${resultado.chapterIndex}"]`);
    if (frame)
        realcarTermoEpub(frame, termo);
    if (status)
        status.textContent = `${epubIndiceResultado + 1}/${epubResultados.length} · Capítulo ${resultado.chapterIndex + 1} · ${resultado.count} ${resultado.count === 1 ? "ocorrência" : "ocorrências"}`;
}
function proximoResultadoEpub(direcao) {
    void irParaResultadoEpub(epubIndiceResultado + direcao);
}
function realcarTermoEpub(frame, termoBruto) {
    const termo = termoBruto.trim();
    if (!termo)
        return;
    const doc = frame.contentDocument;
    if (doc?.body && doc.readyState === "complete") {
        realcarTermoEpubNoDocumento(doc, termo);
        return;
    }
    frame.addEventListener("load", () => realcarTermoEpubNoDocumento(frame.contentDocument, termo), { once: true });
}
function realcarTermoEpubNoDocumento(doc, termo) {
    if (!doc?.body)
        return;
    doc.querySelectorAll("mark[data-epub-highlight]").forEach((marcador) => {
        const pai = marcador.parentNode;
        if (pai)
            pai.replaceChild(doc.createTextNode(marcador.textContent ?? ""), marcador);
        pai?.normalize();
    });
    const termoNormal = normalizarTermoEpub(termo);
    if (!termoNormal)
        return;
    const caminhador = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const nos = [];
    let atual = caminhador.nextNode();
    while (atual) {
        const node = atual;
        if (node.nodeValue && node.nodeValue.trim())
            nos.push(node);
        atual = caminhador.nextNode();
    }
    for (const node of nos) {
        const valor = node.nodeValue;
        if (!valor)
            continue;
        const normal = normalizarTermoEpub(valor);
        if (!normal.includes(termoNormal))
            continue;
        // Reconstrói o nó envolvendo as ocorrências do termo em <mark>.
        const fragment = doc.createDocumentFragment();
        let cursor = 0;
        let indice = normal.indexOf(termoNormal);
        const lengthNormal = termoNormal.length;
        while (indice >= 0) {
            if (indice > cursor) {
                fragment.append(doc.createTextNode(valor.slice(cursor, indice)));
            }
            const mark = doc.createElement("mark");
            mark.dataset.epubHighlight = "true";
            mark.textContent = valor.slice(indice, indice + lengthNormal);
            fragment.append(mark);
            cursor = indice + lengthNormal;
            indice = normal.indexOf(termoNormal, cursor);
        }
        if (cursor < valor.length) {
            fragment.append(doc.createTextNode(valor.slice(cursor)));
        }
        if (fragment.childNodes.length > 0) {
            node.parentNode?.replaceChild(fragment, node);
        }
    }
    const primeiro = doc.querySelector("mark[data-epub-highlight]");
    primeiro?.scrollIntoView({ block: "center", behavior: "smooth" });
}
function normalizarTermoEpub(valor) {
    return valor.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
}
function getEpubCurrentOffset(frame) {
    if (!state.reader || !frame.contentDocument)
        return state.reader?.epubOffset ?? 0;
    if (frame.dataset.epubMode === "vertical-scroll") {
        const stage = document.getElementById("reader-stage");
        return stage ? epubViewportOffset(stage.scrollTop, stage.scrollHeight, stage.clientHeight) : 0;
    }
    const doc = frame.contentDocument;
    const scrolling = doc.scrollingElement ?? doc.documentElement;
    return epubViewportOffset(Math.abs(scrolling.scrollLeft), scrolling.scrollWidth, scrolling.clientWidth);
}
function updateEpubPosition(frame) {
    const reader = state.reader;
    if (!reader || !reader.content.pageTypes.includes("epub") || Number(frame.dataset.readerPageIndex) !== reader.page)
        return;
    reader.epubOffset = getEpubCurrentOffset(frame);
    const percent = epubBookPercent(reader.epubLengths.length === reader.content.pageCount ? reader.epubLengths : Array(reader.content.pageCount).fill(1), reader.page, reader.epubOffset);
    const label = document.querySelector("[data-epub-progress]");
    const bar = document.querySelector(".epub-progress-track");
    if (label)
        label.textContent = String(percent);
    if (bar) {
        bar.setAttribute("aria-valuenow", String(percent));
        const fill = bar.querySelector("span");
        if (fill)
            fill.style.width = `${percent}%`;
    }
    scheduleReaderProgressSave(reader.content, reader.page, reader.epubOffset);
}
function scheduleEpubPosition(frame) {
    if (epubProgressRaf !== null)
        return;
    epubProgressRaf = requestAnimationFrame(() => {
        epubProgressRaf = null;
        updateEpubPosition(frame);
    });
}
function applyEpubAppearance(frame, restore = false) {
    const reader = state.reader;
    const doc = frame.contentDocument;
    const stage = document.getElementById("reader-stage");
    if (!reader || !doc?.body || !stage)
        return;
    doc.documentElement.style.touchAction = "pan-x pan-y";
    const main = doc.querySelector(".pugotiread-epub-document");
    if (!main)
        return;
    const margin = reader.epubMargin;
    doc.body.style.setProperty("font-family", reader.epubFont === "sans" ? "Arial, Helvetica, sans-serif" : "Georgia, 'Times New Roman', serif", "important");
    doc.body.style.setProperty("font-size", `${reader.epubFontSize * reader.zoom / 100}px`, "important");
    doc.body.style.setProperty("line-height", String(reader.epubLineHeight), "important");
    doc.querySelectorAll("p, li").forEach(element => element.style.setProperty("line-height", String(reader.epubLineHeight), "important"));
    doc.body.style.setProperty("padding", `${margin}px`, "important");
    doc.body.style.setProperty("overflow", "visible", "important");
    if (reader.mode === "vertical-scroll") {
        doc.documentElement.style.overflow = "visible";
        doc.body.style.width = "auto";
        doc.body.style.height = "auto";
        main.style.height = "auto";
        main.style.width = "min(760px, 100%)";
        main.style.margin = "0 auto";
        main.style.columnWidth = "auto";
        main.style.columnGap = "normal";
        frame.style.height = `${Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight, stage.clientHeight)}px`;
        if (restore)
            stage.scrollTop = Math.round((stage.scrollHeight - stage.clientHeight) * reader.epubOffset);
    }
    else {
        const width = Math.max(frame.clientWidth, stage.clientWidth);
        const height = Math.max(stage.clientHeight, 200);
        const columnWidth = Math.min(Math.max(width - 2 * margin, 160), 760);
        const leftMargin = Math.max(0, (width - columnWidth) / 2 - margin);
        frame.style.height = `${height}px`;
        doc.documentElement.style.overflowX = "auto";
        doc.documentElement.style.overflowY = "hidden";
        doc.body.style.width = `${width}px`;
        doc.body.style.height = `${height}px`;
        main.style.width = `${columnWidth}px`;
        main.style.height = `${Math.max(height - 2 * margin, 100)}px`;
        main.style.maxWidth = "none";
        main.style.columnWidth = `${columnWidth}px`;
        main.style.columnGap = `${width - columnWidth}px`;
        main.style.columnFill = "auto";
        main.style.margin = `0 0 0 ${leftMargin}px`;
        if (restore) {
            requestAnimationFrame(() => {
                const scrolling = doc.scrollingElement ?? doc.documentElement;
                scrolling.scrollLeft = Math.round((scrolling.scrollWidth - scrolling.clientWidth) * reader.epubOffset) * (reader.direction === "rtl" ? -1 : 1);
            });
        }
    }
}
function advanceEpubPage(step) {
    const reader = state.reader;
    const frame = document.querySelector(".reader-epub");
    const stage = document.getElementById("reader-stage");
    if (!reader || !frame || !stage)
        return;
    if (reader.mode === "vertical-scroll") {
        const next = Math.max(0, Math.min(stage.scrollTop + step * (stage.clientHeight - 40), stage.scrollHeight - stage.clientHeight));
        if (Math.abs(next - stage.scrollTop) > 2)
            stage.scrollTo({ top: next, behavior: "smooth" });
        else
            void setReaderPage(reader.page + step, false, step < 0 ? 1 : 0);
    }
    else {
        const doc = frame.contentDocument;
        if (!doc)
            return;
        const scrolling = doc.scrollingElement ?? doc.documentElement;
        const sign = reader.direction === "rtl" ? -1 : 1;
        const next = Math.max(0, Math.min(Math.abs(scrolling.scrollLeft) + step * frame.clientWidth, scrolling.scrollWidth - scrolling.clientWidth));
        if (Math.abs(next - Math.abs(scrolling.scrollLeft)) > 2)
            scrolling.scrollTo({ left: sign * next, behavior: "smooth" });
        else
            void setReaderPage(reader.page + step, false, step < 0 ? 1 : 0);
    }
}
function bindReaderEpubFrames() {
    document.querySelectorAll(".reader-epub").forEach((frame) => {
        const resize = () => {
            const doc = frame.contentDocument;
            if (!doc?.documentElement || !doc.body) {
                return;
            }
            if (state.reader?.mode === "vertical-scroll") {
                const height = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight, window.innerHeight);
                if (Math.abs(frame.offsetHeight - height) > 2)
                    frame.style.height = `${height}px`;
            }
        };
        frame.addEventListener("load", () => {
            applyEpubAppearance(frame, true);
            resize();
            const doc = frame.contentDocument;
            if (!doc?.body || typeof ResizeObserver === "undefined") {
                return;
            }
            // Toggle de controles protegido contra seleção de texto e arrasto: não
            // alterna quando a ação era início de seleção/arrasto (getSelection) —
            // evita o flicker ao selecionar texto. Mantém tap-outside razoável.
            let inicioSelecaoX = 0;
            let inicioSelecaoY = 0;
            let arrastou = false;
            doc.addEventListener("pointerdown", (event) => {
                inicioSelecaoX = event.clientX;
                inicioSelecaoY = event.clientY;
                arrastou = false;
            });
            doc.addEventListener("pointermove", (event) => {
                if (Math.hypot(event.clientX - inicioSelecaoX, event.clientY - inicioSelecaoY) > 6) {
                    arrastou = true;
                }
            });
            doc.addEventListener("pointerup", (event) => {
                if (Math.hypot(event.clientX - inicioSelecaoX, event.clientY - inicioSelecaoY) > 6) {
                    arrastou = true;
                }
            });
            doc.addEventListener("click", (event) => {
                if (!state.reader) {
                    return;
                }
                const selecao = doc.getSelection();
                const haTextoSelecionado = selecao ? selecao.toString().trim().length > 0 : false;
                if (arrastou || haTextoSelecionado) {
                    return;
                }
                if (event.target?.closest("a, button, input, textarea, select"))
                    return;
                const x = event.clientX / Math.max(frame.clientWidth, 1);
                if (state.reader.mode !== "vertical-scroll" && x < 0.22)
                    advanceEpubPage(state.reader.direction === "rtl" ? 1 : -1);
                else if (state.reader.mode !== "vertical-scroll" && x > 0.78)
                    advanceEpubPage(state.reader.direction === "rtl" ? -1 : 1);
                else {
                    state.reader.controlsVisible = !state.reader.controlsVisible;
                    renderReaderOverlay();
                }
            });
            let touchX = 0;
            let touchY = 0;
            let pinchStartDistance = 0;
            let pinchLastDistance = 0;
            let pinchStartZoom = 100;
            doc.addEventListener("touchstart", event => {
                if (event.touches.length === 2) {
                    pinchStartDistance = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY);
                    pinchLastDistance = pinchStartDistance;
                    pinchStartZoom = state.reader?.zoom ?? 100;
                    arrastou = true;
                    return;
                }
                if (event.touches.length === 1) {
                    touchX = event.touches[0].clientX;
                    touchY = event.touches[0].clientY;
                }
            }, { passive: true });
            doc.addEventListener("touchmove", event => {
                if (event.touches.length !== 2 || pinchStartDistance <= 0)
                    return;
                pinchLastDistance = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY);
                arrastou = true;
                event.preventDefault();
            }, { passive: false });
            doc.addEventListener("touchend", event => {
                if (pinchStartDistance > 0) {
                    if (event.touches.length < 2) {
                        setReaderZoom(pinchStartZoom * pinchLastDistance / pinchStartDistance);
                        pinchStartDistance = 0;
                    }
                    return;
                }
                if (state.reader?.mode === "vertical-scroll" || event.changedTouches.length !== 1)
                    return;
                const dx = event.changedTouches[0].clientX - touchX;
                const dy = event.changedTouches[0].clientY - touchY;
                if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.3) {
                    arrastou = true;
                    advanceEpubPage(dx < 0 ? 1 : -1);
                }
            }, { passive: true });
            doc.addEventListener("scroll", () => scheduleEpubPosition(frame), { passive: true });
            // Encaminha atalhos disparados dentro do iframe do EPUB para o leitor.
            // O iframe captura os eventos de teclado e impede que cheguem ao listener
            // global da janela pai; por isso todas as setas precisam ser resolvidas
            // aqui. As setas verticais levam a página atual ao topo/final e não
            // podem cair na rolagem nativa do iframe nem na navegação entre páginas.
            doc.addEventListener("keydown", (event) => {
                const alvoProtegido = alvoEditavelPdf(event.target);
                const chave = event.key.toLowerCase();
                const controle = event.ctrlKey || event.metaKey;
                if (controle && !event.altKey && chave === "f") {
                    event.preventDefault();
                    window.dispatchEvent(new CustomEvent("pugotiread:epub-search-open"));
                    return;
                }
                if (!controle && !event.altKey && !event.shiftKey && event.key === "/") {
                    event.preventDefault();
                    window.dispatchEvent(new CustomEvent("pugotiread:epub-search-open"));
                    return;
                }
                const ehEpub = state.reader?.content.pageTypes.includes("epub") === true;
                const acao = resolverTeclaEpubIframe({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, alvoProtegido }, ehEpub ? (state.reader?.direction ?? "ltr") : "ltr");
                if (acao) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    executarAtalhoLeitor(acao);
                }
            }, { capture: true });
            const observer = new ResizeObserver(resize);
            observer.observe(doc.body);
            const stage = document.getElementById("reader-stage");
            if (!stage)
                return;
            let stageWidth = stage.clientWidth;
            let stageHeight = stage.clientHeight;
            const stageObserver = new ResizeObserver(() => {
                if (!frame.isConnected) {
                    stageObserver.disconnect();
                    return;
                }
                if (stage.clientWidth === stageWidth && stage.clientHeight === stageHeight)
                    return;
                stageWidth = stage.clientWidth;
                stageHeight = stage.clientHeight;
                if (state.reader)
                    state.reader.epubOffset = getEpubCurrentOffset(frame);
                applyEpubAppearance(frame, true);
                resize();
            });
            stageObserver.observe(stage);
            doc.fonts.ready.then(() => { applyEpubAppearance(frame, true); resize(); }).catch(() => undefined);
        }, { once: true });
    });
}
function bindReaderEpubSearch() {
    document.querySelector("[data-epub-search]")?.addEventListener("submit", (event) => {
        event.preventDefault();
        void pesquisarEpub();
    });
    document.querySelector("[data-epub-search-next]")?.addEventListener("click", () => proximoResultadoEpub(1));
    document.querySelector("[data-epub-search-previous]")?.addEventListener("click", () => proximoResultadoEpub(-1));
    document.querySelector("[data-epub-search-close]")?.addEventListener("click", fecharPesquisaEpub);
    document.querySelector("[data-epub-search-input]")?.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            event.preventDefault();
            fecharPesquisaEpub();
        }
    });
}
let markedPageContents = [];
let markedPageBookmarks = [];
let markedPagesLoading = false;
let markedPagesError = "";
let markedPagesRequest = 0;
async function loadMarkedPages() {
    const request = ++markedPagesRequest;
    markedPagesLoading = true;
    markedPagesError = "";
    markedPageBookmarks = [];
    // Wait for the authorized list; bootstrap IDs can be stale after filesystem moves.
    const idsInBookmarks = new Set(state.bookmarks.map((bookmark) => bookmark.contentId));
    markedPageContents = getAvailableContents().filter((content) => idsInBookmarks.has(content.id));
    renderShell();
    try {
        const payload = await Promise.race([
            api("/api/bookmarks?includeContents=1"),
            new Promise((_, reject) => window.setTimeout(() => reject(new Error("A atualização demorou mais que o esperado.")), 12000))
        ]);
        if (request !== markedPagesRequest || state.activeView !== "bookmarks" || state.reader)
            return;
        // Preserve other (e.g. locked vault) marks in state; the view uses only accessible works.
        for (const bookmark of payload.bookmarks) {
            state.bookmarks = state.bookmarks.filter((item) => item.contentId !== bookmark.contentId || item.page !== bookmark.page);
            state.bookmarks.push(bookmark);
        }
        markedPageContents = payload.contents;
        markedPageBookmarks = payload.bookmarks;
    }
    catch (error) {
        if (request === markedPagesRequest)
            markedPagesError = error instanceof Error ? error.message : "Não foi possível carregar as páginas marcadas.";
    }
    finally {
        if (request === markedPagesRequest) {
            markedPagesLoading = false;
            if (state.activeView === "bookmarks" && !state.reader)
                renderShell();
        }
    }
}
function renderMarkedPagesView() {
    const visible = new Set(markedPageBookmarks.map(item => `${item.contentId}:${item.page}`));
    const bookmarks = state.bookmarks.filter(item => visible.has(`${item.contentId}:${item.page}`));
    return `<section class="marked-pages-view"><div class="section-heading"><h1>Páginas marcadas</h1><span>${bookmarks.length} marcações</span></div>
    <p class="muted">Acesse uma página salva ou dê um nome para encontrá-la mais facilmente.</p>
    ${markedPagesLoading ? '<p role="status">Carregando páginas marcadas…</p>' : markedPagesError ? `<p role="alert">${escapeHtml(markedPagesError)}</p><button class="button secondary" data-retry-marked-pages type="button">Tentar novamente</button>` : renderMarkedPageRows(bookmarks, markedPageContents)}
  </section>`;
}
function renderMarkedPageRows(bookmarks, contents) {
    if (!bookmarks.length)
        return '<p class="empty compact">Nenhuma página marcada. Use o marcador durante a leitura para salvar uma página.</p>';
    const sorted = [...bookmarks].sort((a, b) => a.contentId.localeCompare(b.contentId) || a.page - b.page);
    return `<div class="marked-page-list">${sorted.map((bookmark) => {
        const content = contents.find((item) => item.id === bookmark.contentId);
        const title = bookmark.name || `Página ${bookmark.page + 1}`;
        return `<article class="marked-page-row" data-marked-content="${escapeHtml(bookmark.contentId)}" data-marked-page="${bookmark.page}">
      <div class="marked-page-copy"><strong class="marked-page-name">${escapeHtml(title)}</strong><span>${escapeHtml(content?.title ?? "Obra indisponível")} · Página ${bookmark.page + 1}</span></div>
      <div class="marked-page-actions"><button class="button primary" data-open-marked-page type="button" ${content ? "" : "disabled"} aria-label="Ir para página ${bookmark.page + 1}: ${escapeHtml(title)}" title="Ir para página">${renderIcon("keyframes")}</button>
      <details class="marked-page-edit"><summary aria-label="Renomear página" title="Renomear página">${renderIcon("writingSign")}</summary><form data-rename-marked-page>
        <label>Nome da página<input name="name" type="text" maxlength="120" value="${escapeHtml(bookmark.name ?? "")}" placeholder="Página ${bookmark.page + 1}" autocomplete="off" /></label>
        <small>Deixe vazio para usar o número da página.</small>
        <div class="marked-page-edit-actions"><button class="button primary" type="submit">Salvar</button><button class="button secondary" data-cancel-marked-name type="button">Cancelar</button></div>
        <output role="status" aria-live="polite"></output>
      </form></details><button class="button secondary" data-remove-marked-page type="button" aria-label="Desmarcar página ${bookmark.page + 1}: ${escapeHtml(title)}" title="Desmarcar página">${renderIcon("bookmarkOff")}</button></div>
    </article>`;
    }).join("")}</div>`;
}
function bindMarkedPageActions() {
    document.querySelector("[data-retry-marked-pages]")?.addEventListener("click", () => void loadMarkedPages());
    document.querySelectorAll("[data-open-marked-page]").forEach((button) => {
        button.addEventListener("click", () => {
            const row = button.closest("[data-marked-content]");
            const content = markedPageContents.find((item) => item.id === row.dataset.markedContent) ?? findContentById(row.dataset.markedContent ?? "");
            if (!content)
                return;
            closeNavigationPanels();
            closeMobileNavigation();
            openReaderAtPageAndRender(content, Number(row.dataset.markedPage));
        });
    });
    document.querySelectorAll("[data-remove-marked-page]").forEach((button) => {
        button.addEventListener("click", async () => {
            const row = button.closest("[data-marked-content]");
            if (!row)
                return;
            await api("/api/bookmarks", { method: "POST", body: JSON.stringify({ contentId: row.dataset.markedContent, page: Number(row.dataset.markedPage) }) });
            state.bookmarks = state.bookmarks.filter((item) => !(item.contentId === row.dataset.markedContent && item.page === Number(row.dataset.markedPage)));
            renderShell();
        });
    });
    document.querySelectorAll("[data-rename-marked-page]").forEach((form) => {
        const row = form.closest("[data-marked-content]");
        const details = form.closest("details");
        const input = form.querySelector("input");
        const status = form.querySelector("output");
        form.querySelector("[data-cancel-marked-name]")?.addEventListener("click", () => { form.reset(); status.textContent = ""; details.open = false; });
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            if (form.getAttribute("aria-busy") === "true")
                return;
            form.setAttribute("aria-busy", "true");
            const buttons = form.querySelectorAll("button");
            buttons.forEach((button) => { button.disabled = true; });
            status.textContent = "Salvando…";
            try {
                const { bookmark } = await api("/api/bookmarks", { method: "PATCH", body: JSON.stringify({ contentId: row.dataset.markedContent, page: Number(row.dataset.markedPage), name: input.value.trim() }) });
                state.bookmarks = state.bookmarks.map((item) => item.contentId === bookmark.contentId && item.page === bookmark.page ? bookmark : item);
                const title = bookmark.name || `Página ${bookmark.page + 1}`;
                row.querySelector(".marked-page-name").textContent = title;
                row.querySelector("[data-open-marked-page]")?.setAttribute("aria-label", `Ir para página ${bookmark.page + 1}: ${title}`);
                input.value = input.defaultValue = bookmark.name ?? "";
                status.textContent = "Nome salvo.";
                details.open = false;
            }
            catch (error) {
                status.textContent = error instanceof Error ? error.message : "Não foi possível salvar o nome.";
            }
            finally {
                form.setAttribute("aria-busy", "false");
                buttons.forEach((button) => { button.disabled = false; });
            }
        });
    });
}
function renderReaderBookmarks(bookmarks) {
    if (bookmarks.length === 0) {
        return `<p class="empty compact">Nenhuma página marcada nesta obra.</p>`;
    }
    return `
    <section class="reader-bookmarks">
      <div class="series-section-heading">
        <h2>Marcadores desta obra</h2>
        <span>${bookmarks.length} páginas</span>
      </div>
      <div class="reader-bookmark-list">
        ${bookmarks.map((bookmark) => `
          <button class="reader-bookmark-chip" data-reader-action="goto-bookmark" data-reader-bookmark-page="${bookmark.page}" type="button">
            Página ${bookmark.page + 1}
          </button>
        `).join("")}
      </div>
    </section>
  `;
}
function getPageUrl(content, page) {
    if (content.pageTypes[page] === 'pdf')
        return `/api/contents/${encodeURIComponent(content.id)}/pages/${page}?v=${encodeURIComponent(content.chapters[0]?.addedAt ?? 'pdf-save-simple-20260914')}`;
    if (state.reader?.content.id === content.id && content.pageTypes[page] === "epub") {
        const params = new URLSearchParams();
        params.set("theme", state.reader.bookTheme);
        params.set("direction", state.reader.direction);
        return `/api/contents/${encodeURIComponent(content.id)}/pages/${page}?${params.toString()}`;
    }
    const base = `/api/contents/${encodeURIComponent(content.id)}/pages/${page}`;
    if (state.reader && state.reader.content.id === content.id && (content.pageTypes[page] ?? "image") === "image" && state.reader.zoom <= 100 && state.reader.fitting !== "original") {
        const target = Math.ceil(window.innerWidth * Math.min(window.devicePixelRatio || 1, 2));
        const width = [640, 960, 1280, 1600, 2048].find(value => value >= target);
        if (width)
            return `${base}?width=${width}`;
    }
    return base;
}
function touchReaderImageCache(key, entry) {
    readerImageCache.delete(key);
    readerImageCache.set(key, entry);
    const decodedBytes = () => [...readerImageCache.values()].reduce((sum, cached) => sum + cached.image.naturalWidth * cached.image.naturalHeight * 4, 0);
    while (readerImageCache.size > readerLimits.imageEntries || decodedBytes() > readerLimits.imageBytes) {
        const oldestKey = readerImageCache.keys().next().value;
        if (!oldestKey)
            break;
        readerImageCache.delete(oldestKey);
    }
}
function preloadReaderImage(content, page) {
    if (page < 0 || page >= content.pageCount || (content.pageTypes[page] ?? "image") !== "image") {
        return Promise.resolve();
    }
    const src = getPageUrl(content, page);
    const key = `${content.id}:${page}:${src}`;
    const cached = readerImageCache.get(key);
    if (cached) {
        touchReaderImageCache(key, cached);
        return cached.ready;
    }
    const image = new Image();
    image.decoding = "async";
    image.fetchPriority = pendingReaderPage === page ? "high" : "low";
    const ready = new Promise((resolve, reject) => {
        image.addEventListener("load", () => {
            void image.decode().catch(() => undefined).then(() => {
                if (readerImageCache.has(key))
                    touchReaderImageCache(key, { image, ready });
                resolve();
            });
        }, { once: true });
        image.addEventListener("error", () => reject(new Error("Não foi possível carregar a página.")), { once: true });
        image.src = src;
    }).catch((error) => {
        readerImageCache.delete(key);
        throw error;
    });
    const entry = { image, ready };
    touchReaderImageCache(key, entry);
    return ready;
}
function preloadAdjacentReaderPages(content, page) {
    const generation = ++readerPrefetchGeneration;
    epubPrefetch?.abort();
    epubPrefetch = null;
    if (!state.reader || state.reader.mode === "vertical-scroll")
        return;
    if (content.pageTypes[page] === "epub") {
        const offset = imagePrefetchOffsets(deviceHints(), readerPrefetchDirection)[0];
        const next = page + (offset ?? 0);
        if (offset && next >= 0 && next < content.pageCount) {
            const controller = new AbortController();
            epubPrefetch = controller;
            void fetch(getPageUrl(content, next), { signal: controller.signal, cache: "force-cache" })
                .then(async (response) => {
                if (!response.ok || Number(response.headers.get("content-length")) > 2 * 1024 * 1024) {
                    await response.body?.cancel();
                    return;
                }
                await response.arrayBuffer();
            }).catch(() => undefined);
        }
        return;
    }
    // A single speculative download at a time; stop when navigation changes.
    void (async () => {
        for (const offset of imagePrefetchOffsets(deviceHints(), readerPrefetchDirection)) {
            if (generation !== readerPrefetchGeneration || state.reader?.content.id !== content.id)
                return;
            await preloadReaderImage(content, page + offset).catch(() => undefined);
        }
    })();
}
function clearReaderLoadingTimer() {
    if (readerLoadingTimer !== null) {
        window.clearTimeout(readerLoadingTimer);
        readerLoadingTimer = null;
    }
}
function setReaderLoadStatus(status, message = "Carregando página…") {
    const element = document.querySelector("[data-reader-load-status]");
    if (!element)
        return;
    const retry = element.querySelector(".reader-load-retry");
    const messageElement = element.querySelector("[data-reader-load-message]");
    element.hidden = status === "hidden";
    element.classList.toggle("is-error", status === "error");
    if (messageElement)
        messageElement.textContent = message;
    if (retry)
        retry.hidden = status !== "error";
}
function showReaderLoadingAfterDelay(navigationId = readerNavigationId) {
    clearReaderLoadingTimer();
    readerLoadingTimer = window.setTimeout(() => {
        readerLoadingTimer = null;
        if (navigationId === readerNavigationId)
            setReaderLoadStatus("loading");
    }, 180);
}
function bindReaderMediaLoadState() {
    if (!state.reader || state.reader.mode === "vertical-scroll")
        return;
    if (state.reader.content.pageTypes[state.reader.page] === "pdf")
        return;
    const media = document.querySelector("#reader-stage [data-reader-page-index]");
    if (!media)
        return;
    if (media instanceof HTMLImageElement && media.complete) {
        if (media.naturalWidth > 0) {
            void media.decode().catch(() => undefined).then(() => setReaderLoadStatus("hidden"));
        }
        else {
            pendingReaderPage = state.reader.page;
            setReaderLoadStatus("error", "A página não pôde ser carregada.");
        }
        return;
    }
    showReaderLoadingAfterDelay();
    media.addEventListener("load", () => {
        clearReaderLoadingTimer();
        setReaderLoadStatus("hidden");
    }, { once: true });
    media.addEventListener("error", () => {
        clearReaderLoadingTimer();
        pendingReaderPage = state.reader?.page ?? null;
        setReaderLoadStatus("error", "A página não pôde ser carregada.");
    }, { once: true });
}
function updatePagedReaderPage(content, page) {
    const stage = document.querySelector("#reader-stage");
    if (!stage || !document.querySelector(".reader"))
        return false;
    stage.innerHTML = renderReaderPages(content, page, state.reader?.mode ?? "horizontal");
    renderReaderOverlay();
    bindReaderEpubFrames();
    bindReaderMediaLoadState();
    preloadAdjacentReaderPages(content, page);
    return true;
}
async function openUserHome(button) {
    button.disabled = true;
    try {
        const startup = await api("/api/me/startup").catch(() => ({ libraryId: null }));
        state.search = "";
        closeNavigationPanels();
        closeMobileNavigation();
        await router.navigate(startup.libraryId
            ? { kind: "library", libraryId: startup.libraryId }
            : { kind: "view", view: "home" });
    }
    finally {
        button.disabled = false;
    }
}
function bindShellEvents(root = document) {
    const selectedSystem = root.querySelector('.library-system-tabs .active');
    if (selectedSystem?.parentElement) {
        const tabs = selectedSystem.parentElement;
        tabs.scrollLeft = selectedSystem.offsetLeft - tabs.offsetLeft - Math.max(0, (tabs.clientWidth - selectedSystem.offsetWidth) / 2);
    }
    root.querySelectorAll('[data-library-folder]').forEach(link => {
        link.onclick = event => {
            if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
                return;
            event.preventDefault();
            if (state.activeLibraryId)
                void router.navigate({ kind: 'library', libraryId: state.activeLibraryId, folder: link.dataset.libraryFolder || undefined });
        };
    });
    const rpgPanel = root.querySelector('[data-rpg-panel]');
    const rpgContent = state.activeSeriesId ? findContentById(state.activeSeriesId) : null;
    if (rpgPanel && rpgContent)
        void bindRpgPanel(rpgPanel, rpgContent, state.user?.role === 'admin', async (id, reader) => {
            if (reader)
                await router.navigate({ kind: 'reader', libraryId: rpgContent.libraryId, contentId: id, page: 1 });
            else
                await router.navigate({ kind: 'title', libraryId: rpgContent.libraryId, contentId: id });
        });
    if (root === document)
        bindMarkedPageActions();
    root.querySelector("#menu-button")?.addEventListener("click", () => {
        if (isMobileViewport()) {
            state.mobileNavOpen = !state.mobileNavOpen;
            if (state.mobileNavOpen) {
                closeNavigationPanels();
            }
        }
        else {
            state.sidebarCollapsed = !state.sidebarCollapsed;
        }
        renderNavigationMenus();
    });
    root.querySelector("#home-button")?.addEventListener("click", event => {
        void openUserHome(event.currentTarget);
    });
    root.querySelector("#search-button")?.addEventListener("click", () => {
        focusGlobalSearch();
    });
    root.querySelector("#global-search-input")?.addEventListener("input", (event) => {
        globalSearchQuery = event.currentTarget.value;
        const results = document.querySelector("#global-search-results");
        if (results)
            results.innerHTML = renderGlobalSearchResults();
        bindGlobalSearchResultEvents();
    });
    root.querySelectorAll("[data-global-search-close]").forEach((element) => {
        element.addEventListener("click", (event) => {
            if (element.dataset.globalSearchClose === "backdrop" && event.target !== element)
                return;
            closeGlobalSearch();
        });
    });
    bindGlobalSearchResultEvents(root);
    root.querySelector("#settings-button")?.addEventListener("click", () => {
        closeNavigationPanels();
        closeMobileNavigation();
        state.settingsSection = state.user?.role === "admin" ? "server" : "account";
        state.serverSection = "libraries";
        openView("settings");
    });
    root.querySelector("#account-button")?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.statsMenuOpen = false;
        state.accountMenuOpen = !state.accountMenuOpen;
        closeMobileNavigation();
        renderNavigationMenus();
    });
    root.querySelector("#stats-button")?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.accountMenuOpen = false;
        state.statsMenuOpen = !state.statsMenuOpen;
        closeMobileNavigation();
        renderNavigationMenus();
    });
    root.querySelector("#theme-toggle")?.addEventListener("click", () => {
        state.darkMode = !state.darkMode;
        localStorage.setItem("pugotiread-dark-mode", state.darkMode ? "dark" : "light");
        applyTheme();
        renderShell();
    });
    root.querySelector("#profile-button")?.addEventListener("click", () => {
        // Perfil é o mesmo em todos os serviços: o Pugoti Profile.
        window.location.assign(pugotiProfileUrl());
    });
    root.querySelector("#mobile-nav-backdrop")?.addEventListener("click", () => {
        closeMobileNavigation();
        renderNavigationMenus();
    });
    root.querySelector("#startup-user-select")?.addEventListener("change", event => {
        startupSelectedUserId = event.currentTarget.value;
        renderShell();
        document.querySelector("#startup-user-select")?.focus();
    });
    root.querySelectorAll("[data-startup-user]").forEach(select => {
        select.addEventListener("change", async () => {
            const id = select.dataset.startupUser;
            const previous = startupLibraries[id] ?? "";
            const status = select.closest(".startup-settings").querySelector("[data-startup-status]");
            const userSelect = document.querySelector("#startup-user-select");
            select.disabled = true;
            userSelect.disabled = true;
            status.textContent = "Salvando…";
            try {
                const result = await api("/api/admin/settings", { method: "PATCH", body: JSON.stringify({ startupLibraries: { [id]: select.value } }) });
                startupLibraries = result.settings.startupLibraries ?? {};
                status.textContent = "Salvo";
            }
            catch {
                select.value = previous;
                status.textContent = "Não foi possível salvar. Tente novamente.";
            }
            finally {
                select.disabled = false;
                userSelect.disabled = false;
            }
        });
    });
    bindPdfSheetsSettings(root);
    root.querySelector("#add-library-button")?.addEventListener("click", () => {
        void openLibraryModal();
    });
    root.querySelector("#add-personal-library-button")?.addEventListener("click", () => {
        void openPersonalLibraryModal();
    });
    root.querySelectorAll("[data-edit-personal-library]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void openPersonalLibraryEditModal(button.dataset.editPersonalLibrary ?? "");
        });
    });
    root.querySelectorAll("[data-edit-library]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            state.openLibraryMenuId = null;
            void openLibraryEditModal(button.dataset.editLibrary ?? "");
        });
    });
    root.querySelectorAll("[data-delete-personal-library]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void deletePersonalLibrary(button.dataset.deletePersonalLibrary ?? "");
        });
    });
    root.querySelectorAll("[data-delete-library]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void deletePublicLibrary(button.dataset.deleteLibrary ?? "");
        });
    });
    root.querySelector("#vault-unlock-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        void unlockPersonalVault(event.currentTarget);
    });
    root.querySelector("#vault-password-input")?.addEventListener("keydown", (event) => {
        if (event.key !== "Enter")
            return;
        event.preventDefault();
        const form = event.target.form;
        if (form)
            void unlockPersonalVault(form);
    });
    root.querySelector("#lock-vault-button")?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void lockPersonalVault();
    });
    root.querySelector("[data-vault-menu]")?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.vaultMenuOpen = !state.vaultMenuOpen;
        renderNavigationMenus();
    });
    root.querySelector("#lock-vault-sidebar-button")?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void lockPersonalVault();
    });
    root.querySelector("#hide-vault-sidebar-button")?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleVaultMenuVisibility();
    });
    root.querySelector("#add-collection-button")?.addEventListener("click", openCollectionModal);
    root.querySelector("#add-user-button")?.addEventListener("click", () => openAdminUserModal("create"));
    root.querySelector("#invite-user-button")?.addEventListener("click", () => openAdminUserModal("invite"));
    root.querySelector("#close-library-modal")?.addEventListener("click", closeLibraryModal);
    root.querySelector("#cancel-library-modal")?.addEventListener("click", closeLibraryModal);
    root.querySelector("#close-collection-modal")?.addEventListener("click", closeCollectionModal);
    root.querySelector("#cancel-collection-modal")?.addEventListener("click", closeCollectionModal);
    root.querySelector("#close-collection-share-modal")?.addEventListener("click", closeCollectionShareModal);
    root.querySelector("#cancel-collection-share-modal")?.addEventListener("click", closeCollectionShareModal);
    root.querySelector("#close-collection-delete-modal")?.addEventListener("click", closeCollectionDeleteModal);
    root.querySelector("#cancel-collection-delete-modal")?.addEventListener("click", closeCollectionDeleteModal);
    root.querySelector("#confirm-collection-delete")?.addEventListener("click", () => {
        void deleteCollection();
    });
    root.querySelector("#close-user-modal")?.addEventListener("click", closeAdminUserModal);
    root.querySelector("#cancel-user-modal")?.addEventListener("click", closeAdminUserModal);
    root.querySelector("#user-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        void submitAdminUserForm(event.currentTarget);
    });
    root.querySelector("#create-link-invite-button")?.addEventListener("click", (event) => {
        const form = event.currentTarget.closest("form");
        if (form instanceof HTMLFormElement) {
            void createLinkOnlyInvite(form);
        }
    });
    root.querySelector("#close-user-delete-modal")?.addEventListener("click", closeAdminUserDeleteModal);
    root.querySelector("#cancel-user-delete-modal")?.addEventListener("click", closeAdminUserDeleteModal);
    root.querySelector("#confirm-user-delete")?.addEventListener("click", () => {
        void deleteAdminUser();
    });
    root.querySelectorAll("[data-open-person]").forEach((button) => {
        button.addEventListener("click", () => {
            const userId = button.dataset.openPerson;
            if (userId)
                void router.navigate({ kind: "person", userId });
        });
    });
    root.querySelector("#back-to-people")?.addEventListener("click", () => {
        openView("people");
    });
    root.querySelectorAll("[data-person-recommendation-form]").forEach((form) => {
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            void savePersonCollectionRecommendations(form);
        });
    });
    root.querySelectorAll("[data-edit-user]").forEach((button) => {
        button.addEventListener("click", () => {
            openAdminUserModal("edit", button.dataset.editUser ?? null);
        });
    });
    root.querySelectorAll("[data-delete-user]").forEach((button) => {
        button.addEventListener("click", () => {
            openAdminUserDeleteModal(button.dataset.deleteUser ?? "");
        });
    });
    root.querySelectorAll("[data-copy-invite]").forEach((button) => {
        button.addEventListener("click", async () => {
            await navigator.clipboard.writeText(state.adminUserInviteUrl);
        });
    });
    root.querySelector("#collection-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        void createCollection();
    });
    root.querySelector("#collection-share-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        void saveCollectionSharing(event.currentTarget);
    });
    root.querySelectorAll("[data-edit-collection]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            startCollectionEdit(button.dataset.editCollection ?? "");
        });
    });
    root.querySelectorAll("[data-share-collection]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void openCollectionShareModal(button.dataset.shareCollection ?? "");
        });
    });
    root.querySelectorAll("[data-delete-collection]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            openCollectionDeleteModal(button.dataset.deleteCollection ?? "");
        });
    });
    root.querySelectorAll("[data-cancel-collection-edit]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            cancelCollectionEdit();
        });
    });
    root.querySelectorAll("[data-collection-edit-form]").forEach((form) => {
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            void saveCollectionEdit(form);
        });
    });
    root.querySelectorAll("[data-remove-collection-content]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void removeFromCollection(button.dataset.removeCollectionContent ?? "", button.dataset.contentId ?? "");
        });
    });
    root.querySelector("#profile-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        void saveProfile(event.currentTarget);
    });
    root.querySelector("#edit-profile-button")?.addEventListener("click", () => {
        window.location.assign(`https://pugotilab.com/auth/profile?return=${encodeURIComponent(window.location.href)}`);
    });
    root.querySelector("#cancel-profile-edit")?.addEventListener("click", () => {
        state.profileEditing = false;
        state.profileError = "";
        state.profileFavoriteSearch = "";
        renderShell();
    });
    root.querySelector("#profile-favorite-search")?.addEventListener("input", (event) => {
        state.profileFavoriteSearch = event.currentTarget.value;
        updateProfileFavoriteResults();
    });
    root.querySelector("#profile-favorite-results")?.addEventListener("click", (event) => {
        const button = event.target.closest("[data-add-profile-favorite]");
        if (!button) {
            return;
        }
        event.preventDefault();
        addProfileFavorite(button.dataset.addProfileFavorite ?? "");
    });
    root.querySelectorAll("[data-remove-profile-favorite]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            removeProfileFavorite(button.dataset.removeProfileFavorite ?? "");
        });
    });
    root.querySelector("#remove-profile-avatar")?.addEventListener("click", (event) => {
        event.preventDefault();
        void removeProfileAvatar();
    });
    root.querySelector("#request-profile-password-reset")?.addEventListener("click", async () => {
        if (!state.user?.email) {
            state.profilePasswordError = "Esta conta não possui e-mail cadastrado.";
            state.profilePasswordMessage = "";
            renderShell();
            return;
        }
        try {
            state.profilePasswordError = "";
            state.profilePasswordMessage = "";
            await api("/api/me/password/request", { method: "POST" });
            state.profilePasswordMessage = "Enviamos um link para o e-mail cadastrado.";
            renderShell();
        }
        catch (error) {
            state.profilePasswordError = error instanceof Error ? error.message : "Não foi possível enviar o link.";
            state.profilePasswordMessage = "";
            renderShell();
        }
    });
    root.querySelector("#profile-password-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const formData = new FormData(form);
        const currentPassword = String(formData.get("currentPassword") ?? "");
        const newPassword = String(formData.get("newPassword") ?? "");
        const confirmPassword = String(formData.get("confirmPassword") ?? "");
        if (newPassword !== confirmPassword) {
            state.profilePasswordError = "As senhas não conferem.";
            state.profilePasswordMessage = "";
            renderShell();
            return;
        }
        state.profilePasswordError = "";
        state.profilePasswordMessage = "";
        void (async () => {
            try {
                await api("/api/me/password", {
                    method: "PATCH",
                    body: JSON.stringify({
                        currentPassword,
                        newPassword
                    })
                });
                state.profilePasswordMessage = "Senha alterada com sucesso.";
                renderShell();
            }
            catch (error) {
                state.profilePasswordError = error instanceof Error ? error.message : "Não foi possível alterar a senha.";
                renderShell();
            }
        })();
    });
    root.querySelector("#library-next-button")?.addEventListener("click", () => {
        const nextStep = getNextLibraryModalStep(state.libraryModalStep);
        if (!canMoveLibraryStep(nextStep)) {
            renderShell();
            return;
        }
        state.libraryModalStep = nextStep;
        renderShell();
    });
    root.querySelector("#library-back-button")?.addEventListener("click", () => {
        syncLibraryDraftFromInputs();
        state.libraryModalError = "";
        state.libraryModalStep = getPreviousLibraryModalStep(state.libraryModalStep);
        renderShell();
    });
    root.querySelectorAll("[data-library-modal-step]").forEach((button) => {
        button.addEventListener("click", () => {
            const nextStep = button.dataset.libraryModalStep;
            if (!canMoveLibraryStep(nextStep)) {
                renderShell();
                return;
            }
            state.libraryModalStep = nextStep;
            renderShell();
        });
    });
    root.querySelectorAll("[data-folder-path]").forEach((button) => {
        button.addEventListener("click", async () => {
            try {
                await loadFolderBrowser(button.dataset.folderPath);
                renderShell();
            }
            catch (error) {
                state.libraryModalError = error instanceof Error ? error.message : "Não foi possível carregar a pasta.";
                renderShell();
            }
        });
    });
    root.querySelector("#select-current-folder")?.addEventListener("click", () => {
        if (!state.folderBrowser) {
            return;
        }
        state.libraryDraft.path = state.folderBrowser.path;
        renderShell();
    });
    root.querySelector("#create-library-button")?.addEventListener("click", async () => {
        syncLibraryDraftFromInputs();
        if (!canMoveLibraryStep("advanced")) {
            renderShell();
            return;
        }
        try {
            const editingLibraryId = state.editingLibraryId;
            const { library } = await api(editingLibraryId ? `/api/libraries/${encodeURIComponent(editingLibraryId)}` : "/api/libraries", {
                method: editingLibraryId ? "PATCH" : "POST",
                body: JSON.stringify({
                    name: state.libraryDraft.name,
                    kind: state.libraryDraft.kind,
                    path: state.libraryDraft.path,
                    isPersonal: state.libraryDraft.isPersonal
                })
            });
            const wasPersonal = state.libraryDraft.isPersonal;
            state.libraryModalOpen = false;
            resetLibraryDraft();
            if (wasPersonal) {
                state.personalLibraries = editingLibraryId
                    ? state.personalLibraries.map((item) => item.id === library.id ? library : item)
                    : [...state.personalLibraries, library];
                await refreshPersonalVault();
            }
            else {
                await refreshLibraries();
            }
            renderShell();
        }
        catch (error) {
            state.libraryModalError = error instanceof Error ? error.message : "Não foi possível criar a biblioteca.";
            renderShell();
        }
    });
    root.querySelector("#logout-button")?.addEventListener("click", async () => {
        clearPdfFormDrafts();
        await api("/api/logout", { method: "POST" });
        const authConfig = await getPugotilabAuthConfig();
        clearVaultInactivityTimer();
        state.user = null;
        state.vaultHiddenFromMenu = true;
        state.vaultMenuOpen = false;
        state.personalLibraries = [];
        state.vaultUnlocked = false;
        state.vaultToken = "";
        state.vaultError = "";
        lastVaultTouchAt = 0;
        state.accountMenuOpen = false;
        state.profilePasswordError = "";
        state.profilePasswordMessage = "";
        clearPasswordResetState();
        window.location.assign(buildAuthUrl(authConfig.logoutUrl, window.location.origin + "/"));
    });
    root.querySelector("#search")?.addEventListener("keydown", (event) => {
        const keyboardEvent = event;
        const input = keyboardEvent.target;
        if (keyboardEvent.key === "Tab") {
            const suggestion = getLibraryAutocomplete(input.value);
            if (!suggestion) {
                return;
            }
            keyboardEvent.preventDefault();
            input.value = suggestion;
            input.setSelectionRange(suggestion.length, suggestion.length);
            updateSearchSuggestion(input);
            return;
        }
        if (keyboardEvent.key !== "Enter") {
            return;
        }
        const scopedLibrary = getScopedLibraryOnly(input.value);
        state.search = input.value;
        input.value = "";
        updateSearchSuggestion(input);
        if (scopedLibrary) {
            state.search = "";
            void loadLibrary(scopedLibrary.id);
            return;
        }
        renderShell();
    });
    root.querySelector("#search")?.addEventListener("input", (event) => {
        updateSearchSuggestion(event.target);
    });
    root.querySelector("#search")?.addEventListener("blur", (event) => {
        const input = event.target;
        input.value = "";
        updateSearchSuggestion(input);
    });
    root.querySelectorAll("[data-nav-view]").forEach((button) => {
        button.addEventListener("click", (event) => {
            if (event.target.closest("[data-vault-menu], #lock-vault-sidebar-button, .library-context-menu")) {
                return;
            }
            const nextView = button.dataset.navView ?? "home";
            closeNavigationPanels();
            closeMobileNavigation();
            if (nextView === "home")
                void openUserHome(button);
            else
                openView(nextView);
        });
    });
    root.querySelectorAll("[data-settings-section]").forEach((button) => {
        button.addEventListener("click", () => {
            const nextSection = button.dataset.settingsSection;
            if (nextSection === "server" && state.user?.role !== "admin") {
                return;
            }
            state.settingsSection = nextSection;
            if (nextSection === "server") {
                state.serverSection = "libraries";
            }
            renderShell();
        });
    });
    root.querySelectorAll("[data-server-section]").forEach((button) => {
        button.addEventListener("click", () => {
            const nextSection = button.dataset.serverSection;
            if (state.user?.role !== "admin") {
                return;
            }
            state.settingsSection = "server";
            state.serverSection = nextSection;
            renderShell();
        });
    });
    root.querySelector("#vault-settings-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        void saveVaultSettings(event.currentTarget);
    });
    root.querySelector("#sync-library-select")?.addEventListener("change", (event) => {
        state.syncLibraryId = event.target.value;
        state.syncContentId = "";
        state.syncMessage = "";
        state.syncError = "";
        renderShell();
    });
    root.querySelector("#sync-settings-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        void synchronizeLibrary(event.currentTarget);
    });
    root.querySelector("#direct-download-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        void startDirectDownload(event.currentTarget);
    });
    root.querySelector("#reading-settings-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        void saveReadingModeSettings(event.currentTarget);
    });
    root.querySelectorAll("[data-library-id]").forEach((button) => {
        button.addEventListener("click", (event) => {
            if (event.target.closest("[data-library-menu-id], [data-scan-library-id], .library-context-menu")) {
                return;
            }
            state.openLibraryMenuId = null;
            closeMobileNavigation();
            void loadLibrary(button.dataset.libraryId ?? "");
        });
    });
    root.querySelectorAll("[data-library-menu-id]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const libraryId = button.dataset.libraryMenuId ?? "";
            state.openLibraryMenuId = state.openLibraryMenuId === libraryId ? null : libraryId;
            renderNavigationMenus();
        });
    });
    root.querySelectorAll("[data-scan-library-id]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            state.openLibraryMenuId = null;
            void scanLibraryById(button.dataset.scanLibraryId ?? "");
        });
    });
    root.querySelectorAll("[data-series-open]").forEach((button) => {
        button.addEventListener("click", (event) => {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
                return;
            event.preventDefault();
            state.openSeriesMenuId = null;
            state.openSeriesAddMenuId = null;
            state.openSeriesRemoveMenuId = null;
            closeMobileNavigation();
            void openSeries(button.dataset.seriesOpen ?? "");
        });
    });
    root.querySelectorAll("[data-series-menu-key]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const menuKey = button.dataset.seriesMenuKey ?? "";
            const isOpen = state.openSeriesMenuId === menuKey;
            state.openSeriesMenuId = isOpen ? null : menuKey;
            state.openSeriesAddMenuId = null;
            state.openSeriesRemoveMenuId = null;
            renderNavigationMenus();
        });
    });
    root.querySelectorAll("[data-series-add-menu-key]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const menuKey = button.dataset.seriesAddMenuKey ?? "";
            state.openSeriesAddMenuId = menuKey;
            state.openSeriesRemoveMenuId = null;
            renderNavigationMenus();
        });
        button.addEventListener("mouseenter", () => {
            const menuKey = button.dataset.seriesAddMenuKey ?? "";
            if (state.openSeriesAddMenuId === menuKey) {
                return;
            }
            state.openSeriesAddMenuId = menuKey;
            state.openSeriesRemoveMenuId = null;
            renderNavigationMenus();
        });
        button.addEventListener("focus", () => {
            const menuKey = button.dataset.seriesAddMenuKey ?? "";
            if (state.openSeriesAddMenuId === menuKey) {
                return;
            }
            state.openSeriesAddMenuId = menuKey;
            state.openSeriesRemoveMenuId = null;
            renderNavigationMenus();
        });
    });
    root.querySelectorAll("[data-series-remove-menu-key]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const menuKey = button.dataset.seriesRemoveMenuKey ?? "";
            state.openSeriesRemoveMenuId = menuKey;
            state.openSeriesAddMenuId = null;
            renderNavigationMenus();
        });
        button.addEventListener("mouseenter", () => {
            const menuKey = button.dataset.seriesRemoveMenuKey ?? "";
            if (state.openSeriesRemoveMenuId === menuKey) {
                return;
            }
            state.openSeriesRemoveMenuId = menuKey;
            state.openSeriesAddMenuId = null;
            renderNavigationMenus();
        });
        button.addEventListener("focus", () => {
            const menuKey = button.dataset.seriesRemoveMenuKey ?? "";
            if (state.openSeriesRemoveMenuId === menuKey) {
                return;
            }
            state.openSeriesRemoveMenuId = menuKey;
            state.openSeriesAddMenuId = null;
            renderNavigationMenus();
        });
    });
    root.querySelectorAll("[data-add-want]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void addToWantToRead(button.dataset.addWant ?? "");
        });
    });
    root.querySelectorAll("[data-profile-favorite-toggle]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void setProfileFavoriteFromMenu(button.dataset.profileFavoriteToggle ?? "", button.dataset.profileFavoriteEnabled === "true");
        });
    });
    root.querySelectorAll("[data-add-reading-list]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void addToReadingList(button.dataset.addReadingList ?? "");
        });
    });
    root.querySelectorAll("[data-add-collection]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void addToCollection(button.dataset.addCollection ?? "", button.dataset.contentId ?? "");
        });
    });
    root.querySelectorAll("[data-remove-want]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void removeFromWantToRead(button.dataset.removeWant ?? "");
        });
    });
    root.querySelectorAll("[data-remove-reading-list]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void removeFromReadingList(button.dataset.removeReadingList ?? "");
        });
    });
    root.querySelectorAll("[data-remove-reading-now]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void removeFromReadingNow(button.dataset.removeReadingNow ?? "");
        });
    });
    root.querySelectorAll("[data-remove-collection]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void removeFromCollection(button.dataset.removeCollection ?? "", button.dataset.contentId ?? "");
        });
    });
    root.querySelectorAll("[data-series-mark-read]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void markSeriesRead(button.dataset.seriesMarkRead ?? "");
        });
    });
    root.querySelectorAll("[data-series-mark-unread]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void markSeriesUnread(button.dataset.seriesMarkUnread ?? "");
        });
    });
    root.querySelectorAll("[data-series-scan]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void scanSeries(button.dataset.seriesScan ?? "");
        });
    });
    root.querySelectorAll("[data-series-sync]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void synchronizeSeries(button.dataset.seriesSync ?? "");
        });
    });
    root.querySelectorAll("[data-series-continue]").forEach((button) => {
        button.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const content = findContentById(button.dataset.seriesContinue ?? "");
            if (!content) {
                return;
            }
            openReaderAtProgress(content);
            if (state.reader?.mode === "vertical-scroll") {
                const p = state.reader.page;
                requestAnimationFrame(() => scrollReaderToPage(p));
            }
        });
    });
    root.querySelectorAll("[data-series-mark-toggle]").forEach((button) => {
        button.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const contentId = button.dataset.seriesMarkToggle ?? "";
            await toggleSeriesMark(contentId);
        });
    });
    root.querySelectorAll("[data-series-back]").forEach((button) => {
        button.addEventListener("click", () => {
            if (state.activeLibraryId) {
                const previous = parseRoute(window.history.state?.previousPath ?? '/');
                router.backTo(previous.kind === 'library' && previous.libraryId === state.activeLibraryId ? previous : { kind: 'library', libraryId: state.activeLibraryId });
            }
            else
                openView("home");
        });
    });
    root.querySelectorAll("[data-chapter-open]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const content = findContentById(button.dataset.chapterOpen ?? "");
            if (!content) {
                return;
            }
            const startPage = Number(button.dataset.chapterStart ?? "0");
            openReaderAtPageAndRender(content, startPage);
        });
    });
    root.querySelector("#reader-stage")?.addEventListener("scroll", () => {
        if (state.reader?.content.pageTypes.includes("pdf")) {
            // Com a janela de páginas marcadas (ou o nome) aberta, a barra continua visível ao rolar.
            if (!marcadoresPdfAbertos()) {
                state.reader.controlsVisible = false;
                if (pdfControlsHideTimer !== null) window.clearTimeout(pdfControlsHideTimer);
                pdfControlsHideTimer = null;
                document.querySelector(".reader-pdf-reader")?.classList.remove("controls-visible");
            }
            if (!pdfPointerStart?.mouse) pdfPointerStart = null;
            pdfDragSuppressedUntil = Date.now() + 600;
            return;
        }
        if (state.reader?.content.pageTypes.includes("epub")) {
            const frame = document.querySelector(".reader-epub");
            if (frame && state.reader.mode === "vertical-scroll")
                scheduleEpubPosition(frame);
            return;
        }
        if (!state.reader || state.reader.mode !== "vertical-scroll") {
            return;
        }
        if (readerScrollRaf !== null)
            return;
        readerScrollRaf = requestAnimationFrame(() => {
            readerScrollRaf = null;
            syncReaderPageFromScroll();
        });
    });
    root.querySelectorAll("[data-series-order]").forEach((select) => {
        select.addEventListener("change", () => {
            state.seriesChapterOrder = select.value;
            renderShell();
        });
    });
    root.querySelectorAll("[data-series-layout]").forEach((button) => {
        button.addEventListener("click", () => {
            state.seriesChapterLayout = button.dataset.seriesLayout === "grid" ? "grid" : "list";
            renderShell();
        });
    });
    root.querySelectorAll("[data-home-layout]").forEach((button) => {
        button.addEventListener("click", () => {
            state.homeLayout = button.dataset.homeLayout === "list" ? "list" : "grid";
            localStorage.setItem("pugotiread-home-layout", state.homeLayout);
            renderShell();
        });
    });
    root.querySelectorAll("[data-series-tab]").forEach((button) => {
        button.addEventListener("click", async () => {
            const nextTab = button.dataset.seriesTab;
            state.seriesTab = nextTab;
            state.seriesReviewError = "";
            if (nextTab === "reviews" && state.activeSeriesId && !state.seriesReviews[state.activeSeriesId]) {
                await loadSeriesReviews(state.activeSeriesId);
            }
            renderShell();
        });
    });
    root.querySelectorAll("[data-review-form]").forEach((form) => {
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            const content = getSelectedSeries();
            if (!content) {
                return;
            }
            const formData = new FormData(form);
            const rating = Number(formData.get("rating"));
            const comment = String(formData.get("comment") ?? "").trim();
            if (!Number.isInteger(rating * 2) || rating < 1 || rating > 5 || !comment) {
                state.seriesReviewError = "Escolha de 1 a 5 estrelas e escreva um comentário.";
                renderShell();
                return;
            }
            try {
                state.seriesReviewError = "";
                await api("/api/reviews", {
                    method: "POST",
                    body: JSON.stringify({
                        contentId: content.id,
                        rating,
                        comment
                    })
                });
                await loadSeriesReviews(content.id);
                await refreshProfileReviews();
                renderShell();
            }
            catch (error) {
                state.seriesReviewError = error instanceof Error ? error.message : "Não foi possível salvar sua review.";
                renderShell();
            }
        });
    });
}
function focusGlobalSearch() {
    if (state.reader)
        return;
    globalSearchOpen = true;
    globalSearchQuery = "";
    globalSearchExtraContents = [];
    const request = ++globalSearchRequest;
    renderShell();
    requestAnimationFrame(() => {
        document.querySelector("#global-search-input")?.focus({ preventScroll: true });
    });
    const extraLibraries = [...state.libraries.filter((library) => !globallyListedLibraryKinds.has(library.kind)),
        ...(state.vaultUnlocked ? state.personalLibraries : [])];
    void Promise.all([loadLibraryContents(extraLibraries), garantirCatalogoGlobal()]).then(([contents]) => {
        if (!globalSearchOpen || request !== globalSearchRequest)
            return;
        globalSearchExtraContents = contents;
        const results = document.querySelector("#global-search-results");
        if (results)
            results.innerHTML = renderGlobalSearchResults();
        bindGlobalSearchResultEvents();
    });
}
function closeGlobalSearch() {
    if (!globalSearchOpen)
        return;
    globalSearchOpen = false;
    globalSearchQuery = "";
    globalSearchExtraContents = [];
    globalSearchRequest++;
    renderShell();
    requestAnimationFrame(() => document.querySelector("#search-button")?.focus({ preventScroll: true }));
}
function closeGlobalSearchFromOutside(target) {
    const element = target instanceof Element ? target : null;
    if (globalSearchOpen && !element?.closest(".global-search-panel, .search-menu-shell")) {
        closeGlobalSearch();
    }
}
function toggleGlobalSearch() {
    if (globalSearchOpen)
        closeGlobalSearch();
    else
        focusGlobalSearch();
}
function bindGlobalSearchResultEvents(root = document) {
    root.querySelectorAll("[data-global-search-result]").forEach((button) => {
        button.onclick = () => {
            const contentId = button.dataset.globalSearchResult;
            const libraryId = button.dataset.libraryId;
            if (!contentId || !libraryId)
                return;
            globalSearchOpen = false;
            globalSearchQuery = "";
            globalSearchExtraContents = [];
            globalSearchRequest++;
            void router.navigate({ kind: "title", libraryId, contentId });
        };
    });
}
function findContentById(contentId) {
    return getAvailableContents().find((item) => item.id === contentId) ?? null;
}
function findPublicContentById(contentId) {
    return getPublicContents().find((item) => item.id === contentId) ?? null;
}
function getSelectedSeries() {
    if (!state.activeSeriesId) {
        return null;
    }
    return findContentById(state.activeSeriesId);
}
function getProgressForContent(contentId) {
    return state.progress.find((progress) => progress.contentId === contentId) ?? null;
}
function getBookmarksForContent(contentId) {
    return state.bookmarks
        .filter((bookmark) => bookmark.contentId === contentId)
        .sort((a, b) => a.page - b.page);
}
function isPageBookmarked(contentId, page) {
    return state.bookmarks.some((bookmark) => bookmark.contentId === contentId && bookmark.page === page);
}
async function setReaderPage(page, force = false, epubTargetOffset = 0) {
    if (!state.reader) {
        return;
    }
    if (state.reader.content.pageTypes.includes("pdf")) {
        navegarParaPaginaPdf(page + 1);
        return;
    }
    const mode = state.reader.mode;
    const contentId = state.reader.content.id;
    const maxPage = Math.max(state.reader.content.pageCount - 1, 0);
    const newPage = Math.min(Math.max(page, 0), maxPage);
    const oldPage = state.reader.page;
    if (newPage !== oldPage && state.reader.content.pageTypes.includes("epub"))
        state.reader.epubOffset = clampEpubOffset(epubTargetOffset);
    readerPrefetchDirection = newPage < oldPage ? -1 : 1;
    readerPrefetchGeneration += 1;
    if (newPage === oldPage && !force)
        return;
    if (mode === "vertical-scroll") {
        state.reader.page = newPage;
        syncReaderRoute();
        renderShell();
        requestAnimationFrame(() => scrollReaderToPage(newPage));
    }
    else {
        const content = state.reader.content;
        const navigationId = ++readerNavigationId;
        pendingReaderPage = newPage;
        if ((content.pageTypes[newPage] ?? "image") === "image") {
            showReaderLoadingAfterDelay(navigationId);
            try {
                await preloadReaderImage(content, newPage);
            }
            catch {
                clearReaderLoadingTimer();
                if (navigationId === readerNavigationId && state.reader?.content.id === contentId) {
                    setReaderLoadStatus("error", "A página não pôde ser carregada.");
                }
                return;
            }
            if (navigationId !== readerNavigationId || state.reader?.content.id !== contentId)
                return;
        }
        clearReaderLoadingTimer();
        state.reader.page = newPage;
        syncReaderRoute();
        pendingReaderPage = null;
        if (!updatePagedReaderPage(content, newPage))
            renderShell();
    }
    try {
        await api("/api/progress", {
            method: "PUT",
            body: JSON.stringify({ contentId, currentPage: newPage, epubOffset: state.reader?.content.pageTypes.includes("epub") ? state.reader.epubOffset : 0 })
        });
        await refreshProgress();
    }
    catch (error) {
        console.error(error);
    }
}
async function toggleReaderFullscreen() {
    if (!state.reader || readerFullscreenPending || !isReaderFullscreenAvailable())
        return;
    readerFullscreenPending = true;
    updateReaderFullscreenButton();
    const feedback = document.querySelector(".reader-pdf-feedback");
    if (feedback)
        feedback.hidden = true;
    try {
        if (isReaderFullscreen()) {
            await exitReaderFullscreen();
        }
        else {
            // A raiz permanece conectada mesmo quando o leitor atualiza seus controles.
            const root = document.documentElement;
            if (root.requestFullscreen && document.fullscreenEnabled)
                await root.requestFullscreen();
            else
                await root.webkitRequestFullscreen?.();
        }
    }
    catch (error) {
        console.error("Não foi possível alternar a tela cheia", error);
        if (feedback?.isConnected) {
            feedback.textContent = "Não foi possível ativar a tela cheia. Tente novamente ou verifique as permissões do navegador.";
            feedback.hidden = false;
        }
    }
    finally {
        readerFullscreenPending = false;
        updateReaderFullscreenButton();
    }
}
function mostrarFeedbackPdf(mensagem) {
    const feedback = document.querySelector(".reader-pdf-feedback");
    if (!feedback)
        return;
    feedback.textContent = mensagem;
    feedback.hidden = false;
}
function imprimirPdfAberto() {
    if (!state.reader?.content.pageTypes.includes("pdf"))
        return;
    const url = document.querySelector(".reader-pdf[data-pdf-url]")?.dataset.pdfUrl;
    if (!url) {
        mostrarFeedbackPdf("Não foi possível localizar o PDF para impressão.");
        return;
    }
    const destino = new URL("/pdf-print.html", window.location.origin);
    destino.searchParams.set("url", url);
    destino.searchParams.set("title", state.reader.content.title);
    destino.searchParams.set("v", "pdf-print-dialog-20260925");
    const janela = window.open(destino.href, "_blank");
    if (janela) {
        janela.opener = null;
    }
    else {
        mostrarFeedbackPdf("Permita abrir uma nova aba para imprimir o PDF e clique novamente.");
    }
}
function updateReaderFullscreenButton() {
    const button = document.querySelector(".reader-pdf-fullscreen, .reader-fullscreen");
    if (!button) {
        return;
    }
    const available = isReaderFullscreenAvailable();
    const label = available ? getReaderFullscreenLabel() : "Tela cheia indisponível neste navegador";
    const iconElement = button.querySelector(".icon");
    if (iconElement) {
        if (button.classList.contains("reader-fullscreen")) {
            iconElement.innerHTML = renderReaderFullscreenIcon();
        }
        else {
            iconElement.innerHTML = isReaderFullscreen()
                ? renderIconeToolbarPdf("M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3")
                : renderIconeToolbarPdf("M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3");
        }
    }
    button.title = label;
    button.setAttribute("aria-label", label);
    button.disabled = !available || readerFullscreenPending;
    button.setAttribute("aria-pressed", String(isReaderFullscreen()));
    button.setAttribute("aria-busy", String(readerFullscreenPending));
}
function getLibraryForContent(content) {
    return [...state.libraries, ...state.personalLibraries].find((library) => library.id === content.libraryId) ?? null;
}
function safeReaderPage(content, page) {
    const index = Number.isSafeInteger(page) ? Math.max(0, page) : 0;
    return content.pageTypes.includes("pdf") ? index : Math.min(index, Math.max(content.pageCount - 1, 0));
}
function openReader(content, page) {
    if (!findContentById(content.id))
        state.contents = [...state.contents, content];
    void router.navigate({ kind: "reader", libraryId: content.libraryId, contentId: content.id, page: safeReaderPage(content, page) + 1 });
}
function activateReader(content, page) {
    if (pdfControlsHideTimer !== null) window.clearTimeout(pdfControlsHideTimer);
    pdfControlsHideTimer = null;
    pdfPointerStart = null;
    pdfDragSuppressedUntil = 0;
    epubPanel = "none";
    const safePage = safeReaderPage(content, page);
    const library = getLibraryForContent(content);
    const defaults = state.readingSettingsDraft[library?.kind ?? "other"];
    const epub = content.pageTypes.includes("epub");
    const savedProgress = getProgressForContent(content.id);
    const savedAppearance = (() => {
        try {
            return JSON.parse(localStorage.getItem(`pugotiread-epub-appearance:${state.user?.id}`) ?? "{}");
        }
        catch {
            return {};
        }
    })();
    state.reader = {
        content,
        page: safePage,
        mode: defaults.mode === "paged-vertical" ? "vertical-scroll" : defaults.mode,
        fitting: defaults.fitting,
        direction: "ltr",
        zoom: 100,
        brightness: 100,
        bookTheme: savedAppearance.theme === "sepia" || savedAppearance.theme === "dark" ? savedAppearance.theme : "light",
        epubOffset: epub && savedProgress?.currentPage === safePage ? clampEpubOffset(savedProgress.epubOffset ?? 0) : 0,
        epubLengths: [],
        epubFont: savedAppearance.font === "sans" ? "sans" : "serif",
        epubFontSize: typeof savedAppearance.size === "number" ? Math.min(Math.max(savedAppearance.size, 14), 32) : 20,
        epubLineHeight: typeof savedAppearance.line === "number" ? Math.min(Math.max(savedAppearance.line, 1.3), 2.2) : 1.7,
        epubMargin: typeof savedAppearance.margin === "number" ? Math.min(Math.max(savedAppearance.margin, 12), 64) : 28,
        controlsVisible: content.pageTypes.includes("pdf") ? false : defaults.controlsVisible
    };
    state.activeSeriesId = content.id;
    rememberReadingProgress(content, safePage, state.reader.epubOffset);
    if (epub) {
        void api(`/api/contents/${encodeURIComponent(content.id)}/epub-metrics`)
            .then(({ lengths }) => {
            if (state.reader?.content.id !== content.id)
                return;
            state.reader.epubLengths = lengths;
            renderEpubOverlay();
        }).catch(error => console.error("Métricas do EPUB", error));
    }
}
function openReaderAtPageAndRender(content, page) {
    openReader(content, page);
}
function syncReaderPageFromScroll() {
    if (!state.reader || state.reader.content.pageTypes.includes("pdf") || state.reader.mode !== "vertical-scroll") {
        return;
    }
    const visiblePage = getVisibleReaderPage();
    if (visiblePage === null) {
        return;
    }
    if (visiblePage === state.reader.page) {
        return;
    }
    state.reader.page = visiblePage;
    syncReaderRoute();
    renderReaderOverlay();
    scheduleReaderProgressSave(state.reader.content, visiblePage);
}
function scheduleReaderProgressSave(content, page, epubOffset = 0) {
    if (!state.user) {
        return;
    }
    const safePage = safeReaderPage(content, page);
    const nextProgress = {
        userId: state.user.id,
        contentId: content.id,
        currentPage: safePage,
        epubOffset,
        updatedAt: new Date().toISOString()
    };
    state.progress = [
        nextProgress,
        ...state.progress.filter((progress) => progress.contentId !== content.id)
    ];
    if (readerProgressSaveTimer !== null) {
        window.clearTimeout(readerProgressSaveTimer);
    }
    readerProgressSaveTimer = window.setTimeout(() => {
        readerProgressSaveTimer = null;
        void api("/api/progress", {
            method: "PUT",
            body: JSON.stringify({ contentId: content.id, currentPage: safePage, epubOffset })
        }).catch((error) => console.error(error));
    }, 1200);
}
function getVisibleReaderPage() {
    const stage = document.querySelector("#reader-stage");
    const pages = Array.from(document.querySelectorAll("[data-reader-page-index]"));
    if (!stage || pages.length === 0) {
        return null;
    }
    const stageRect = stage.getBoundingClientRect();
    const focusY = stageRect.top + stageRect.height * 0.45;
    let closestPage = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const page of pages) {
        const rect = page.getBoundingClientRect();
        const pageCenter = rect.top + rect.height / 2;
        const distance = Math.abs(pageCenter - focusY);
        if (distance < closestDistance) {
            closestDistance = distance;
            closestPage = Number(page.dataset.readerPageIndex ?? "0");
        }
    }
    return closestPage;
}
function scrollReaderToPage(page) {
    const target = document.querySelector(`[data-reader-page-index="${page}"]`);
    if (!target) {
        return;
    }
    const stage = document.getElementById("reader-stage");
    if (!stage) {
        return;
    }
    stage.scrollTop = target.offsetTop;
    if (target instanceof HTMLImageElement && !target.complete) {
        target.addEventListener("load", () => {
            requestAnimationFrame(() => {
                if (state.reader?.mode === "vertical-scroll")
                    stage.scrollTop = target.offsetTop;
            });
        }, { once: true });
    }
}
function openReaderAtProgress(content) {
    const progress = getProgressForContent(content.id);
    openReader(content, progress?.currentPage ?? 0);
}
function rememberReadingProgress(content, page, epubOffset = 0) {
    if (!state.user) {
        return;
    }
    const safePage = safeReaderPage(content, page);
    const nextProgress = {
        userId: state.user.id,
        contentId: content.id,
        currentPage: safePage,
        epubOffset,
        updatedAt: new Date().toISOString()
    };
    state.progress = [
        nextProgress,
        ...state.progress.filter((progress) => progress.contentId !== content.id)
    ];
    void api("/api/progress", {
        method: "PUT",
        body: JSON.stringify({ contentId: content.id, currentPage: safePage, epubOffset })
    })
        .then(() => refreshProgress())
        .catch((error) => console.error(error));
}
async function openSeries(contentId) {
    const content = findContentById(contentId);
    if (!content) {
        return;
    }
    await router.navigate({ kind: "title", libraryId: content.libraryId, contentId: content.id });
}
async function loadSeriesReviews(contentId) {
    const { reviews } = await api(`/api/reviews?contentId=${encodeURIComponent(contentId)}`);
    state.seriesReviews = {
        ...state.seriesReviews,
        [contentId]: reviews
    };
}
async function refreshProfileReviews() {
    const { reviews } = await api("/api/me/reviews");
    state.profileReviews = reviews;
}
async function refreshSeriesMarks() {
    const { seriesMarks } = await api("/api/series-marks");
    state.seriesMarks = seriesMarks;
}
async function refreshUserLists() {
    const { wantToRead, readingList, collections } = await api("/api/user-lists");
    state.wantToRead = wantToRead;
    state.readingList = readingList;
    state.collections = collections;
}
async function toggleSeriesMark(contentId) {
    if (!contentId) {
        return;
    }
    await api("/api/series-marks", {
        method: "POST",
        body: JSON.stringify({ contentId })
    });
    await refreshSeriesMarks();
    renderShell();
}
async function addToWantToRead(contentId) {
    if (!contentId) {
        return;
    }
    await api("/api/want-to-read", {
        method: "POST",
        body: JSON.stringify({ contentId })
    });
    state.openSeriesMenuId = null;
    state.openSeriesAddMenuId = null;
    state.openSeriesRemoveMenuId = null;
    await refreshUserLists();
    renderShell();
}
async function addToReadingList(contentId) {
    if (!contentId) {
        return;
    }
    await api("/api/reading-list", {
        method: "POST",
        body: JSON.stringify({ contentId })
    });
    state.openSeriesMenuId = null;
    state.openSeriesAddMenuId = null;
    state.openSeriesRemoveMenuId = null;
    await refreshUserLists();
    renderShell();
}
async function addToCollection(collectionId, contentId) {
    if (!collectionId || !contentId) {
        return;
    }
    await api(`/api/collections/${encodeURIComponent(collectionId)}/contents`, {
        method: "POST",
        body: JSON.stringify({ contentId })
    });
    state.openSeriesMenuId = null;
    state.openSeriesAddMenuId = null;
    state.openSeriesRemoveMenuId = null;
    await refreshUserLists();
    renderShell();
}
async function removeFromWantToRead(contentId) {
    if (!contentId) {
        return;
    }
    await api(`/api/want-to-read?contentId=${encodeURIComponent(contentId)}`, { method: "DELETE" });
    state.openSeriesMenuId = null;
    state.openSeriesAddMenuId = null;
    state.openSeriesRemoveMenuId = null;
    await refreshUserLists();
    renderShell();
}
async function removeFromReadingList(contentId) {
    if (!contentId) {
        return;
    }
    await api(`/api/reading-list?contentId=${encodeURIComponent(contentId)}`, { method: "DELETE" });
    state.openSeriesMenuId = null;
    state.openSeriesAddMenuId = null;
    state.openSeriesRemoveMenuId = null;
    await refreshUserLists();
    renderShell();
}
async function removeFromReadingNow(contentId) {
    if (!contentId) {
        return;
    }
    state.openSeriesMenuId = null;
    state.openSeriesAddMenuId = null;
    state.openSeriesRemoveMenuId = null;
    try {
        await api(`/api/progress?contentId=${encodeURIComponent(contentId)}`, { method: "DELETE" });
        await refreshProgress();
        state.scanMessage = "";
        renderShell();
    }
    catch (error) {
        state.scanMessage = error instanceof Error ? error.message : "Não foi possível remover de Lendo agora.";
        renderShell();
    }
}
async function removeFromCollection(collectionId, contentId) {
    if (!collectionId || !contentId) {
        return;
    }
    await api(`/api/collections/${encodeURIComponent(collectionId)}/contents?contentId=${encodeURIComponent(contentId)}`, { method: "DELETE" });
    state.openSeriesMenuId = null;
    state.openSeriesAddMenuId = null;
    state.openSeriesRemoveMenuId = null;
    await refreshUserLists();
    renderShell();
}
async function refreshProgress() {
    const { progress } = await api("/api/continue");
    state.progress = progress;
}
async function markSeriesRead(contentId) {
    const content = findContentById(contentId);
    if (!content) {
        return;
    }
    state.openSeriesMenuId = null;
    state.openSeriesAddMenuId = null;
    state.openSeriesRemoveMenuId = null;
    try {
        await api("/api/progress", {
            method: "PUT",
            body: JSON.stringify({ contentId, currentPage: Math.max(content.pageCount - 1, 0) })
        });
        await refreshProgress();
        state.scanMessage = "";
        renderShell();
    }
    catch (error) {
        state.scanMessage = error instanceof Error ? error.message : "Não foi possível marcar a série como lida.";
        renderShell();
    }
}
async function markSeriesUnread(contentId) {
    if (!contentId) {
        return;
    }
    state.openSeriesMenuId = null;
    state.openSeriesAddMenuId = null;
    state.openSeriesRemoveMenuId = null;
    try {
        await api(`/api/progress?contentId=${encodeURIComponent(contentId)}`, { method: "DELETE" });
        await refreshProgress();
        state.scanMessage = "";
        renderShell();
    }
    catch (error) {
        state.scanMessage = error instanceof Error ? error.message : "Não foi possível marcar a série como não lida.";
        renderShell();
    }
}
async function scanSeries(contentId) {
    const content = findContentById(contentId);
    if (!content) {
        return;
    }
    state.scanMessage = `Escaneando ${content.title}...`;
    state.openSeriesMenuId = null;
    state.openSeriesAddMenuId = null;
    state.openSeriesRemoveMenuId = null;
    renderShell();
    try {
        await api(`/api/contents/${encodeURIComponent(contentId)}/scan`, {
            method: "POST"
        });
        await refreshLibraries();
        if (state.activeLibraryId) {
            const { contents } = await api(`/api/libraries/${state.activeLibraryId}/contents`);
            state.contents = contents;
        }
        state.scanMessage = `${content.title}: série verificada na pasta padrão.`;
        renderShell();
    }
    catch (error) {
        state.scanMessage = error instanceof Error ? error.message : "Não foi possível escanear a série.";
        renderShell();
    }
}
async function synchronizeSeries(contentId) {
    if (state.syncRunning || state.user?.role !== "admin") {
        return;
    }
    const content = findContentById(contentId);
    if (!content) {
        return;
    }
    state.syncRunning = true;
    state.scanMessage = `Sincronizando ${content.title}...`;
    state.openSeriesMenuId = null;
    state.openSeriesAddMenuId = null;
    state.openSeriesRemoveMenuId = null;
    renderShell();
    try {
        const { sync } = await api("/api/admin/sync", {
            method: "POST",
            body: JSON.stringify({
                libraryId: content.libraryId,
                contentId: content.id
            })
        });
        state.syncStatus = sync;
        state.syncRunning = true;
        state.scanMessage = `${sync.target}: sincronização iniciada em segundo plano.`;
    }
    catch (error) {
        state.syncRunning = false;
        state.scanMessage = error instanceof Error ? error.message : "Não foi possível sincronizar a obra.";
    }
    renderShell();
}
function getContentsByIds(contentIds) {
    return getContentsByIdsFrom(getAvailableContents(), contentIds);
}
function getContentsByIdsFrom(contents, contentIds) {
    const seen = new Set();
    return contentIds
        .map((contentId) => contents.find((content) => content.id === contentId))
        .filter((content) => {
        if (!content || seen.has(content.id)) {
            return false;
        }
        seen.add(content.id);
        return true;
    });
}
function getAvailableContents() {
    const byId = new Map();
    for (const content of [...state.readingNowContents, ...state.homeContents, ...state.contents]) {
        byId.set(content.id, content);
    }
    return [...byId.values()].sort((a, b) => a.title.localeCompare(b.title, "pt-BR", { numeric: true }));
}
function getReadingNowContents() {
    const byId = new Map();
    for (const content of [...state.readingNowContents, ...state.homeContents, ...state.contents]) {
        if (content.pageTypes.includes("pdf"))
            continue;
        byId.set(content.id, content);
    }
    return [...byId.values()].sort((a, b) => a.title.localeCompare(b.title, "pt-BR", { numeric: true }));
}
function getPublicContents() {
    return [...state.homeContents].sort((a, b) => a.title.localeCompare(b.title, "pt-BR", { numeric: true }));
}
function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
function bindReaderDelegatedEvents() {
    document.addEventListener("pointerdown", (event) => {
        if (!state.reader?.content.pageTypes.includes("pdf") || !(event.target instanceof Element)) return;
        const stage = event.target.closest("#reader-stage");
        if (!stage || event.target.closest("a, button, input, textarea, select, [contenteditable], .pdf-form-layer") || stage.closest(".pdf-form-editing, .pdf-placing-text")) return;
        if (event.pointerType === "mouse" && (event.button !== 0 || event.shiftKey)) return;
        pdfPointerStart = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, mouse: event.pointerType === "mouse", stage, scrollTop: stage.scrollTop, dragging: false };
    }, true);
    document.addEventListener("selectstart", (event) => {
        if (pdfPointerStart?.mouse) event.preventDefault();
    }, true);
    document.addEventListener("pointermove", (event) => {
        const gesture = pdfPointerStart;
        if (!gesture || gesture.pointerId !== event.pointerId || !state.reader?.content.pageTypes.includes("pdf")) return;
        if (!gesture.dragging && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 10) return;
        gesture.dragging = true;
        pdfDragSuppressedUntil = Date.now() + 600;
        state.reader.controlsVisible = false;
        if (pdfControlsHideTimer !== null) window.clearTimeout(pdfControlsHideTimer);
        pdfControlsHideTimer = null;
        document.querySelector(".reader-pdf-reader")?.classList.remove("controls-visible");
        if (gesture.mouse && (event.buttons & 1)) {
            gesture.stage.classList.add("pdf-mouse-dragging");
            gesture.stage.scrollTop = gesture.scrollTop - (event.clientY - gesture.y);
            event.preventDefault();
        } else {
            pdfPointerStart = null;
        }
    }, true);
    const endPdfPointer = (event) => {
        if (!pdfPointerStart || pdfPointerStart.pointerId !== event.pointerId) return;
        if (pdfPointerStart.dragging) pdfDragSuppressedUntil = Date.now() + 600;
        pdfPointerStart.stage.classList.remove("pdf-mouse-dragging");
        pdfPointerStart = null;
    };
    document.addEventListener("pointerup", endPdfPointer, true);
    document.addEventListener("pointercancel", endPdfPointer, true);
    document.addEventListener("click", (event) => {
        const target = event.target.closest("[data-reader-action]");
        if (!state.reader) {
            return;
        }
        if (!target) {
            const elemento = event.target instanceof Element ? event.target : null;
            if (state.reader.content.pageTypes.includes("pdf")) {
                if (elemento?.closest(".reader-pdf-toolbar, .reader-pdf-side-toolbar")) {
                    renderReaderOverlay();
                    return;
                }
                if (Date.now() < pdfDragSuppressedUntil || !elemento?.closest("#reader-stage") || elemento.closest("a, button, input, textarea, select, [contenteditable], .pdf-form-layer")) return;
                if (window.getSelection()?.toString().trim()) return;
                state.reader.controlsVisible = !state.reader.controlsVisible;
                renderReaderOverlay();
                return;
            }
            const acaoClique = resolverCliquePalcoLeitor({
                leitorPdf: state.reader.content.pageTypes.includes("pdf"),
                dentroPalco: Boolean(elemento?.closest("#reader-stage")),
                dentroInterface: Boolean(elemento?.closest(".reader-overlay, .reader-pagination, .reader-pdf-toolbar, .reader-pdf-side-toolbar, .reader-pdf-search, .pdf-outline-panel, .pdf-marks-panel, .pdf-mark-name, .reader-epub-search, .pdf-form-panel"))
            });
            if (acaoClique === "alternar-controles") {
                state.reader.controlsVisible = !state.reader.controlsVisible;
                renderReaderOverlay();
            }
            return;
        }
        const action = target.dataset.readerAction;
        if (!action)
            return;
        event.preventDefault();
        event.stopPropagation();
        if (state.reader.content.pageTypes.includes("pdf")) {
            state.reader.controlsVisible = true;
            renderReaderOverlay();
        }
        switch (action) {
            case "close":
                closeReader();
                break;
            case "epub-appearance":
                epubPanel = epubPanel === "appearance" ? "none" : "appearance";
                state.reader.controlsVisible = true;
                renderEpubOverlay();
                break;
            case "epub-appearance-close":
                epubPanel = "none";
                renderEpubOverlay();
                document.querySelector('[data-reader-action="epub-appearance"]')?.focus();
                break;
            case "epub-toc":
                epubPanel = epubPanel === "toc" ? "none" : "toc";
                state.reader.controlsVisible = true;
                renderEpubOverlay();
                break;
            case "epub-goto":
                epubPanel = "none";
                state.reader.epubOffset = 0;
                void setReaderPage(Number(target.dataset.epubPage ?? "0"), true);
                break;
            case "epub-appearance-reset": {
                const frame = document.querySelector(".reader-epub");
                if (frame)
                    state.reader.epubOffset = getEpubCurrentOffset(frame);
                state.reader.epubFont = "serif";
                state.reader.epubFontSize = 20;
                state.reader.epubLineHeight = 1.7;
                state.reader.epubMargin = 28;
                persistEpubAppearance();
                if (frame)
                    applyEpubAppearance(frame, true);
                renderEpubOverlay();
                break;
            }
            case "epub-view":
                state.reader.mode = state.reader.mode === "vertical-scroll" ? "horizontal" : "vertical-scroll";
                persistEpubAppearance();
                epubPanel = "none";
                renderShell();
                break;
            case "toggle-mode":
                state.reader.mode = getNextReaderMode(state.reader.mode);
                state.reader.controlsVisible = true;
                renderShell();
                if (state.reader.mode === "vertical-scroll") {
                    requestAnimationFrame(() => scrollReaderToPage(state.reader?.page ?? 0));
                }
                break;
            case "toggle-fitting":
                state.reader.fitting = getNextFittingMode(state.reader.fitting);
                state.reader.controlsVisible = true;
                renderShell();
                break;
            case "zoom-in":
                setReaderZoom(state.reader.zoom + 25);
                break;
            case "zoom-out":
                setReaderZoom(state.reader.zoom - 25);
                break;
            case "zoom-reset":
                setReaderZoom(100);
                break;
            case "toggle-book-theme":
                state.reader.bookTheme = state.reader.bookTheme === "light" ? "sepia" : state.reader.bookTheme === "sepia" ? "dark" : "light";
                persistEpubAppearance();
                state.reader.controlsVisible = true;
                renderShell();
                if (state.reader.mode === "vertical-scroll" && !state.reader.content.pageTypes.includes("epub")) {
                    requestAnimationFrame(() => scrollReaderToPage(state.reader?.page ?? 0));
                }
                break;
            case "fullscreen":
                void toggleReaderFullscreen();
                break;
            case "pdf-search":
                abrirPesquisaPdf();
                break;
            case "pdf-outline":
                alternarSumarioPdf();
                break;
            case "pdf-print":
                imprimirPdfAberto();
                break;
            case "pdf-marks":
                alternarPainelMarcadoresPdf();
                break;
            case "epub-search":
                abrirPesquisaEpub();
                break;
            case "bookmark":
                void handleReaderBookmark();
                break;
            case "page-prev":
                if (state.reader.content.pageTypes.includes("pdf"))
                    navegarRelativoPdf(-1);
                else if (state.reader.content.pageTypes.includes("epub"))
                    advanceEpubPage(-1);
                else
                    void setReaderPage(state.reader.page - 1);
                break;
            case "page-next":
                if (state.reader.content.pageTypes.includes("pdf"))
                    navegarRelativoPdf(1);
                else if (state.reader.content.pageTypes.includes("epub"))
                    advanceEpubPage(1);
                else
                    void setReaderPage(state.reader.page + 1);
                break;
            case "page-first":
                void setReaderPage(0);
                break;
            case "page-last":
                void setReaderPage(state.reader.content.pageCount - 1);
                break;
            case "chapter-prev":
                void setReaderPage(getAdjacentChapterStartPage(state.reader.content, state.reader.page, -1));
                break;
            case "chapter-next":
                void setReaderPage(getAdjacentChapterStartPage(state.reader.content, state.reader.page, 1));
                break;
            case "goto-bookmark":
                {
                    const page = Number(target.dataset.readerBookmarkPage ?? "0");
                    if (state.reader.content.pageTypes.includes("pdf"))
                        navegarParaPaginaPdf(page + 1);
                    else
                        void setReaderPage(page);
                }
                break;
            case "retry-page":
                if (pendingReaderPage !== null) {
                    const retryPage = pendingReaderPage;
                    // Failed entries are evicted, so retry creates one fresh controlled request.
                    void setReaderPage(retryPage, true);
                }
                break;
        }
    });
    document.addEventListener("change", (event) => {
        const target = event.target;
        if (!state.reader)
            return;
        if (target.matches("[data-epub-setting]")) {
            const control = target;
            if (control.dataset.epubSetting === "font")
                state.reader.epubFont = control.value === "sans" ? "sans" : "serif";
            if (control.dataset.epubSetting === "size")
                state.reader.epubFontSize = Number(control.value);
            if (control.dataset.epubSetting === "line")
                state.reader.epubLineHeight = Number(control.value);
            if (control.dataset.epubSetting === "margin")
                state.reader.epubMargin = Number(control.value);
            persistEpubAppearance();
            const frame = document.querySelector(".reader-epub");
            if (frame) {
                state.reader.epubOffset = getEpubCurrentOffset(frame);
                applyEpubAppearance(frame, true);
            }
            return;
        }
        if (target.matches("[data-reader-page-slider]")) {
            void setReaderPage(Number(target.value));
            return;
        }
        if (target.matches("[data-reader-brightness]")) {
            state.reader.brightness = Number(target.value);
            if (state.reader.content.pageTypes.includes("pdf")) {
                document.querySelector(".reader")?.style.setProperty("--reader-brightness", `${state.reader.brightness}%`);
                return;
            }
            state.reader.controlsVisible = true;
            if (state.reader.content.pageTypes.includes("epub"))
                renderEpubOverlay();
            else
                renderShell();
        }
    });
}
let readerBookmarkPending = false;
function atualizarBotaoMarcadorPdf(pagina) {
    if (!state.reader)
        return;
    const botao = document.querySelector(".reader-pdf-bookmark");
    if (!botao)
        return;
    const marcado = isPageBookmarked(state.reader.content.id, pagina);
    const icone = botao.querySelector(".icon");
    if (icone)
        icone.innerHTML = renderIconeMarcadorPdf(marcado);
    botao.classList.toggle("is-active", marcado);
    botao.setAttribute("aria-pressed", String(marcado));
    botao.disabled = readerBookmarkPending;
    botao.setAttribute("aria-busy", String(readerBookmarkPending));
    botao.title = `${marcado ? "Remover marcador" : "Marcar página"} (B)`;
    botao.setAttribute("aria-label", marcado ? "Remover marcador" : "Marcar página");
    atualizarPainelMarcadoresPdf();
}
async function handleReaderBookmark() {
    if (!state.reader || !state.user || readerBookmarkPending)
        return;
    readerBookmarkPending = true;
    if (state.reader.mode === "vertical-scroll") {
        syncReaderPageFromScroll();
    }
    const { content, page } = state.reader;
    const paginaMarcador = content.pageTypes.includes("pdf") ? Math.max(0, obterPaginaAtualPdf() - 1) : page;
    const contentId = content.id;
    const previousBookmarks = state.bookmarks;
    const existingBookmark = previousBookmarks.find((b) => b.contentId === contentId && b.page === paginaMarcador);
    state.reader.controlsVisible = true;
    state.bookmarks = existingBookmark
        ? previousBookmarks.filter((b) => !(b.contentId === contentId && b.page === paginaMarcador))
        : [...previousBookmarks, { userId: state.user.id, contentId, page: paginaMarcador, createdAt: new Date().toISOString() }];
    if (content.pageTypes.includes("pdf"))
        atualizarBotaoMarcadorPdf(Math.max(0, obterPaginaAtualPdf() - 1));
    else if (content.pageTypes.includes("epub"))
        renderEpubOverlay();
    else
        renderShell();
    if (!content.pageTypes.includes("pdf") && !content.pageTypes.includes("epub") && state.reader.mode === "vertical-scroll") {
        requestAnimationFrame(() => scrollReaderToPage(page));
    }
    try {
        await api("/api/bookmarks", { method: "POST", body: JSON.stringify({ contentId, page: paginaMarcador }) });
        const { bookmarks } = await api("/api/bookmarks");
        state.bookmarks = bookmarks;
        if (content.pageTypes.includes("pdf")) {
            atualizarBotaoMarcadorPdf(Math.max(0, obterPaginaAtualPdf() - 1));
            if (state.reader?.content.id === contentId) {
                if (existingBookmark)
                    fecharNomeMarcadorPdf(false);
                else
                    abrirNomeMarcadorPdf(paginaMarcador);
            }
        }
        else if (content.pageTypes.includes("epub"))
            renderEpubOverlay();
        else
            renderShell();
        if (!content.pageTypes.includes("pdf") && !content.pageTypes.includes("epub") && state.reader?.mode === "vertical-scroll") {
            requestAnimationFrame(() => scrollReaderToPage(page));
        }
    }
    catch (error) {
        console.error(error);
        state.bookmarks = previousBookmarks;
        if (content.pageTypes.includes("pdf"))
            atualizarBotaoMarcadorPdf(Math.max(0, obterPaginaAtualPdf() - 1));
        else
            renderShell();
    }
    finally {
        readerBookmarkPending = false;
        if (state.reader?.content.pageTypes.includes("pdf"))
            atualizarBotaoMarcadorPdf(Math.max(0, obterPaginaAtualPdf() - 1));
    }
}
// Páginas marcadas do PDF: nome na hora de marcar e janela com as marcações da obra aberta.
let marcadorPdfEmNome = null;
let marcadorPdfSalvando = false;
function fecharJanelasMarcadoresPdf(alvo) {
    if (closePhotoDialog())
        return true;
    const edicao = alvo instanceof Element ? alvo.closest(".pdf-marks-rename-form") : null;
    if (edicao) {
        cancelarEdicaoNoPainelPdf(Number(edicao.closest("[data-mark-page]")?.dataset.markPage));
        return true;
    }
    if (document.querySelector(".pdf-mark-name:not([hidden])")) {
        fecharNomeMarcadorPdf(true);
        return true;
    }
    if (document.querySelector(".pdf-marks-panel:not([hidden])")) {
        fecharPainelMarcadoresPdf(true);
        return true;
    }
    return false;
}
function marcadoresPdfAbertos() {
    return Boolean(document.querySelector(".pdf-marks-panel:not([hidden]), .pdf-mark-name:not([hidden])"));
}
function obterMarcadoresDoPdf() {
    if (!state.reader)
        return [];
    const contentId = state.reader.content.id;
    return state.bookmarks.filter((item) => item.contentId === contentId).sort((a, b) => a.page - b.page);
}
function tituloMarcadorPdf(marcador) {
    return marcador.name?.trim() || `Página ${marcador.page + 1}`;
}
async function salvarNomeMarcadorPdf(pagina, nome) {
    const contentId = state.reader?.content.id;
    if (!contentId)
        return;
    const { bookmark } = await api("/api/bookmarks", { method: "PATCH", body: JSON.stringify({ contentId, page: pagina, name: nome }) });
    state.bookmarks = state.bookmarks.map((item) => item.contentId === bookmark.contentId && item.page === bookmark.page ? { ...item, ...bookmark } : item);
    atualizarPainelMarcadoresPdf(false, true);
}
function obterNomeMarcadorPdf() {
    const leitor = document.querySelector(".reader-pdf-reader");
    if (!leitor)
        return null;
    let formulario = leitor.querySelector(".pdf-mark-name");
    if (formulario)
        return formulario;
    formulario = document.createElement("form");
    formulario.className = "pdf-mark-name";
    formulario.hidden = true;
    formulario.setAttribute("role", "dialog");
    formulario.setAttribute("aria-labelledby", "pdf-mark-name-title");
    formulario.innerHTML = `<p class="pdf-mark-name-title" id="pdf-mark-name-title"><span class="icon">${renderIconeMarcadorPdf(true)}</span><span data-mark-name-heading></span></p>
      <label for="pdf-mark-name-input">Nome da página <small>(opcional)</small></label>
      <input id="pdf-mark-name-input" type="text" maxlength="120" autocomplete="off" />
      <p class="pdf-mark-name-error" role="alert" hidden></p>
      <div class="pdf-mark-name-actions"><button type="button" class="secondary" data-mark-name-skip>Agora não</button><button type="submit" class="primary">Salvar</button></div>`;
    formulario.addEventListener("click", (event) => event.stopPropagation());
    // Teclas digitadas aqui não viram atalhos do leitor (o Esc é tratado no atalho global).
    formulario.addEventListener("keydown", (event) => event.stopPropagation());
    formulario.querySelector("[data-mark-name-skip]").addEventListener("click", () => fecharNomeMarcadorPdf(true));
    formulario.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (marcadorPdfEmNome === null || marcadorPdfSalvando)
            return;
        const nome = formulario.querySelector("input").value.trim();
        if (!nome) {
            fecharNomeMarcadorPdf(true);
            return;
        }
        const erro = formulario.querySelector(".pdf-mark-name-error");
        marcadorPdfSalvando = true;
        formulario.querySelectorAll("button, input").forEach((campo) => { campo.disabled = true; });
        erro.hidden = true;
        try {
            await salvarNomeMarcadorPdf(marcadorPdfEmNome, nome);
            fecharNomeMarcadorPdf(true);
        }
        catch (error) {
            console.error(error);
            erro.textContent = "Não foi possível salvar o nome. Tente novamente.";
            erro.hidden = false;
        }
        finally {
            marcadorPdfSalvando = false;
            formulario.querySelectorAll("button, input").forEach((campo) => { campo.disabled = false; });
            if (!formulario.hidden)
                formulario.querySelector("input").focus();
        }
    });
    leitor.append(formulario);
    return formulario;
}
// Fica ao lado do botão de marcador, na altura dele, sem sair da tela.
function posicionarJanelaAoLadoDaBarraPdf(elemento, ancora) {
    const barra = document.querySelector(".reader-pdf-side-toolbar")?.getBoundingClientRect();
    const alvo = ancora?.getBoundingClientRect();
    if (!barra || !alvo || window.matchMedia("(max-width: 720px)").matches) {
        elemento.style.removeProperty("top");
        elemento.style.removeProperty("right");
        return;
    }
    elemento.style.right = `${Math.round(window.innerWidth - barra.left + 10)}px`;
    const altura = elemento.offsetHeight;
    const topo = Math.min(Math.max(alvo.top + alvo.height / 2 - altura / 2, 12), window.innerHeight - altura - 12);
    elemento.style.top = `${Math.round(topo)}px`;
}
function abrirNomeMarcadorPdf(pagina) {
    const painel = document.querySelector(".pdf-marks-panel:not([hidden])");
    if (painel) {
        atualizarPainelMarcadoresPdf(false, true);
        const linha = painel.querySelector(`[data-mark-page="${pagina}"]`);
        if (linha) {
            linha.scrollIntoView({ block: "nearest" });
            editarNomeNoPainelPdf(linha, pagina);
        }
        return;
    }
    const formulario = obterNomeMarcadorPdf();
    if (!formulario)
        return;
    marcadorPdfEmNome = pagina;
    formulario.querySelector("[data-mark-name-heading]").textContent = `Página ${pagina + 1} marcada`;
    const campo = formulario.querySelector("input");
    campo.value = "";
    campo.placeholder = `Página ${pagina + 1}`;
    formulario.querySelector(".pdf-mark-name-error").hidden = true;
    formulario.hidden = false;
    posicionarJanelaAoLadoDaBarraPdf(formulario, document.querySelector(".reader-pdf-bookmark"));
    campo.focus();
    state.reader.controlsVisible = true;
    renderReaderOverlay();
}
function fecharNomeMarcadorPdf(devolverFoco) {
    const formulario = document.querySelector(".pdf-mark-name");
    marcadorPdfEmNome = null;
    if (!formulario || formulario.hidden)
        return;
    formulario.hidden = true;
    if (devolverFoco)
        document.querySelector(".reader-pdf-bookmark")?.focus();
    if (state.reader?.content.pageTypes.includes("pdf"))
        renderReaderOverlay();
}
function obterPainelMarcadoresPdf() {
    const leitor = document.querySelector(".reader-pdf-reader");
    if (!leitor)
        return null;
    let painel = leitor.querySelector(".pdf-marks-panel");
    if (painel)
        return painel;
    painel = document.createElement("aside");
    painel.className = "pdf-marks-panel";
    painel.id = "pdf-marks-panel";
    painel.hidden = true;
    painel.setAttribute("aria-labelledby", "pdf-marks-title");
    painel.innerHTML = `<header><h2 id="pdf-marks-title">Páginas marcadas</h2><span class="pdf-marks-total" aria-live="polite"></span><button type="button" class="pdf-marks-close" aria-label="Fechar páginas marcadas" title="Fechar">×</button></header>
      <div class="pdf-marks-step" role="group" aria-label="Navegar entre páginas marcadas"><button type="button" data-marks-step="-1">${renderIconeToolbarPdf("M15 6l-6 6l6 6")}<span>Anterior</span></button><button type="button" data-marks-step="1"><span>Próxima</span>${renderIconeToolbarPdf("M9 6l6 6l-6 6")}</button></div>
      <ol class="pdf-marks-list"></ol>
      <p class="pdf-marks-empty" hidden>Nenhuma página marcada neste PDF.<br />Use o marcador da barra (ou a tecla B) para marcar a página atual.</p>`;
    painel.addEventListener("click", (event) => event.stopPropagation());
    painel.addEventListener("keydown", (event) => event.stopPropagation());
    painel.querySelector(".pdf-marks-close").addEventListener("click", () => fecharPainelMarcadoresPdf(true));
    painel.querySelectorAll("[data-marks-step]").forEach((botao) => botao.addEventListener("click", () => {
        const destino = Number(botao.dataset.marksStepPage);
        if (Number.isInteger(destino))
            irParaMarcadorPdf(destino);
    }));
    painel.querySelector(".pdf-marks-list").addEventListener("click", (event) => {
        const linha = event.target.closest("[data-mark-page]");
        if (!linha)
            return;
        const pagina = Number(linha.dataset.markPage);
        if (event.target.closest(".pdf-marks-rename"))
            editarNomeNoPainelPdf(linha, pagina);
        else if (event.target.closest(".pdf-marks-go"))
            irParaMarcadorPdf(pagina);
    });
    leitor.append(painel);
    return painel;
}
function irParaMarcadorPdf(pagina) {
    navegarParaPaginaPdf(pagina + 1);
    atualizarPainelMarcadoresPdf();
    if (window.matchMedia("(max-width: 720px)").matches)
        fecharPainelMarcadoresPdf(false);
}
function editarNomeNoPainelPdf(linha, pagina) {
    const marcador = obterMarcadoresDoPdf().find((item) => item.page === pagina);
    if (!marcador)
        return;
    const formulario = document.createElement("form");
    formulario.className = "pdf-marks-rename-form";
    formulario.innerHTML = `<label class="sr-only" for="pdf-marks-rename-${pagina}">Nome da página ${pagina + 1}</label><input id="pdf-marks-rename-${pagina}" type="text" maxlength="120" autocomplete="off" placeholder="Página ${pagina + 1}" /><button type="submit" class="pdf-marks-save" aria-label="Salvar nome" title="Salvar">${renderIconeToolbarPdf("M5 12l5 5l9-10")}</button><button type="button" class="pdf-marks-cancel" aria-label="Cancelar" title="Cancelar">${renderIconeToolbarPdf("M18 6L6 18M6 6l12 12")}</button>`;
    const campo = formulario.querySelector("input");
    campo.value = marcador.name ?? "";
    formulario.querySelector(".pdf-marks-cancel").addEventListener("click", () => cancelarEdicaoNoPainelPdf(pagina));
    formulario.addEventListener("submit", async (event) => {
        event.preventDefault();
        formulario.querySelectorAll("button, input").forEach((item) => { item.disabled = true; });
        try {
            await salvarNomeMarcadorPdf(pagina, campo.value.trim());
            document.querySelector(`.pdf-marks-list [data-mark-page="${pagina}"] .pdf-marks-rename`)?.focus();
        }
        catch (error) {
            console.error(error);
            formulario.querySelectorAll("button, input").forEach((item) => { item.disabled = false; });
            campo.setAttribute("aria-invalid", "true");
            campo.title = "Não foi possível salvar o nome. Tente novamente.";
            campo.focus();
        }
    });
    linha.replaceChildren(formulario);
    campo.focus();
    campo.select();
}
function cancelarEdicaoNoPainelPdf(pagina) {
    atualizarPainelMarcadoresPdf(false, true);
    document.querySelector(`.pdf-marks-list [data-mark-page="${pagina}"] .pdf-marks-rename`)?.focus();
}
function atualizarPainelMarcadoresPdf(devolverFoco = false, refazer = devolverFoco) {
    if (!state.reader?.content.pageTypes.includes("pdf"))
        return;
    const marcadores = obterMarcadoresDoPdf();
    const contador = document.querySelector(".reader-pdf-marks-count");
    if (contador) {
        contador.textContent = marcadores.length > 99 ? "99+" : String(marcadores.length);
        contador.hidden = marcadores.length === 0;
    }
    document.querySelector(".reader-pdf-marks-button")?.setAttribute("aria-label", marcadores.length ? `Páginas marcadas (${marcadores.length})` : "Páginas marcadas");
    const painel = document.querySelector(".pdf-marks-panel");
    if (!painel || painel.hidden)
        return;
    // Não refaz a lista enquanto um nome está sendo editado nela.
    if (!refazer && painel.querySelector(".pdf-marks-rename-form"))
        return;
    const atual = Math.max(0, obterPaginaAtualPdf() - 1);
    painel.querySelector(".pdf-marks-total").textContent = marcadores.length === 1 ? "1 página" : `${marcadores.length} páginas`;
    const anterior = [...marcadores].reverse().find((item) => item.page < atual);
    const proxima = marcadores.find((item) => item.page > atual);
    for (const [botao, destino] of [[painel.querySelector('[data-marks-step="-1"]'), anterior], [painel.querySelector('[data-marks-step="1"]'), proxima]]) {
        botao.disabled = !destino;
        botao.dataset.marksStepPage = destino ? String(destino.page) : "";
        botao.title = destino ? `Ir para ${tituloMarcadorPdf(destino)} (página ${destino.page + 1})` : "Nenhuma página marcada nessa direção";
    }
    painel.querySelector(".pdf-marks-step").hidden = marcadores.length === 0;
    painel.querySelector(".pdf-marks-empty").hidden = marcadores.length > 0;
    const lista = painel.querySelector(".pdf-marks-list");
    // Só a página atual mudou: atualiza o destaque sem refazer a lista (mantém foco e rolagem).
    const assinatura = marcadores.map((item) => `${item.page}:${item.name ?? ""}`).join("|");
    if (!refazer && painel.dataset.assinatura === assinatura) {
        lista.querySelectorAll(".pdf-marks-go").forEach((botao) => {
            const marcada = Number(botao.closest("[data-mark-page]")?.dataset.markPage) === atual;
            if (marcada)
                botao.setAttribute("aria-current", "location");
            else
                botao.removeAttribute("aria-current");
        });
        lista.querySelector('[aria-current="location"]')?.scrollIntoView({ block: "nearest" });
        return;
    }
    painel.dataset.assinatura = assinatura;
    lista.innerHTML = marcadores.map((item) => {
        const titulo = tituloMarcadorPdf(item);
        const temNome = Boolean(item.name?.trim());
        return `<li data-mark-page="${item.page}"><button type="button" class="pdf-marks-go" ${item.page === atual ? 'aria-current="location"' : ""} aria-label="Ir para página ${item.page + 1}${temNome ? `: ${escapeHtml(titulo)}` : ""}"><strong>${escapeHtml(titulo)}</strong><span>${temNome ? `Página ${item.page + 1}` : "Sem nome"}</span></button><button type="button" class="pdf-marks-rename" aria-label="Renomear página ${item.page + 1}" title="Renomear">${renderIconeToolbarPdf("M4 20h4L18.5 9.5a2.83 2.83 0 0 0-4-4L4 16v4zM13.5 6.5l4 4")}</button></li>`;
    }).join("");
    if (devolverFoco)
        lista.querySelector('[aria-current="location"]')?.focus();
    lista.querySelector('[aria-current="location"]')?.scrollIntoView({ block: "nearest" });
}
function alternarPainelMarcadoresPdf() {
    const painel = obterPainelMarcadoresPdf();
    if (!painel)
        return;
    if (!painel.hidden) {
        fecharPainelMarcadoresPdf(true);
        return;
    }
    fecharNomeMarcadorPdf(false);
    painel.hidden = false;
    document.querySelector(".reader-pdf-marks-button")?.setAttribute("aria-expanded", "true");
    atualizarPainelMarcadoresPdf();
    posicionarJanelaAoLadoDaBarraPdf(painel, document.querySelector(".reader-pdf-marks-button"));
    (painel.querySelector('.pdf-marks-go[aria-current="location"]') ?? painel.querySelector(".pdf-marks-go") ?? painel.querySelector(".pdf-marks-close"))?.focus({ preventScroll: true });
    state.reader.controlsVisible = true;
    renderReaderOverlay();
}
function fecharPainelMarcadoresPdf(devolverFoco) {
    const painel = document.querySelector(".pdf-marks-panel");
    if (!painel || painel.hidden)
        return;
    painel.hidden = true;
    const botao = document.querySelector(".reader-pdf-marks-button");
    botao?.setAttribute("aria-expanded", "false");
    if (devolverFoco)
        botao?.focus();
    if (state.reader?.content.pageTypes.includes("pdf"))
        renderReaderOverlay();
}
// Clique fora fecha o nome do marcador (mantém "Página N") e a janela de páginas marcadas.
document.addEventListener("pointerdown", (event) => {
    const elemento = event.target instanceof Element ? event.target : null;
    if (!elemento)
        return;
    if (!elemento.closest(".pdf-mark-name, .reader-pdf-bookmark") && !marcadorPdfSalvando)
        fecharNomeMarcadorPdf(false);
    if (!elemento.closest(".pdf-marks-panel, .reader-pdf-marks-button, .reader-pdf-bookmark"))
        fecharPainelMarcadoresPdf(false);
}, true);
window.addEventListener("resize", () => {
    const painel = document.querySelector(".pdf-marks-panel:not([hidden])");
    if (painel)
        posicionarJanelaAoLadoDaBarraPdf(painel, document.querySelector(".reader-pdf-marks-button"));
    const nome = document.querySelector(".pdf-mark-name:not([hidden])");
    if (nome)
        posicionarJanelaAoLadoDaBarraPdf(nome, document.querySelector(".reader-pdf-bookmark"));
});
// ===== Campos calculados das fichas PDF =====
// Fichas como a de Mutantes & Malfeitores somam totais com scripts do próprio PDF. Eles rodam aqui, isolados:
// iframe sandbox sem mesma origem (sem cookies, DOM ou armazenamento do site) e CSP sem rede; dentro dele, um
// worker que é encerrado se um script travar. A página só troca mensagens com valores.
const PDF_CALC_WORKER = `
const cores = { transparent: ["T"], black: ["G", 0], white: ["G", 1], red: ["RGB", 1, 0, 0], green: ["RGB", 0, 1, 0], blue: ["RGB", 0, 0, 1], cyan: ["CMYK", 1, 0, 0, 0], magenta: ["CMYK", 0, 1, 0, 0], yellow: ["CMYK", 0, 0, 1, 0], dkGray: ["G", 0.25], gray: ["G", 0.5], ltGray: ["G", 0.75] };
const css = (c) => { if (!Array.isArray(c)) return null; const p = (v) => Math.round(Math.min(1, Math.max(0, Number(v) || 0)) * 255);
  if (c[0] === "G") return "rgb(" + p(c[1]) + "," + p(c[1]) + "," + p(c[1]) + ")";
  if (c[0] === "RGB") return "rgb(" + p(c[1]) + "," + p(c[2]) + "," + p(c[3]) + ")";
  if (c[0] === "CMYK") return "rgb(" + p((1 - c[1]) * (1 - c[4])) + "," + p((1 - c[2]) * (1 - c[4])) + "," + p((1 - c[3]) * (1 - c[4])) + ")";
  return null; };
const compilados = new Map();
onmessage = (mensagem) => {
  const { id, order, scripts, values } = mensagem.data;
  const campos = Object.create(null);
  for (const nome of Object.keys(values)) campos[nome] = { name: nome, value: values[nome], textColor: null, fillColor: null, display: 0, readonly: false, get valueAsString() { return String(this.value ?? ""); }, setAction() {}, setFocus() {} };
  const doc = { getField: (nome) => campos[nome] ?? null, calculateNow() {}, numFields: Object.keys(campos).length };
  const numero = (v) => { const n = parseFloat(String(v ?? "").replace(",", ".")); return isNaN(n) ? 0 : n; };
  const AFSimple_Calculate = function (op, lista) { const nomes = typeof lista === "string" ? lista.split(/\\s*,\\s*/) : Array.from(lista || []);
    const v = nomes.map((n) => numero(doc.getField(n)?.value)); let r = op === "PRD" ? 1 : 0;
    if (op === "SUM") r = v.reduce((a, b) => a + b, 0); else if (op === "PRD") r = v.reduce((a, b) => a * b, 1);
    else if (op === "AVG") r = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; else if (op === "MIN") r = v.length ? Math.min(...v) : 0; else if (op === "MAX") r = v.length ? Math.max(...v) : 0;
    this.event.value = r; };
  const util = { printf: (f, ...a) => String(a[0] ?? ""), printd: () => "" };
  const erros = {};
  for (let rodada = 0; rodada < 4; rodada++) {
    let mudou = false;
    for (const nome of order) {
      const campo = campos[nome]; if (!campo || !scripts[nome]) continue;
      let fn = compilados.get(scripts[nome]);
      if (!fn) { try { fn = new Function("event", "color", "util", "AFSimple_Calculate", "AFMakeNumber", "getField", "app", "display", scripts[nome]); } catch (e) { erros[nome] = String(e.message); continue; } compilados.set(scripts[nome], fn); }
      const event = { value: campo.value, target: campo, targetName: nome, name: "Calculate", type: "Field", rc: true };
      const contexto = Object.assign(Object.create(doc), { event });
      try { fn.call(contexto, event, cores, util, AFSimple_Calculate.bind(contexto), numero, doc.getField, { alert() {}, beep() {} }, { visible: 0, hidden: 1, noPrint: 2, noView: 3 }); }
      catch (e) { erros[nome] = String(e.message); continue; }
      if (event.rc === false) continue;
      const novo = event.value === undefined || event.value === null ? "" : typeof event.value === "number" ? (Number.isFinite(event.value) ? String(Math.round(event.value * 1e6) / 1e6) : "") : String(event.value);
      if (novo !== String(campo.value ?? "")) { campo.value = novo; mudou = true; }
    }
    if (!mudou) break;
  }
  const saida = {}, corDoTexto = {};
  for (const nome of order) if (campos[nome]) { saida[nome] = String(campos[nome].value ?? ""); corDoTexto[nome] = css(campos[nome].textColor); }
  postMessage({ id, values: saida, colors: corDoTexto, errors: erros });
};`;
const PDF_CALC_FRAME = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:"><script>
const CODIGO = ${JSON.stringify(PDF_CALC_WORKER)};
let worker = null, prazo = null;
const novo = () => { worker = new Worker(URL.createObjectURL(new Blob([CODIGO], { type: "text/javascript" }))); worker.onmessage = (e) => { clearTimeout(prazo); parent.postMessage(e.data, "*"); }; };
onmessage = (e) => {
  if (e.source !== parent) return;
  if (!worker) novo();
  clearTimeout(prazo);
  prazo = setTimeout(() => { worker.terminate(); worker = null; parent.postMessage({ id: e.data.id, error: "timeout" }, "*"); }, 1500);
  worker.postMessage(e.data);
};
parent.postMessage({ ready: true }, "*");
<\/script>`;
let pdfCalcFrame = null;
let pdfCalcReady = null;
let pdfCalcSequence = 0;
const pdfCalcPending = new Map();
function pdfCalcSandbox() {
    if (pdfCalcFrame?.isConnected)
        return pdfCalcReady;
    pdfCalcFrame = document.createElement("iframe");
    pdfCalcFrame.className = "pdf-calc-sandbox";
    pdfCalcFrame.setAttribute("sandbox", "allow-scripts");
    pdfCalcFrame.setAttribute("aria-hidden", "true");
    pdfCalcFrame.tabIndex = -1;
    pdfCalcFrame.srcdoc = PDF_CALC_FRAME;
    const frame = pdfCalcFrame;
    pdfCalcReady = new Promise(resolve => {
        const listener = event => {
            if (event.source !== frame.contentWindow || !event.data || typeof event.data !== "object")
                return;
            if (event.data.ready) {
                resolve(true);
                return;
            }
            const pending = pdfCalcPending.get(event.data.id);
            if (pending) {
                pdfCalcPending.delete(event.data.id);
                pending(event.data);
            }
        };
        window.addEventListener("message", listener);
    });
    document.body.append(pdfCalcFrame);
    return pdfCalcReady;
}
async function runPdfCalculations(calculations, values) {
    await pdfCalcSandbox();
    const id = ++pdfCalcSequence;
    const scripts = Object.fromEntries(Object.entries(calculations.fields).map(([name, field]) => [name, field.script]));
    return new Promise(resolve => {
        const timer = window.setTimeout(() => { pdfCalcPending.delete(id); resolve({ error: "timeout" }); }, 3000);
        pdfCalcPending.set(id, result => { window.clearTimeout(timer); resolve(result); });
        pdfCalcFrame.contentWindow.postMessage({ id, order: calculations.order, scripts, values }, "*");
    });
}
// Valor de cada campo como o Acrobat entrega aos scripts: caixa marcada vira "Yes"/"Off", listas viram o primeiro item.
function pdfCalcInputValues(editor) {
    const values = Object.create(null);
    for (const field of editor.schema.fields) {
        const value = editor.values[field.name] ?? field.value;
        values[field.name] = typeof value === "boolean" ? (value ? "Yes" : "Off") : Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
    }
    for (const [name, field] of Object.entries(editor.schema.calculations.fields))
        values[name] = String(editor.values[name] ?? field.value ?? "");
    return values;
}
const pdfCalcTimers = new WeakMap();
const pdfCalcColors = new WeakMap();
const pdfCalcLatest = new WeakMap();
function schedulePdfCalculation(editor, delay = 120) {
    if (!editor.schema?.calculations || !editor.editing)
        return;
    window.clearTimeout(pdfCalcTimers.get(editor));
    pdfCalcTimers.set(editor, window.setTimeout(() => void recalculatePdfForm(editor), delay));
}
async function recalculatePdfForm(editor) {
    const calculations = editor.schema?.calculations;
    if (!calculations || !editor.editing || editor.disposed)
        return;
    const request = {};
    pdfCalcLatest.set(editor, request);
    const result = await runPdfCalculations(calculations, pdfCalcInputValues(editor));
    if (pdfCalcLatest.get(editor) !== request || editor.disposed || editor.schema?.calculations !== calculations)
        return;
    if (result.error || !result.values) {
        editor.root.querySelectorAll("[data-pdf-calculated]").forEach(output => output.title = "Não foi possível calcular este campo automaticamente.");
        return;
    }
    for (const [name, value] of Object.entries(result.values)) {
        const saved = calculations.fields[name]?.value ?? "";
        if (value === saved)
            delete editor.values[name];
        else
            editor.values[name] = value;
    }
    pdfCalcColors.set(editor, result.colors ?? {});
    updatePdfCalculatedOutputs(editor);
}
function updatePdfCalculatedOutputs(editor) {
    const calculations = editor.schema?.calculations;
    if (!calculations)
        return;
    const colors = pdfCalcColors.get(editor) ?? {};
    for (const output of editor.root.querySelectorAll("[data-pdf-calculated]")) {
        const name = output.dataset.pdfCalculated ?? "";
        const value = String(editor.values[name] ?? calculations.fields[name]?.value ?? "");
        if (output.textContent !== value)
            output.textContent = value;
        // A ficha pinta de vermelho o que passa do limite (ex.: perícia acima de NP + 10, saldo negativo).
        const [red, green, blue] = (colors[name]?.match(/\d+/g) ?? []).map(Number);
        output.style.color = colors[name] ?? "";
        output.classList.toggle("is-alert", red > 180 && green < 100 && blue < 100);
    }
}
const pdfCalcEditors = new WeakMap();
const originalPdfFormRender = PdfFormEditor.prototype.render;
PdfFormEditor.prototype.render = function (element, annotations, viewport) {
    originalPdfFormRender.call(this, element, annotations, viewport);
    const calculations = this.schema?.calculations;
    const layer = element.querySelector(".pdf-form-layer");
    if (!calculations || !this.editing || !layer)
        return;
    pdfCalcEditors.set(element, this);
    for (const annotation of annotations) {
        const field = calculations.fields[annotation.fieldName];
        if (!field || annotation.subtype !== "Widget" || annotation.hidden)
            continue;
        const rect = viewport.convertToViewportRectangle(annotation.rect);
        const height = Math.abs(rect[3] - rect[1]);
        const output = document.createElement("output");
        output.className = "pdf-form-calculated";
        output.dataset.pdfCalculated = annotation.fieldName;
        output.dataset.pdfScale = String(viewport.scale ?? 1);
        output.setAttribute("aria-label", `${annotation.fieldName} (calculado automaticamente)`);
        output.title = "Calculado automaticamente pela ficha";
        Object.assign(output.style, {
            left: `${Math.min(rect[0], rect[2]) / viewport.width * 100}%`, top: `${Math.min(rect[1], rect[3]) / viewport.height * 100}%`,
            width: `${Math.abs(rect[2] - rect[0]) / viewport.width * 100}%`, height: `${height / viewport.height * 100}%`
        });
        // Tamanho automático (0 no PDF) acompanha a altura do campo, como no Acrobat.
        this.applyTextStyle(output, { font: "helvetica", fontSize: field.fontSize || Math.max(6, Math.min(12, height / (viewport.scale || 1) * 0.62)), color: "", alignment: field.alignment });
        output.style.color = "";
        layer.append(output);
    }
    updatePdfCalculatedOutputs(this);
    schedulePdfCalculation(this, 0);
};
// Qualquer campo digitado recalcula os totais da ficha daquela página.
document.addEventListener("input", event => {
    const control = event.target instanceof Element ? event.target.closest("[data-pdf-form-field]") : null;
    const page = control?.closest(".pdf-form-layer")?.parentElement;
    const editor = page ? pdfCalcEditors.get(page) : null;
    if (editor)
        schedulePdfCalculation(editor);
}, true);
document.addEventListener("change", event => {
    const control = event.target instanceof Element ? event.target.closest("[data-pdf-form-field]") : null;
    const page = control?.closest(".pdf-form-layer")?.parentElement;
    const editor = page ? pdfCalcEditors.get(page) : null;
    if (editor)
        schedulePdfCalculation(editor);
}, true);
// ===== Foto do personagem nas fichas PDF =====
// Campos de foto (ex.: o hexágono "NEN" da ficha de M&M) viram um botão no editor. A janela deixa escolher a imagem e
// enquadrar (arrastar e zoom) já com a máscara do formato; sai uma JPEG do tamanho do campo, que o servidor grava no PDF.
const PHOTO_HEXAGON_CLIP = "polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)";
const renderWithCalculations = PdfFormEditor.prototype.render;
PdfFormEditor.prototype.render = function (element, annotations, viewport) {
    renderWithCalculations.call(this, element, annotations, viewport);
    const images = this.schema?.images;
    const layer = element.querySelector(".pdf-form-layer");
    if (!images || !this.editing || !layer)
        return;
    for (const annotation of annotations) {
        const field = images[annotation.fieldName];
        if (!field || annotation.subtype !== "Widget" || annotation.hidden)
            continue;
        const name = annotation.fieldName;
        const rect = viewport.convertToViewportRectangle(annotation.rect);
        const pending = this.values[name];
        const hasPhoto = pending ? Boolean(pending.image) : field.hasImage;
        const box = document.createElement("button");
        box.type = "button";
        box.className = `pdf-form-photo${field.shape === "hexagon" ? " is-hexagon" : ""}${hasPhoto ? " has-photo" : ""}${pending ? " is-pending" : ""}`;
        box.dataset.pdfPhotoField = name;
        box.disabled = this.saving;
        box.setAttribute("aria-label", hasPhoto ? "Trocar foto do personagem" : "Escolher foto do personagem");
        box.title = hasPhoto ? "Trocar foto" : "Escolher foto";
        Object.assign(box.style, {
            left: `${Math.min(rect[0], rect[2]) / viewport.width * 100}%`, top: `${Math.min(rect[1], rect[3]) / viewport.height * 100}%`,
            width: `${Math.abs(rect[2] - rect[0]) / viewport.width * 100}%`, height: `${Math.abs(rect[3] - rect[1]) / viewport.height * 100}%`
        });
        if (pending?.image)
            box.style.backgroundImage = `url("${pending.image}")`;
        const label = document.createElement("span");
        label.className = "pdf-form-photo-label";
        label.textContent = pending && !pending.image ? "Foto removida" : hasPhoto ? "Trocar foto" : "Escolher foto";
        box.append(label);
        box.onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            openPhotoDialog(this, name, field, { width: Math.abs(annotation.rect[2] - annotation.rect[0]), height: Math.abs(annotation.rect[3] - annotation.rect[1]) }, box);
        };
        layer.append(box);
    }
};
function closePhotoDialog() {
    const backdrop = document.querySelector(".pdf-photo-backdrop");
    if (!backdrop)
        return false;
    backdrop.dispatchEvent(new Event("pdf-photo-close"));
    return true;
}
function openPhotoDialog(editor, name, field, size, opener) {
    closePhotoDialog();
    const ratio = size.width / size.height;
    const previewHeight = 300, previewWidth = Math.round(previewHeight * ratio);
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop pdf-photo-backdrop";
    backdrop.setAttribute("role", "presentation");
    const pending = editor.values[name];
    const hasPhoto = pending ? Boolean(pending.image) : field.hasImage;
    backdrop.innerHTML = `<section class="modal-panel pdf-photo-dialog" role="dialog" aria-modal="true" aria-labelledby="pdf-photo-title">
      <header class="modal-header"><h2 id="pdf-photo-title">Foto do personagem</h2><button class="icon-button" data-photo-close type="button" aria-label="Fechar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg></button></header>
      <div class="pdf-photo-body">
        <div class="pdf-photo-stage${field.shape === "hexagon" ? " is-hexagon" : ""}" data-photo-stage>
          <canvas width="${previewWidth * 2}" height="${previewHeight * 2}" style="width:${previewWidth}px;height:${previewHeight}px" aria-label="Enquadramento da foto" role="img"></canvas>
          <button class="pdf-photo-empty" data-photo-pick type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM12 16a3.5 3.5 0 1 0 0-7a3.5 3.5 0 0 0 0 7z"/></svg><span>Escolher imagem</span></button>
        </div>
        <div class="pdf-photo-controls" hidden>
          <label class="pdf-photo-zoom"><span>Zoom</span><input type="range" min="1" max="4" step="0.01" value="1" data-photo-zoom aria-label="Zoom da foto"></label>
          <p class="pdf-photo-hint">Arraste a foto para enquadrar o rosto.</p>
          <button class="button secondary" data-photo-pick type="button">Escolher outra imagem</button>
        </div>
        <p class="error pdf-photo-error" role="alert" hidden></p>
        <input type="file" accept="image/png,image/jpeg,image/webp" data-photo-file hidden>
      </div>
      <footer class="modal-actions">
        ${hasPhoto ? `<button class="button danger pdf-photo-remove" data-photo-remove type="button">Remover foto</button>` : ""}
        <button class="button secondary" data-photo-close type="button">Cancelar</button>
        <button class="button" data-photo-use type="button" disabled>Usar foto</button>
      </footer>
    </section>`;
    const canvas = backdrop.querySelector("canvas");
    const context = canvas.getContext("2d");
    const zoom = backdrop.querySelector("[data-photo-zoom]");
    const file = backdrop.querySelector("[data-photo-file]");
    const use = backdrop.querySelector("[data-photo-use]");
    const error = backdrop.querySelector(".pdf-photo-error");
    let image = null, offsetX = 0, offsetY = 0, drag = null;
    const baseScale = () => Math.max(canvas.width / image.width, canvas.height / image.height);
    const clampOffsets = () => {
        const scale = baseScale() * Number(zoom.value);
        const [w, h] = [image.width * scale, image.height * scale];
        offsetX = Math.min(0, Math.max(canvas.width - w, offsetX));
        offsetY = Math.min(0, Math.max(canvas.height - h, offsetY));
    };
    const hexagon = () => {
        const r = Math.min(canvas.height / 2, canvas.width / Math.sqrt(3)), cx = canvas.width / 2, cy = canvas.height / 2, half = r * Math.sqrt(3) / 2;
        context.moveTo(cx, cy - r);
        for (const [x, y] of [[cx + half, cy - r / 2], [cx + half, cy + r / 2], [cx, cy + r], [cx - half, cy + r / 2], [cx - half, cy - r / 2]])
            context.lineTo(x, y);
        context.closePath();
    };
    const draw = () => {
        context.clearRect(0, 0, canvas.width, canvas.height);
        if (image) {
            const scale = baseScale() * Number(zoom.value);
            context.drawImage(image, offsetX, offsetY, image.width * scale, image.height * scale);
        }
        if (field.shape !== "hexagon")
            return;
        // Fora do hexágono fica escurecido: é o que não entra na ficha.
        context.save();
        if (image) {
            context.beginPath();
            context.rect(0, 0, canvas.width, canvas.height);
            hexagon();
            context.fillStyle = "rgba(15, 23, 42, 0.62)";
            context.fill("evenodd");
        }
        context.beginPath();
        hexagon();
        context.setLineDash(image ? [] : [10, 8]);
        context.lineWidth = 4;
        context.strokeStyle = image ? "#e9c77d" : "rgba(148, 163, 184, 0.8)";
        context.stroke();
        context.restore();
    };
    const close = () => { backdrop.remove(); if (opener?.isConnected) opener.focus(); };
    backdrop.addEventListener("pdf-photo-close", close);
    const load = (blob) => {
        if (!/^image\/(png|jpeg|webp)$/.test(blob.type)) {
            error.textContent = "Escolha uma imagem JPG, PNG ou WebP.";
            error.hidden = false;
            return;
        }
        const url = URL.createObjectURL(blob);
        const loaded = new Image();
        loaded.onload = () => {
            URL.revokeObjectURL(url);
            image = loaded;
            zoom.value = "1";
            // Começa centrado na largura e no topo (onde costuma estar o rosto).
            const scale = baseScale();
            offsetX = (canvas.width - image.width * scale) / 2;
            offsetY = 0;
            clampOffsets();
            draw();
            error.hidden = true;
            backdrop.querySelector(".pdf-photo-empty").hidden = true;
            backdrop.querySelector(".pdf-photo-controls").hidden = false;
            use.disabled = false;
            use.focus();
        };
        loaded.onerror = () => { URL.revokeObjectURL(url); error.textContent = "Não foi possível abrir esta imagem."; error.hidden = false; };
        loaded.src = url;
    };
    backdrop.querySelectorAll("[data-photo-pick]").forEach(button => button.addEventListener("click", () => file.click()));
    file.addEventListener("change", () => { if (file.files?.[0]) load(file.files[0]); file.value = ""; });
    zoom.addEventListener("input", () => {
        if (!image)
            return;
        // Zoom a partir do centro do quadro.
        const before = baseScale() * Number(zoom.dataset.previous || 1), after = baseScale() * Number(zoom.value);
        const [cx, cy] = [canvas.width / 2, canvas.height / 2];
        offsetX = cx - (cx - offsetX) * after / before;
        offsetY = cy - (cy - offsetY) * after / before;
        zoom.dataset.previous = zoom.value;
        clampOffsets();
        draw();
    });
    canvas.addEventListener("pointerdown", event => { if (!image) return; drag = { x: event.clientX, y: event.clientY, offsetX, offsetY }; canvas.setPointerCapture(event.pointerId); });
    canvas.addEventListener("pointermove", event => {
        if (!drag)
            return;
        const factor = canvas.width / canvas.getBoundingClientRect().width;
        offsetX = drag.offsetX + (event.clientX - drag.x) * factor;
        offsetY = drag.offsetY + (event.clientY - drag.y) * factor;
        clampOffsets();
        draw();
    });
    canvas.addEventListener("pointerup", () => { drag = null; });
    canvas.addEventListener("wheel", event => {
        if (!image)
            return;
        event.preventDefault();
        zoom.value = String(Math.min(4, Math.max(1, Number(zoom.value) * (event.deltaY < 0 ? 1.08 : 1 / 1.08))));
        zoom.dispatchEvent(new Event("input"));
    }, { passive: false });
    const commit = (value) => {
        editor.checkpoint();
        editor.values[name] = value;
        editor.name.dispatchEvent(new Event("input")); // marca "alterações não salvas" no editor
        editor.status.textContent = "Alterações ainda não salvas.";
        close();
        editor.refresh();
    };
    use.addEventListener("click", () => {
        if (!image)
            return;
        // Sai no tamanho do campo a ~4 px por ponto (nítida na tela e na impressão), sem passar de 2 MB.
        const output = document.createElement("canvas");
        output.width = Math.round(Math.min(900, size.width * 4));
        output.height = Math.round(output.width / ratio);
        const factor = output.width / canvas.width;
        const scale = baseScale() * Number(zoom.value) * factor;
        const out = output.getContext("2d");
        out.fillStyle = "#e3eae4";
        out.fillRect(0, 0, output.width, output.height);
        out.drawImage(image, offsetX * factor, offsetY * factor, image.width * scale, image.height * scale);
        let quality = 0.9, data = output.toDataURL("image/jpeg", quality);
        while (data.length > 2.6 * 1024 * 1024 && quality > 0.5)
            data = output.toDataURL("image/jpeg", quality -= 0.1);
        commit({ image: data });
    });
    backdrop.querySelector("[data-photo-remove]")?.addEventListener("click", () => commit({ image: null }));
    backdrop.querySelectorAll("[data-photo-close]").forEach(button => button.addEventListener("click", close));
    backdrop.addEventListener("mousedown", event => { if (event.target === backdrop) close(); });
    document.body.append(backdrop);
    draw();
    backdrop.querySelector(".pdf-photo-empty").focus();
}
// ===== Salvar ficha sem recarregar o site =====
// O "Salvar" do editor (pdf-form.js, da imagem) recarregava o PugotiRead inteiro. Aqui ele grava, limpa o rascunho e:
// na mesma ficha, recarrega só o PDF; se virou outra ficha (cópia privada ou renomeada), abre a nova pelo próprio app.
let pdfFormDirty = null;
// O conjunto de "alterações não salvas" é privado do pdf-form.js; ele é achado uma vez pelo campo de nome do editor,
// que faz dirty.add(contentId) a cada digitação.
function pdfFormDirtySet(editor) {
    if (pdfFormDirty)
        return pdfFormDirty;
    const add = Set.prototype.add;
    Set.prototype.add = function (value) {
        if (value === editor.contentId && !pdfFormDirty)
            pdfFormDirty = this;
        return add.call(this, value);
    };
    try {
        editor.name.dispatchEvent(new Event("input"));
    }
    finally {
        Set.prototype.add = add;
    }
    return pdfFormDirty;
}
function avisoFichaSalva(mensagem) {
    mostrarFeedbackPdf(mensagem);
    const feedback = document.querySelector(".reader-pdf-feedback");
    if (feedback)
        window.setTimeout(() => { if (feedback.textContent === mensagem) feedback.hidden = true; }, 2600);
}
PdfFormEditor.prototype.changeExisting = async function (name) {
    if (this.saving || !this.schema)
        return;
    const criaCopia = Boolean(this.schema.saveCreatesCopy);
    this.saving = true;
    this.panel.querySelectorAll("input,button,select").forEach(control => control.disabled = true);
    this.refresh();
    this.status.textContent = criaCopia ? "Criando sua ficha…" : "Salvando…";
    let saved = null;
    try {
        saved = await api(`/api/contents/${encodeURIComponent(this.contentId)}/pdf-form/save`, { method: "POST", body: JSON.stringify({ revision: this.schema.revision, values: { ...this.values }, styles: { ...this.styles }, edits: this.edits, name }) });
    }
    catch (error) {
        this.status.textContent = error instanceof Error ? error.message : "Não foi possível salvar a ficha. Seus campos foram mantidos.";
    }
    finally {
        this.saving = false;
        this.panel.querySelectorAll("input,button,select").forEach(control => control.disabled = false);
        if (!this.disposed)
            this.refresh();
    }
    if (!saved)
        return;
    for (const key of Object.keys(this.values))
        delete this.values[key];
    for (const key of Object.keys(this.styles))
        delete this.styles[key];
    this.edits.splice(0);
    this.history.clear();
    this.syncHistory();
    pdfFormDirtySet(this)?.delete(this.contentId);
    if (saved.content) {
        window.dispatchEvent(new CustomEvent("pugotiread:pdf-copy-saved", { detail: saved.content }));
        if (state.reader?.content.id === saved.content.id)
            Object.assign(state.reader.content, saved.content);
    }
    if (saved.content && saved.content.id !== this.contentId) {
        const pagina = Math.max(0, obterPaginaAtualPdf() - 1);
        openReaderAtPageAndRender(saved.content, pagina);
        avisoFichaSalva(criaCopia ? "Sua ficha foi criada. O modelo original continua intacto." : "Ficha salva.");
        return;
    }
    if (!saved.content && criaCopia) {
        this.closeEditor();
        avisoFichaSalva("Sua ficha foi criada na pasta Fichas. A biblioteca ainda está atualizando.");
        return;
    }
    const { fields, revision, originalName, pageCount, calculations, images } = saved;
    this.schema = { ...this.schema, ...(fields ? { fields } : {}), ...(revision ? { revision } : {}), ...(originalName ? { originalName } : {}), ...(pageCount ? { pageCount } : {}), calculations: calculations ?? this.schema.calculations, images: images ?? this.schema.images };
    if (originalName)
        this.name.value = originalName;
    this.closeEditor();
    await this.reloadPreview();
    this.status.textContent = "Ficha salva.";
    avisoFichaSalva("Ficha salva.");
};
// ===== Menu dos três pontinhos nas fichas de RPG =====
// O menu (series-card.js) troca as opções de obra por ações de ficha; os cliques chegam aqui por delegação porque o
// menu flutuante é redesenhado fora do bindShellEvents.
function esperarElemento(seletor, limite = 15000) {
    return new Promise(resolve => {
        const inicio = Date.now();
        const tentar = () => {
            const elemento = document.querySelector(seletor);
            if (elemento || Date.now() - inicio > limite)
                resolve(elemento ?? null);
            else
                window.setTimeout(tentar, 120);
        };
        tentar();
    });
}
function fecharMenuDaFicha() {
    state.openSeriesMenuId = null;
    state.openSeriesAddMenuId = null;
    state.openSeriesRemoveMenuId = null;
    renderNavigationMenus();
}
function urlDoPdfDaFicha(content) {
    // Sem a versão da capa: baixar/imprimir sempre pega o arquivo como está agora.
    return `/api/contents/${encodeURIComponent(content.id)}/pages/0?agora=${Date.now()}`;
}
function paginaDaFicha(content) {
    const progresso = state.progress.find(item => item.contentId === content.id);
    return progresso ? Math.max(0, progresso.currentPage) : 0;
}
async function executarAcaoDaFicha(acao, content, origem) {
    fecharMenuDaFicha();
    if (acao === "abrir") {
        openReaderAtPageAndRender(content, paginaDaFicha(content));
        return;
    }
    if (acao === "preencher") {
        openReaderAtPageAndRender(content, paginaDaFicha(content));
        (await esperarElemento(".pdf-form-toggle:not([disabled])"))?.click();
        return;
    }
    if (acao === "detalhes") {
        await openSeries(content.id);
        return;
    }
    if (acao === "compartilhar") {
        // Administrador: a janela de acesso das Fichas preenchidas; dono: as propriedades na página da ficha.
        if (state.user?.role === "admin" && state.pdfFormCopies.some(copy => copy.contentId === content.id)) {
            openPdfSheetEditor(content.id, origem);
            return;
        }
        await openSeries(content.id);
        const propriedades = await esperarElemento(".rpg-properties");
        if (propriedades) {
            propriedades.open = true;
            propriedades.scrollIntoView({ block: "start", behavior: "smooth" });
            propriedades.querySelector("[name=visibility]")?.focus({ preventScroll: true });
        }
        return;
    }
    if (acao === "baixar") {
        const link = document.createElement("a");
        link.href = urlDoPdfDaFicha(content);
        link.download = `${content.title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "ficha"}.pdf`;
        document.body.append(link);
        link.click();
        link.remove();
        return;
    }
    if (acao === "imprimir") {
        const destino = new URL("/pdf-print.html", window.location.origin);
        destino.searchParams.set("url", urlDoPdfDaFicha(content));
        destino.searchParams.set("title", content.title);
        destino.searchParams.set("v", "pdf-print-dialog-20260925");
        const janela = window.open(destino.href, "_blank");
        if (janela)
            janela.opener = null;
        return;
    }
    if (acao === "criar") {
        try {
            const resultado = await api(`/api/contents/${encodeURIComponent(content.id)}/pdf-form/copies`, { method: "POST", body: JSON.stringify({ name: "", values: {} }) });
            if (!resultado.content)
                throw new Error("Sua ficha foi criada na pasta Fichas. A biblioteca ainda está atualizando.");
            window.dispatchEvent(new CustomEvent("pugotiread:pdf-copy-saved", { detail: resultado.content }));
            openReaderAtPageAndRender(resultado.content, 0);
            (await esperarElemento(".pdf-form-toggle:not([disabled])"))?.click();
        }
        catch (error) {
            window.alert(error instanceof Error ? error.message : "Não foi possível criar a ficha.");
        }
    }
}
document.addEventListener("click", event => {
    const botao = event.target instanceof Element ? event.target.closest("[data-sheet-action]") : null;
    if (!botao)
        return;
    event.preventDefault();
    event.stopPropagation();
    const content = findContentById(botao.dataset.contentId ?? "");
    if (content)
        void executarAcaoDaFicha(botao.dataset.sheetAction ?? "", content, botao.closest(".series-card")?.querySelector("[data-series-menu-key]") ?? null);
}, true);
// ===== Texto que cabe na célula do editor de PDF =====
// Célula de linha única: a fonte diminui enquanto se digita até o texto caber (nunca passa do tamanho da ficha), com o
// texto centralizado na vertical. Caixa de várias linhas: diminui até caber na altura. O servidor grava igual no PDF.
const medidorDeTexto = document.createElement("canvas").getContext("2d");
function ajustarFonteDaCelula(controle) {
    if (!(controle instanceof HTMLInputElement && controle.type === "text") && !(controle instanceof HTMLTextAreaElement))
        return;
    const base = Number(controle.dataset.fonteBase) || parseFloat(getComputedStyle(controle).fontSize);
    if (!base)
        return;
    controle.dataset.fonteBase = String(base);
    const minimo = 4 * Number(controle.dataset.pdfScale || 1);
    const estilo = getComputedStyle(controle);
    if (controle instanceof HTMLInputElement) {
        const disponivel = controle.clientWidth - parseFloat(estilo.paddingLeft) - parseFloat(estilo.paddingRight) - 1;
        medidorDeTexto.font = `${estilo.fontStyle} ${estilo.fontWeight} ${base}px ${estilo.fontFamily}`;
        const largura = medidorDeTexto.measureText(controle.value).width;
        const tamanho = largura > disponivel && disponivel > 0 ? Math.max(minimo, base * disponivel / largura) : base;
        controle.style.fontSize = `${tamanho.toFixed(2)}px`;
        controle.classList.toggle("pdf-form-reduzido", tamanho < base - 0.01);
        return;
    }
    let tamanho = base;
    controle.style.fontSize = `${tamanho}px`;
    while (controle.scrollHeight > controle.clientHeight + 1 && tamanho > minimo) {
        tamanho = Math.max(minimo, tamanho - 0.5);
        controle.style.fontSize = `${tamanho}px`;
    }
    // Nem com a fonte mínima coube: deixa rolar em vez de esconder o resto.
    controle.style.overflowY = controle.scrollHeight > controle.clientHeight + 1 ? "auto" : "hidden";
    controle.classList.toggle("pdf-form-reduzido", tamanho < base - 0.01);
}
// O tamanho base vem do estilo do campo (fonte da ficha ou a escolhida no painel); depois de aplicar, ajusta ao conteúdo.
const aplicarEstiloOriginal = PdfFormEditor.prototype.applyTextStyle;
PdfFormEditor.prototype.applyTextStyle = function (control, style) {
    aplicarEstiloOriginal.call(this, control, style);
    control.dataset.fonteBase = String(style.fontSize * Number(control.dataset.pdfScale || 1));
    ajustarFonteDaCelula(control);
};
const renderComCelulas = PdfFormEditor.prototype.render;
PdfFormEditor.prototype.render = function (element, annotations, viewport) {
    renderComCelulas.call(this, element, annotations, viewport);
    // Depois que a camada entra na página (clientWidth real), ajusta todas as células.
    requestAnimationFrame(() => element.querySelectorAll(".pdf-form-layer [data-pdf-form-field]").forEach(ajustarFonteDaCelula));
};
document.addEventListener("input", event => {
    const controle = event.target instanceof Element ? event.target.closest(".pdf-form-layer [data-pdf-form-field]") : null;
    if (controle)
        ajustarFonteDaCelula(controle);
}, true);
// ===== Foto do personagem (leitor de fichas) =====
// Só em ficha de usuário (cópia com dono). Área fixa à esquerda da página, sempre visível ao rolar; sem espaço ao lado
// da página vira miniatura no canto (clique amplia). O botão da barra lateral aparece para quem pode trocar a foto
// (dono ou administrador). A foto também vira a capa do cartão (o servidor troca o coverUrl).
const ICONE_FOTO_PERSONAGEM = "M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM12 10a3.5 3.5 0 1 0 0 7a3.5 3.5 0 0 0 0-7z";
function ehFichaDeUsuario(content) {
    return Boolean(content?.formOwnerUserId) && Boolean(content?.pageTypes?.includes("pdf"));
}
function podeTrocarFotoPersonagem(content) {
    return ehFichaDeUsuario(content) && (state.user?.role === "admin" || content.formOwnerUserId === state.user?.id);
}
function renderBotaoFotoPersonagem(content) {
    if (!podeTrocarFotoPersonagem(content))
        return "";
    const rotulo = content.characterPhotoUrl ? "Trocar foto do personagem" : "Adicionar foto do personagem";
    return `<button class="reader-pdf-photo-button" data-reader-action="foto-personagem" type="button" aria-label="${rotulo}" title="${rotulo}">${renderIconeToolbarPdf(ICONE_FOTO_PERSONAGEM)}</button>`;
}
function renderPainelFotoPersonagem(content) {
    // Sem foto não há painel: ela é adicionada pelo ícone do menu lateral.
    if (!ehFichaDeUsuario(content) || !content.characterPhotoUrl)
        return "";
    // Nome do personagem preenchido na ficha; sem nome, o título do arquivo.
    const nome = content.characterName || content.fileTitle || content.title;
    const editavel = podeTrocarFotoPersonagem(content);
    const corpo = `<img class="reader-character-photo-image" src="${escapeHtml(content.characterPhotoUrl)}" alt="Foto de ${escapeHtml(nome)}" />`;
    const acoes = editavel
        ? `<div class="reader-character-photo-actions"><button type="button" data-reader-action="foto-personagem">Trocar</button><button type="button" data-character-photo-remove>Remover</button></div>`
        : "";
    return `<aside class="reader-character-photo" data-character-photo aria-label="Foto de ${escapeHtml(nome)}">
      <span class="reader-character-photo-label" title="${escapeHtml(nome)}">${escapeHtml(nome)}</span>${corpo}${acoes}<p class="reader-character-photo-status" data-character-photo-status role="status" aria-live="polite"></p>
    </aside>`;
}
function aplicarFotoNoEstado(contentId, dados) {
    const listas = [state.contents, state.homeContents, state.readingNowContents].filter(Array.isArray);
    const alvos = [...listas.flatMap(lista => lista.filter(item => item?.id === contentId)), state.reader?.content?.id === contentId ? state.reader.content : null].filter(Boolean);
    for (const item of new Set(alvos)) {
        if (dados.characterPhotoUrl) {
            if (!item.characterPhotoUrl)
                item.pdfCoverUrl = item.coverUrl ?? null;
            Object.assign(item, { characterPhotoUrl: dados.characterPhotoUrl, coverUrl: dados.coverUrl });
        }
        else {
            item.coverUrl = item.pdfCoverUrl ?? item.coverUrl ?? null;
            delete item.characterPhotoUrl;
            delete item.pdfCoverUrl;
        }
    }
}
function redesenharFotoPersonagem() {
    const content = state.reader?.content;
    if (!content)
        return;
    const html = renderPainelFotoPersonagem(content);
    const painel = document.querySelector("[data-character-photo]");
    if (painel)
        painel.outerHTML = html;
    else if (html)
        document.querySelector(".reader-pdf-feedback")?.insertAdjacentHTML("afterend", html);
    const botao = document.querySelector(".reader-pdf-photo-button");
    if (botao) {
        const rotulo = content.characterPhotoUrl ? "Trocar foto do personagem" : "Adicionar foto do personagem";
        botao.title = rotulo;
        botao.setAttribute("aria-label", rotulo);
    }
    ajustarPainelFotoPersonagem();
}
async function enviarFotoPersonagem(metodo, arquivo) {
    const content = state.reader?.content;
    if (!podeTrocarFotoPersonagem(content))
        return;
    const status = () => document.querySelector("[data-character-photo-status]");
    document.querySelector("[data-character-photo]")?.classList.add("is-loading");
    if (status())
        status().textContent = metodo === "DELETE" ? "Removendo…" : "Enviando foto…";
    else
        mostrarFeedbackPdf("Enviando foto…");
    try {
        const resposta = await fetch(`/api/contents/${encodeURIComponent(content.id)}/foto-personagem`, {
            method: metodo,
            credentials: "same-origin",
            headers: arquivo ? { "Content-Type": arquivo.type || "application/octet-stream" } : {},
            body: arquivo ?? undefined
        });
        const dados = await resposta.json().catch(() => ({}));
        if (!resposta.ok)
            throw new Error(dados.error || "Não foi possível salvar a foto.");
        aplicarFotoNoEstado(content.id, dados);
        redesenharFotoPersonagem();
    }
    catch (erro) {
        document.querySelector("[data-character-photo]")?.classList.remove("is-loading");
        if (status())
            status().textContent = erro instanceof Error ? erro.message : "Não foi possível salvar a foto.";
        else
            alert(erro instanceof Error ? erro.message : "Não foi possível salvar a foto.");
    }
    finally {
        const feedback = document.querySelector(".reader-pdf-feedback");
        if (feedback?.textContent === "Enviando foto…")
            feedback.hidden = true;
    }
}
function escolherFotoPersonagem() {
    const entrada = document.createElement("input");
    entrada.type = "file";
    entrada.accept = "image/jpeg,image/png,image/webp,image/gif,image/avif";
    entrada.onchange = () => {
        const arquivo = entrada.files?.[0];
        if (!arquivo)
            return;
        if (arquivo.size > 12 * 1024 * 1024) {
            const status = document.querySelector("[data-character-photo-status]");
            if (status)
                status.textContent = "A imagem passa de 12 MB.";
            else
                alert("A imagem passa de 12 MB.");
            return;
        }
        void enviarFotoPersonagem("PUT", arquivo);
    };
    entrada.click();
}
document.addEventListener("click", event => {
    const alvo = event.target instanceof Element ? event.target : null;
    if (!alvo)
        return;
    if (alvo.closest('[data-reader-action="foto-personagem"]')) {
        event.preventDefault();
        event.stopPropagation();
        escolherFotoPersonagem();
        return;
    }
    if (alvo.closest("[data-character-photo-remove]")) {
        event.preventDefault();
        event.stopPropagation();
        if (confirm("Remover a foto do personagem?"))
            void enviarFotoPersonagem("DELETE");
        return;
    }
    const compacto = alvo.closest("[data-character-photo].is-compact");
    if (compacto) {
        event.stopPropagation();
        compacto.classList.toggle("is-expanded");
    }
}, true);
// Largura da área: o espaço livre à esquerda da página (muda com o zoom e a janela).
let observadorPaginaFoto = null;
let paginaObservadaFoto = null;
function ajustarPainelFotoPersonagem() {
    const painel = document.querySelector("[data-character-photo]");
    if (!painel)
        return;
    const pagina = document.querySelector(".reader-pdf-reader [data-pdf-page]");
    if (pagina && pagina !== paginaObservadaFoto && "ResizeObserver" in window) {
        observadorPaginaFoto?.disconnect();
        observadorPaginaFoto = new ResizeObserver(() => ajustarPainelFotoPersonagem());
        observadorPaginaFoto.observe(pagina);
        paginaObservadaFoto = pagina;
    }
    const livre = pagina ? pagina.getBoundingClientRect().left : 0;
    const largura = Math.min(290, Math.floor(livre - 40));
    const compacto = largura < 160;
    painel.classList.toggle("is-compact", compacto);
    if (!compacto) {
        painel.classList.remove("is-expanded");
        painel.style.setProperty("--foto-personagem-largura", `${largura}px`);
    }
}
let ajusteFotoAgendado = false;
new MutationObserver(() => {
    if (ajusteFotoAgendado || !document.querySelector("[data-character-photo]"))
        return;
    ajusteFotoAgendado = true;
    requestAnimationFrame(() => { ajusteFotoAgendado = false; ajustarPainelFotoPersonagem(); });
}).observe(document.body, { childList: true, subtree: true });
window.addEventListener("resize", () => ajustarPainelFotoPersonagem());
void boot();
bindReaderDelegatedEvents();
window.addEventListener("pugotiread:pdf-zoom-change", (event) => {
    if (!state.reader?.content.pageTypes.includes("pdf"))
        return;
    state.reader.zoom = event.detail.zoom;
    atualizarRotuloZoomPdf();
});
window.addEventListener("pugotiread:pdf-page-change", (event) => {
    if (!state.reader?.content.pageTypes.includes("pdf"))
        return;
    const page = Number(event.detail?.page);
    if (!Number.isInteger(page) || page < 1)
        return;
    state.reader.page = page - 1;
    syncReaderRoute();
    state.reader.content.pageCount = obterTotalPaginasPdf();
    scheduleReaderProgressSave(state.reader.content, page - 1);
    atualizarContadorAbsoluto();
    atualizarBotaoMarcadorPdf(page - 1);
});
window.addEventListener("pugotiread:epub-search-open", () => {
    if (state.reader?.content.pageTypes.includes("epub"))
        abrirPesquisaEpub();
});
window.addEventListener("keydown", (event) => {
    const normalizedKey = event.key.toLowerCase();
    const controlPressed = event.ctrlKey || event.metaKey;
    const alvoProtegido = alvoEditavelPdf(event.target);
    // Esc fecha primeiro a edição de nome, o nome do marcador ou a janela de páginas marcadas (antes de esconder os controles).
    if (state.reader && event.key === "Escape" && fecharJanelasMarcadoresPdf(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
    }
    if (state.reader && event.target instanceof Element && event.target.closest(".pdf-photo-backdrop"))
        return;
    if (state.reader) {
        const acao = resolverAtalhoLeitor(event, {
            leitorAtivo: true,
            leitorPdf: state.reader.content.pageTypes.includes("pdf"),
            leitorEpub: state.reader.content.pageTypes.includes("epub"),
            modoVerticalContinuo: state.reader.mode === "vertical-scroll",
            direcaoLeitura: state.reader.direction,
            alvoProtegido,
            pesquisaPdfAberta: pesquisaPdfAberta(),
            pesquisaEpubAberta: pesquisaEpubAberta(),
            telaCheia: isReaderFullscreen(),
            telaCheiaDisponivel: isReaderFullscreenAvailable(),
            controlesVisiveis: state.reader.controlsVisible
        });
        if (!acao || !executarAtalhoLeitor(acao))
            return;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
    }
    if (alvoProtegido && event.key !== "Escape")
        return;
    const searchShortcut = controlPressed
        && !event.altKey
        && (event.code === "KeyY" || normalizedKey === "y");
    const vaultUnlockShortcut = controlPressed
        && event.shiftKey
        && !event.altKey
        && (event.code === "Period"
            || normalizedKey === "."
            || normalizedKey === ">");
    const vaultLockShortcut = controlPressed
        && event.shiftKey
        && !event.altKey
        && (event.code === "Comma"
            || normalizedKey === ","
            || normalizedKey === "<");
    if (searchShortcut) {
        event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
        toggleGlobalSearch();
        return;
    }
    if (state.user?.role === "admin" && event.ctrlKey && event.shiftKey && event.code === "KeyL") {
        event.preventDefault();
        toggleVaultMenuVisibility();
        return;
    }
    if (state.user?.role === "admin" && vaultUnlockShortcut) {
        event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
        openPersonalVaultFromShortcut();
        return;
    }
    if (state.user?.role === "admin" && vaultLockShortcut) {
        event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
        void lockAndHidePersonalVaultFromShortcut();
        return;
    }
    if (event.key === "Escape" && !state.reader) {
        if (globalSearchOpen) {
            event.preventDefault();
            closeGlobalSearch();
            return;
        }
        const modalCloseButton = document.querySelector(".modal-backdrop [aria-label=\"Fechar\"]");
        if (modalCloseButton) {
            event.preventDefault();
            modalCloseButton.click();
            return;
        }
        if (state.accountMenuOpen || state.statsMenuOpen || state.vaultMenuOpen || state.openLibraryMenuId || state.openSeriesMenuId || state.mobileNavOpen) {
            event.preventDefault();
            closeNavigationPanels();
            closeMobileNavigation();
            renderNavigationMenus();
            return;
        }
    }
}, { capture: true });
function executarAtalhoLeitor(acao) {
    if (!state.reader)
        return false;
    const leitorPdf = state.reader.content.pageTypes.includes("pdf");
    const paginaAtual = leitorPdf ? obterPaginaAtualPdf() : state.reader.page + 1;
    const totalPaginas = leitorPdf ? obterTotalPaginasPdf() : state.reader.content.pageCount;
    switch (acao) {
        case "pagina-anterior":
            if (state.reader.content.pageTypes.includes("epub")) {
                advanceEpubPage(-1);
                return true;
            }
            if (paginaAtual <= 1)
                return false;
            if (leitorPdf)
                navegarRelativoPdf(-1);
            else
                pageStep(-1);
            return true;
        case "proxima-pagina":
            if (state.reader.content.pageTypes.includes("epub")) {
                advanceEpubPage(1);
                return true;
            }
            if (paginaAtual >= totalPaginas)
                return false;
            if (leitorPdf)
                navegarRelativoPdf(1);
            else
                pageStep(1);
            return true;
        case "topo-pagina":
            moverViewportDaPagina("start");
            return true;
        case "fim-pagina":
            moverViewportDaPagina("end");
            return true;
        case "primeira-pagina":
            if (paginaAtual <= 1)
                return false;
            if (leitorPdf)
                navegarParaPaginaPdf(1);
            else
                void setReaderPage(0);
            return true;
        case "ultima-pagina":
            if (paginaAtual >= totalPaginas)
                return false;
            if (leitorPdf)
                navegarParaPaginaPdf(totalPaginas);
            else
                void setReaderPage(totalPaginas - 1);
            return true;
        case "abrir-pesquisa-pdf":
            abrirPesquisaPdf();
            return true;
        case "fechar-pesquisa-pdf":
            fecharPesquisaPdf();
            return true;
        case "abrir-pesquisa-epub":
            abrirPesquisaEpub();
            return true;
        case "fechar-pesquisa-epub":
            fecharPesquisaEpub();
            return true;
        case "alternar-tela-cheia":
            void toggleReaderFullscreen();
            return true;
        case "sair-tela-cheia":
            void exitReaderFullscreen();
            return true;
        case "fechar-controles":
            state.reader.controlsVisible = false;
            renderReaderOverlay();
            return true;
        case "fechar-leitor":
            closeReader();
            return true;
        case "alternar-modo":
            state.reader.mode = state.reader.content.pageTypes.includes("epub")
                ? (state.reader.mode === "vertical-scroll" ? "horizontal" : "vertical-scroll")
                : getNextReaderMode(state.reader.mode);
            persistEpubAppearance();
            state.reader.controlsVisible = true;
            renderShell();
            if (state.reader?.mode === "vertical-scroll" && !state.reader.content.pageTypes.includes("epub"))
                requestAnimationFrame(() => scrollReaderToPage(state.reader?.page ?? 0));
            return true;
        case "alternar-controles":
            state.reader.controlsVisible = !state.reader.controlsVisible;
            renderReaderOverlay();
            return true;
        case "alternar-marcador":
            void handleReaderBookmark();
            return true;
        case "capitulo-anterior":
            void setReaderPage(getAdjacentChapterStartPage(state.reader.content, state.reader.page, -1));
            return true;
        case "proximo-capitulo":
            void setReaderPage(getAdjacentChapterStartPage(state.reader.content, state.reader.page, 1));
            return true;
        case "aumentar-zoom":
            setReaderZoom(state.reader.zoom + 25);
            return true;
        case "diminuir-zoom":
            setReaderZoom(state.reader.zoom - 25);
            return true;
        case "resetar-zoom":
            setReaderZoom(100);
            return true;
    }
    return false;
}
function pageStep(delta) {
    if (!state.reader)
        return;
    void setReaderPage(state.reader.page + delta);
}
function moverViewportDaPagina(posicao) {
    if (!state.reader)
        return;
    if (state.reader.content.pageTypes.includes("epub")) {
        const frame = document.querySelector(".reader-epub");
        const stage = document.getElementById("reader-stage");
        if (state.reader.mode === "vertical-scroll")
            stage?.scrollTo({ top: posicao === "start" ? 0 : stage.scrollHeight, behavior: "smooth" });
        else if (frame?.contentDocument) {
            const scrolling = frame.contentDocument.scrollingElement ?? frame.contentDocument.documentElement;
            const sign = state.reader.direction === "rtl" ? -1 : 1;
            scrolling.scrollTo({ left: posicao === "start" ? 0 : sign * scrolling.scrollWidth, behavior: "smooth" });
        }
        return;
    }
    if (state.reader.content.pageTypes.includes("pdf")) {
        const paginaPdf = document.querySelector(`[data-pdf-page="${obterPaginaAtualPdf()}"]`);
        if (paginaPdf) {
            paginaPdf.scrollIntoView({ block: posicao, behavior: "smooth" });
            return;
        }
    }
    const pagina = document.querySelector(`[data-reader-page-index="${state.reader.page}"]`);
    if (pagina) {
        pagina.scrollIntoView({ block: posicao, behavior: "smooth" });
        return;
    }
    const palco = document.querySelector("#reader-stage");
    palco?.scrollTo({ top: posicao === "start" ? 0 : palco.scrollHeight, behavior: "smooth" });
}
for (const eventName of ["fullscreenchange", "webkitfullscreenchange"]) {
    document.addEventListener(eventName, updateReaderFullscreenButton);
}
window.addEventListener("pugotiread:pdf-copy-saved", event => {
    const content = event.detail;
    if (content && content.libraryId === state.activeLibraryId) {
        state.contents = [...state.contents.filter(item => item.id !== content.id), content];
    }
});
