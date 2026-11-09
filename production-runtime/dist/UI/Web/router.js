export const viewPaths = {
    home: "/", want: "/lendo-agora", collections: "/colecoes", lists: "/listas",
    bookmarks: "/marcadores", all: "/titulos", people: "/pessoas",
    profile: "/reviews", settings: "/config", vault: "/cofre"
};
function validId(id) {
    return id.length > 0 && id !== "." && id !== ".." && !/[\u0000-\u001f\u007f/\\]/u.test(id);
}
export function parseRoute(input) {
    try {
        const url = new URL(input, "http://router.local");
        // Authentication endpoints belong to the existing boot/server flows.
        if (/^\/(?:reset-password|invite|oauth|auth|api)(?:\/|$)/.test(url.pathname))
            return { kind: "external" };
        const path = url.pathname.replace(/\/+$/, "") || "/";
        // O perfil agora é o Pugoti Profile (pugotilab.com/auth/profile); o /perfil antigo abre "Minhas Reviews".
        if (path === "/perfil")
            return { kind: "view", view: "profile" };
        for (const [view, value] of Object.entries(viewPaths)) {
            if (path === value)
                return { kind: "view", view: view };
        }
        const parts = path.split("/").slice(1).map(decodeURIComponent);
        if (parts[0] === "pessoas" && parts.length === 2 && validId(parts[1]))
            return { kind: "person", userId: parts[1] };
        if (parts[0] !== "biblioteca" || !validId(parts[1] ?? ""))
            return { kind: "invalid" };
        const libraryId = parts[1];
        if (parts.length === 2) {
            const folder = url.searchParams.get('pasta');
            if (folder && (folder.length > 1024 || !folder.split('/').every(validId)))
                return { kind: 'invalid' };
            return { kind: "library", libraryId, ...(folder ? { folder } : {}) };
        }
        if (parts[2] !== "titulo" || !validId(parts[3] ?? ""))
            return { kind: "invalid" };
        const contentId = parts[3];
        if (parts.length === 4)
            return { kind: "title", libraryId, contentId };
        if (parts.length === 5 && parts[4] === "ler") {
            const value = url.searchParams.get("p") ?? "1";
            const page = /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 1;
            return { kind: "reader", libraryId, contentId, page };
        }
    }
    catch { /* Malformed URI sequences are invalid routes, never boot errors. */ }
    return { kind: "invalid" };
}
export function buildRoute(route) {
    const id = (value) => {
        if (!validId(value))
            throw new Error("Identificador de rota inválido.");
        return encodeURIComponent(value);
    };
    if (route.kind === "view")
        return viewPaths[route.view];
    if (route.kind === "person")
        return `/pessoas/${id(route.userId)}`;
    const library = `/biblioteca/${id(route.libraryId)}`;
    if (route.kind === "library") {
        if (route.folder && (route.folder.length > 1024 || !route.folder.split('/').every(validId)))
            throw new Error('Pasta inválida.');
        return library + (route.folder ? `?pasta=${encodeURIComponent(route.folder)}` : '');
    }
    const title = `${library}/titulo/${id(route.contentId)}`;
    if (route.kind === "title")
        return title;
    const page = Number.isSafeInteger(route.page) && route.page > 0 ? route.page : 1;
    return `${title}/ler?p=${page}`;
}
export function applyRouteToState(state, route) {
    state.activeView = route.kind === "view" ? route.view : route.kind === "person" ? "people" : "library";
    state.activeLibraryId = "libraryId" in route ? route.libraryId : null;
    state.activeLibraryFolder = route.kind === 'library' ? route.folder ?? '' : '';
    state.activeSeriesId = "contentId" in route ? route.contentId : null;
    state.activePeopleUserId = route.kind === "person" ? route.userId : null;
    state.reader = null;
}
/** The only owner of History API writes. Page replacement does not re-open the reader. */
export function createRouter(browser, apply) {
    let revision = 0;
    let started = false;
    const currentPath = () => browser.location.pathname + browser.location.search + browser.location.hash;
    function write(route, replace) {
        const path = buildRoute(route);
        if (currentPath() === path)
            return;
        const previousPath = replace ? browser.history.state?.previousPath : currentPath();
        browser.history[replace ? "replaceState" : "pushState"]({ pugotiread: true, previousPath }, "", path);
    }
    function run(route) {
        const request = ++revision;
        return Promise.resolve(apply(route, { isCurrent: () => request === revision }));
    }
    function restore() {
        const parsed = parseRoute(browser.location.href);
        if (parsed.kind === "external") {
            ++revision;
            return Promise.resolve();
        }
        const route = parsed.kind === "invalid" ? { kind: "view", view: "home" } : parsed;
        write(route, true);
        return run(route);
    }
    const popstate = () => { void restore(); };
    return {
        start(initialRoute) {
            if (!started) {
                if (initialRoute && currentPath() === "/")
                    write(initialRoute, true);
                browser.addEventListener("popstate", popstate);
                started = true;
            }
            return restore();
        },
        navigate(route) {
            if (currentPath() === buildRoute(route))
                return run(route);
            // A direct "continue reading" action still has a title to return to.
            // Boot/popstate never insert ancestors or create new history entries.
            if (route.kind === "reader")
                write({ ...route, kind: "title" }, false);
            write(route, false);
            return run(route);
        },
        replaceRoute(route, applyState = true) {
            write(route, true);
            return applyState ? run(route) : Promise.resolve();
        },
        backTo(route) {
            if (browser.history.state?.pugotiread && browser.history.state.previousPath === buildRoute(route))
                browser.history.back();
            else
                void this.navigate(route);
        },
        dispose() { browser.removeEventListener("popstate", popstate); started = false; ++revision; }
    };
}
