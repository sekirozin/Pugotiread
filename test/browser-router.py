"""Real boot, History API and PDF/EPUB/image integration with isolated API data.
Run after npm run build with Python + Playwright + reportlab and Chromium.
Set ROUTER_TEST_LINUX_APP=1 to also exercise an isolated Chromium --app window.
"""
import functools
import http.server
import json
import os
import pathlib
import tempfile
import threading
import time
import urllib.parse

from playwright.sync_api import sync_playwright
from reportlab.pdfgen import canvas

ROOT = pathlib.Path(__file__).resolve().parents[1]
USER = dict(id="tester", username="tester", nickname="Teste", displayName="Teste", email="test@example.test",
            avatarUrl="", biography="", location="", favoriteContentIds=[], role="user", allowedLibraryIds=["4", "5", "6"],
            canLogin=True, canDownload=True, canChangePassword=True, passwordChangeRequiresEmailConfirmation=False, lastActiveAt=None)
LIBRARIES = [dict(id="4", name="RPG", kind="other", path="/fixture/rpg"),
             dict(id="5", name="Quadrinhos", kind="comic", path="/fixture/comics"),
             dict(id="6", name="Biblioteca lenta", kind="other", path="/fixture/slow")]


def content(id, library, title, types, count):
    return dict(id=id, libraryId=library, title=title, description="Livro de teste", authors=[], releaseDate=None,
                rating=None, genres=[], pageCount=count, chapterCount=1, coverUrl=None, pageTypes=types,
                chapters=[dict(name="Capítulo 1", startPage=0, pageCount=count, isSpecial=False)])


PDF = content("152", "4", "PDF de teste", ["pdf"], 60)
EPUB = content("4:livro com espaço", "4", "EPUB de teste", ["epub"] * 3, 3)
COMIC = content("comic", "5", "Quadrinho de teste", ["image"] * 60, 60)

with tempfile.TemporaryDirectory() as temporary:
    directory = pathlib.Path(temporary)
    pdf = canvas.Canvas(str(directory / "sample.pdf"))
    for page_number in range(60):
        pdf.drawString(50, 700, f"PDF fixture page {page_number + 1}")
        pdf.showPage()
    pdf.save()
    for name, target in [("styles.css", ROOT / "public/styles.css"), ("pdfjs", ROOT / "public/pdfjs"),
                         ("UI", ROOT / "dist/UI"), ("shared", ROOT / "dist/shared")]:
        (directory / name).symlink_to(target)
    # Keep the real boot; expose state only to assert state/URL agreement.
    app_code = (ROOT / "dist/UI/Web/app.js").read_text().replace(
        "void boot();", "window.testApp = { state, openView, loadLibrary, setReaderPage, openReaderAtProgress }; void boot();")
    index = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><div id="app"></div><script type="module" src="/UI/Web/app.js"></script>'

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, value, mime="application/json", status=200):
            body = json.dumps(value).encode() if mime == "application/json" else value.encode()
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass  # Navigation intentionally aborts pending fixture requests.

        def do_PUT(self):
            data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            if self.path == "/api/progress":
                self.server.progress[data["contentId"]] = dict(userId="tester", contentId=data["contentId"], currentPage=data["currentPage"], updatedAt="2026-09-08")
            self.send({})

        def do_GET(self):
            path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
            if path == "/UI/Web/app.js":
                self.send(app_code, "text/javascript"); return
            if path.startswith("/api/contents/") and "/pages/" in path:
                if "/152/" in path:
                    self.path = "/sample.pdf"; return super().do_GET()
                if "/4:livro com espaço/" in path:
                    self.send("<!doctype html><body><h1>Capítulo EPUB</h1><p>Texto de teste</p></body>", "text/html"); return
                self.send('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="white"/><text x="30" y="60">Quadrinho</text></svg>', "image/svg+xml"); return
            if path.startswith("/api/"):
                if path == "/api/libraries/6/contents": time.sleep(1)
                responses = {
                    "/api/me": {"user": USER}, "/api/libraries": {"libraries": LIBRARIES},
                    "/api/continue": {"progress": list(self.server.progress.values())},
                    "/api/bookmarks": {"bookmarks": [], "contents": []}, "/api/series-marks": {"seriesMarks": []},
                    "/api/user-lists": {"wantToRead": [], "readingList": [], "collections": [], "contents": []},
                    "/api/me/reviews": {"reviews": []}, "/api/reviews": {"reviews": []},
                    "/api/users": {"users": [USER, dict(USER, id="other", nickname="Outra pessoa", reviewCount=0)]},
                    "/api/libraries/4/contents": {"contents": [PDF, EPUB]}, "/api/libraries/5/contents": {"contents": [COMIC]},
                    "/api/libraries/6/contents": {"contents": []},
                    "/api/invites/test": {"invitation": dict(email="test@example.test", displayName="Convidado", username="", role="user", usedAt=None)},
                }
                self.send(responses.get(path, {})); return
            if not pathlib.Path(path).suffix:
                self.send(index, "text/html"); return
            super().do_GET()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(directory)))
    server.progress = {}
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"

    def path_is(page, path):
        page.wait_for_function("path => location.pathname + location.search === path", arg=path, timeout=10000)

    def view_is(page, view):
        page.wait_for_function("view => window.testApp?.state.activeView === view && !testApp.state.reader && !testApp.state.activeSeriesId && !!document.querySelector('.app-shell')", arg=view)

    def reader_is(page, id, number):
        page.wait_for_function("([id, number]) => window.testApp?.state.reader?.content.id === id && testApp.state.reader.page === number - 1", arg=[id, number])

    def navigate_sidebar(page, selector):
        if page.viewport_size and page.viewport_size["width"] < 700:
            page.locator("#menu-button").click()
            page.wait_for_function("testApp.state.mobileNavOpen")
        page.locator(selector).click()

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        modes = os.environ.get("ROUTER_TEST_MODES", "desktop,mobile" + (",linux-app" if os.environ.get("ROUTER_TEST_LINUX_APP") else "")).split(",")
        for mode in modes:
            server.progress.clear()
            if mode == "linux-app":
                context = playwright.chromium.launch_persistent_context(str(directory / "linux-profile"),
                    executable_path="/usr/bin/chromium", headless=False, no_viewport=True,
                    args=["--no-sandbox", f"--app={origin}", "--window-size=1280,844"])
                page = context.pages[0]
            else:
                context = browser.new_context(viewport={"width": 390 if mode == "mobile" else 1280, "height": 844},
                                              is_mobile=mode == "mobile", has_touch=mode == "mobile")
                page = context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(origin)
            view_is(page, "home")
            page.evaluate("() => {window.historyWrites=[]; for(const name of ['pushState','replaceState']){const original=history[name].bind(history);history[name]=(...args)=>{historyWrites.push(name);return original(...args)}}}")
            navigate_sidebar(page, '[data-library-id="4"]')
            path_is(page, "/biblioteca/4")
            page.locator('[data-series-open="152"]').first.press("Enter")
            path_is(page, "/biblioteca/4/titulo/152")
            page.locator('[data-series-continue="152"]').click()
            reader_is(page, "152", 1)
            page.wait_for_selector('[data-pdf-page="1"] canvas')
            page_input = page.locator("[data-pdf-page-input]")
            for number in range(2, 51):
                page_input.fill(str(number)); page_input.press("Enter")
                path_is(page, f"/biblioteca/4/titulo/152/ler?p={number}")
            assert page.evaluate("historyWrites.filter(x=>x==='pushState').length") == 3
            before_back = page.evaluate("historyWrites.length")
            page.go_back(); path_is(page, "/biblioteca/4/titulo/152")
            page.wait_for_selector('[data-series-continue="152"]')
            page.go_back(); path_is(page, "/biblioteca/4"); view_is(page, "library")
            page.go_back(); path_is(page, "/"); view_is(page, "home")
            page.go_forward(); path_is(page, "/biblioteca/4")
            page.go_forward(); path_is(page, "/biblioteca/4/titulo/152")
            page.go_forward(); reader_is(page, "152", 50)
            page.wait_for_selector('[data-pdf-page="50"] canvas')
            assert page.evaluate("historyWrites.length") == before_back
            page.reload(); reader_is(page, "152", 50)
            page.wait_for_selector('[data-pdf-page="50"] canvas')
            path_is(page, "/biblioteca/4/titulo/152/ler?p=50")

            # Fresh documents do not rely on cached title/library data.
            for path, kind in [("/biblioteca/4", "library"), ("/biblioteca/4/titulo/152", "title"),
                               ("/biblioteca/4/titulo/152/ler?p=18", "reader")]:
                page.goto(origin + path)
                if kind == "reader": reader_is(page, "152", 18)
                elif kind == "title": page.wait_for_selector('[data-series-continue="152"]')
                else: view_is(page, "library")
                path_is(page, path)

            page.goto(origin)
            for view, path in [("want", "/lendo-agora"), ("collections", "/colecoes"), ("lists", "/listas"),
                               ("bookmarks", "/marcadores"), ("all", "/titulos"), ("people", "/pessoas")]:
                view_is(page, "home" if view == "want" else previous)
                navigate_sidebar(page, f'[data-nav-view="{view}"]')
                path_is(page, path); view_is(page, view)
                page.reload(); path_is(page, path); view_is(page, view)
                previous = view
            page.locator('[data-open-person="other"]').click()
            path_is(page, "/pessoas/other"); page.reload()
            page.wait_for_selector("#back-to-people")
            page.locator("#back-to-people").click(); path_is(page, "/pessoas")
            page.locator("#settings-button").click(); path_is(page, "/config")
            page.reload(); view_is(page, "settings")
            page.locator("#account-button").click()
            page.locator("#profile-button").click()
            path_is(page, "/perfil"); view_is(page, "profile"); page.reload(); view_is(page, "profile")

            # Unknown IDs, wrong library membership, invalid syntax and page bounds.
            for path, fallback in [("/nonsense", "/"), ("/biblioteca/missing", "/"),
                                   ("/biblioteca/4/titulo/missing", "/biblioteca/4"),
                                   ("/biblioteca/5/titulo/152", "/biblioteca/5"),
                                   ("/biblioteca/%ZZ", "/"), ("/pessoas/missing", "/pessoas"), ("/cofre", "/")]:
                page.goto(origin + path); path_is(page, fallback)
                page.wait_for_selector(".app-shell")
            page.goto(origin + "/biblioteca/4/titulo/152/ler?p=9999")
            page.wait_for_selector('[data-pdf-page="60"] canvas')
            reader_is(page, "152", 60); path_is(page, "/biblioteca/4/titulo/152/ler?p=60")
            page.goto(origin + "/biblioteca/4/titulo/152/ler?p=-1")
            reader_is(page, "152", 1); path_is(page, "/biblioteca/4/titulo/152/ler?p=1")

            # Image and EPUB changes share page replacement, not just PDF events.
            for id, url, start in [("comic", "/biblioteca/5/titulo/comic/ler?p=18", 18),
                                   (EPUB["id"], "/biblioteca/4/titulo/4%3Alivro%20com%20espa%C3%A7o/ler?p=2", 2)]:
                page.goto(origin + url); reader_is(page, id, start)
                count = page.evaluate("history.length")
                page.evaluate("testApp.setReaderPage(2)")
                reader_is(page, id, 3)
                page.wait_for_function("location.search === '?p=3'")
                assert page.evaluate("history.length") == count
                page.reload(); reader_is(page, id, 3)

            # A slow library response must not overwrite a later screen.
            page.goto(origin); view_is(page, "home")
            page.evaluate("void testApp.loadLibrary('6')")
            path_is(page, "/biblioteca/6")
            page.evaluate("testApp.openView('people')")
            page.wait_for_timeout(1300)
            path_is(page, "/pessoas"); view_is(page, "people")
            assert page.evaluate("testApp.state.activeLibraryId") is None
            page.goto(origin + "/reset-password/test"); page.wait_for_selector("#password-reset-form")
            path_is(page, "/reset-password/test")
            page.locator("#back-to-login-from-reset").click(); path_is(page, "/")
            page.goto(origin + "/invite/test"); page.wait_for_selector("#invite-form")
            path_is(page, "/invite/test")
            page.route("**/api/invites/test", lambda route: route.fulfill(json={"user": USER}))
            page.locator("#open-invite-create-account").click()
            page.locator('#invite-create-form [name="nickname"]').fill("Teste")
            assert page.locator('#invite-create-form [name="email"]').input_value() == "test@example.test"
            page.locator('#invite-create-form [name="password"]').fill("fixture-password-only")
            page.locator('#invite-create-form [type="submit"]').click()
            path_is(page, "/"); view_is(page, "home")
            page.unroute("**/api/invites/test")

            # Preserve the complete deep link through the existing SSO return URL.
            page.route("**/api/me", lambda route: route.fulfill(status=401, json={"error": "Sessão expirada"}))
            page.route("**/api/auth/pugotilab/config", lambda route: route.fulfill(json={"authUrl": origin + "/sso-fixture"}))
            page.route("**/sso-fixture?**", lambda route: route.fulfill(content_type="text/html", body="Login fixture"))
            deep_link = origin + "/biblioteca/4/titulo/152/ler?p=18"
            page.goto(deep_link)
            page.wait_for_url("**/sso-fixture?**")
            assert urllib.parse.parse_qs(urllib.parse.urlparse(page.url).query)["return"] == [deep_link]
            page.unroute("**/api/me")
            page.unroute("**/api/auth/pugotilab/config")
            page.goto(deep_link); reader_is(page, "152", 18)
            # A saved startup library applies only to a fresh root boot.
            page.route("**/api/me/startup", lambda route: route.fulfill(json={"libraryId": "4"}))
            page.goto(origin); path_is(page, "/biblioteca/4"); view_is(page, "library")
            page.evaluate("testApp.openView('home')"); path_is(page, "/"); view_is(page, "home")
            page.go_back(); path_is(page, "/biblioteca/4")
            page.goto(deep_link); reader_is(page, "152", 18)
            page.reload(); reader_is(page, "152", 18)
            page.goto(origin + "/colecoes"); view_is(page, "collections")
            page.locator('#home-button').click(); path_is(page, "/biblioteca/4"); view_is(page, "library")
            page.go_back(); view_is(page, "collections")
            navigate_sidebar(page, '[data-nav-view="home"]'); path_is(page, "/biblioteca/4"); view_is(page, "library")
            page.go_back(); view_is(page, "collections")
            page.unroute("**/api/me/startup")
            page.route("**/api/me/startup", lambda route: route.fulfill(json={"libraryId": None}))
            page.locator('#home-button').click(); path_is(page, "/"); view_is(page, "home")
            page.goto(origin + "/colecoes"); view_is(page, "collections")
            navigate_sidebar(page, '[data-nav-view="home"]'); path_is(page, "/"); view_is(page, "home")
            page.unroute("**/api/me/startup")
            admin = dict(USER, role="admin")
            saved = {}
            page.route("**/api/me", lambda route: route.fulfill(json={"user": admin}))
            page.route("**/api/admin/users", lambda route: route.fulfill(json={"users": [admin, dict(USER, id="second", username="kenzo", allowedLibraryIds=["5"])], "libraries": LIBRARIES}))
            def settings_response(route):
                if route.request.method == "PATCH":
                    saved.update(route.request.post_data_json["startupLibraries"])
                route.fulfill(json={"settings": {"startupLibraries": saved, "vaultTimeoutMinutes": 5, "readingDefaults": {}}})
            page.route("**/api/admin/settings", settings_response)
            page.goto(origin + "/config"); view_is(page, "settings")
            page.evaluate("() => { testApp.state.settingsSection='server'; testApp.state.serverSection='libraries'; testApp.openView('settings'); }")
            dropdown = page.locator('[data-startup-user="tester"]')
            dropdown.select_option("4")
            page.get_by_text("Salvo", exact=True).wait_for()
            assert saved == {"tester": "4"}
            page.reload(); view_is(page, "settings")
            page.evaluate("() => { testApp.state.settingsSection='server'; testApp.state.serverSection='libraries'; testApp.openView('settings'); }")
            assert dropdown.input_value() == "4"
            page.locator('#startup-user-select').select_option("second")
            second = page.locator('[data-startup-user="second"]')
            assert second.locator('option').count() == 2
            second.select_option("5")
            page.get_by_text("Salvo", exact=True).wait_for()
            page.locator('#startup-user-select').select_option("tester")
            assert dropdown.input_value() == "4"
            assert saved == {"tester": "4", "second": "5"}
            assert not errors, errors
            print(f"PASS {mode}: boot, views, history x50, Back/Forward, refresh, deep links, IDs, PDF/EPUB/images, stale navigation, reset/invite/SSO", flush=True)
            context.close()
        browser.close()
    server.shutdown()
