import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentId = "4:epub-fixture";
const user = { id: "tester", username: "tester", nickname: "Teste", displayName: "Teste", email: "test@example.test",
  avatarUrl: "", biography: "", location: "", favoriteContentIds: [], role: "user", allowedLibraryIds: ["4"],
  canLogin: true, canDownload: true, canChangePassword: true, passwordChangeRequiresEmailConfirmation: false, lastActiveAt: null };
const library = { id: "4", name: "Livros", kind: "book", path: "/fixture/books" };
const mangaLibrary = { id: "5", name: "Mangás", kind: "manga", path: "/fixture/manga" };
const manhwaLibrary = { id: "6", name: "Manhwas", kind: "manhwa", path: "/fixture/manhwa" };
const book = { id: contentId, libraryId: "4", title: "EPUB de teste", description: "", authors: [], releaseDate: null,
  rating: null, genres: [], pageCount: 2, chapterCount: 2, coverUrl: null, pageTypes: ["epub", "epub"],
  chapters: [{ name: "Capítulo 1", startPage: 0, pageCount: 1, isSpecial: false },
    { name: "Capítulo 2", startPage: 1, pageCount: 1, isSpecial: false }] };
const manga = { ...book, id: "5:manga-fixture", libraryId: "5", title: "Mangá de teste", pageTypes: ["image", "image"] };
const manhwa = { ...manga, id: "6:manhwa-fixture", libraryId: "6", title: "Manhwa de teste" };
async function assertAlignedFittingControls(page, context) {
  const positions = await page.locator(".reader-action-row .reader-action-btn").evaluateAll(buttons => buttons.map(button => {
    const icon = button.querySelector(".icon")?.getBoundingClientRect();
    const label = button.querySelector(".label")?.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    return { iconTop: icon?.top, labelTop: label?.top, buttonTop: box.top, centerX: box.left + box.width / 2 };
  }));
  assert.equal(positions.length, 3, `${context}: três botões de leitura devem estar presentes`);
  for (const key of ["buttonTop", "iconTop", "labelTop"]) {
    const values = positions.map(position => position[key]);
    assert.ok(Math.max(...values) - Math.min(...values) <= 1,
      `${context}: ${key} deve estar alinhado entre os botões: ${JSON.stringify(positions)}`);
  }
  const gaps = positions.slice(1).map((position, index) => position.centerX - positions[index].centerX);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1,
    `${context}: o espaçamento horizontal deve ser uniforme: ${JSON.stringify(gaps)}`);
}
let progress = { userId: "tester", contentId, currentPage: 0, epubOffset: 0, updatedAt: "2026-10-16" };
const readingDefaults = Object.fromEntries(["manga", "manhwa", "comic", "book", "lightNovel", "other"].map(kind => [kind, { mode: kind === "manhwa" ? "vertical-scroll" : "horizontal", fitting: kind === "manhwa" ? "width" : "height", direction: "ltr", controlsVisible: false }]));
const settings = { readingDefaults, vaultTimeoutMinutes: 15, startupLibraries: {} };
const savedBookmarks = [];
const responses = {
  "/api/me/reading-settings": { readingDefaults },
  "/api/admin/settings": { settings },
  "/api/admin/users": { users: [user], libraries: [library, mangaLibrary, manhwaLibrary] },
  "/api/admin/pdf-form-copies": { copies: [] },
  "/api/me": { user }, "/api/libraries": { libraries: [library, mangaLibrary, manhwaLibrary] }, "/api/bookmarks": { bookmarks: [], contents: [] },
  "/api/series-marks": { seriesMarks: [] }, "/api/user-lists": { wantToRead: [], readingList: [], collections: [], contents: [] },
  "/api/me/reviews": { reviews: [] }, "/api/reviews": { reviews: [] },
  "/api/libraries/4/contents": { contents: [book] },
  "/api/libraries/5/contents": { contents: [manga] },
  "/api/libraries/6/contents": { contents: [manhwa] },
  [`/api/contents/${contentId}/epub-metrics`]: { lengths: [1000, 9000] }
};

const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (pathname === "/api/bookmarks" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { contentId, page } = JSON.parse(body);
    const index = savedBookmarks.findIndex(mark => mark.contentId === contentId && mark.page === page);
    if (index >= 0) savedBookmarks.splice(index, 1);
    else savedBookmarks.push({ userId: user.id, contentId, page, createdAt: new Date().toISOString() });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ marked: index < 0 }));
    return;
  }
  if (pathname === "/api/bookmarks" && req.method === "GET") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ bookmarks: savedBookmarks, contents: [] }));
    return;
  }
  if (req.method === "PATCH" && pathname === "/api/admin/settings") {
    let body = "";
    for await (const chunk of req) body += chunk;
    Object.assign(readingDefaults, JSON.parse(body).readingDefaults);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ settings }));
    return;
  }
  if (req.method === "PUT" && pathname === "/api/progress") {
    let body = "";
    for await (const chunk of req) body += chunk;
    progress = { ...progress, ...JSON.parse(body) };
    res.writeHead(204).end();
    return;
  }
  if (pathname === "/api/continue") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ progress: [progress] }));
    return;
  }
  if (pathname.includes(contentId) && pathname.includes("/pages/")) {
    const text = "<p>Texto de teste com acentos: á é í ó ú. A última linha precisa continuar acessível após a paginação.</p>".repeat(120);
    res.setHeader("Content-Type", "text/html");
    // Um EPUB com CSS próprio que escondia conteúdo antes da correção.
    res.end(`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;overflow:hidden;padding:28px;font:20px/1.7 Georgia;background:#f8f5ee}</style></head><body><main class="pugotiread-epub-document">${text}</main></body></html>`);
    return;
  }
  if ((pathname.includes(manga.id) || pathname.includes(manhwa.id)) && pathname.includes("/pages/")) {
    res.setHeader("Content-Type", "image/svg+xml");
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="2400"><rect width="1600" height="2400" fill="white"/></svg>');
    return;
  }
  if (pathname.startsWith("/api/")) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(responses[pathname] ?? {}));
    return;
  }
  const file = pathname === "/" || pathname === "/config" || pathname.startsWith("/biblioteca/") ? "public/index.html"
    : pathname.startsWith("/UI/") || pathname.startsWith("/shared/") ? `dist${pathname}` : `public${pathname}`;
  const target = path.resolve(root, file);
  if (!target.startsWith(`${root}/`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404).end(); return;
  }
  res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".html") ? "text/html" : "application/octet-stream");
  res.end(fs.readFileSync(target));
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  async function checkImageBookmark(label) {
    const bookmark = page.locator('.reader-image-bookmark');
    await bookmark.waitFor({ state: 'visible' });
    const icon = () => bookmark.locator('svg').evaluate(svg => {
      const rect = svg.getBoundingClientRect();
      return { width: rect.width, height: rect.height, path: svg.querySelector('path').getAttribute('d'), fill: getComputedStyle(svg).fill };
    });
    assert.equal(await bookmark.getAttribute('aria-pressed'), 'false');
    const before = await icon();
    const saved = page.waitForResponse(response => response.url().includes('/api/bookmarks') && response.request().method() === 'GET');
    await bookmark.click();
    await page.waitForFunction(() => document.querySelector('.reader-image-bookmark')?.getAttribute('aria-pressed') === 'true');
    await saved;
    const marked = await icon();
    assert.deepEqual([marked.width, marked.height, marked.path], [before.width, before.height, before.path], `${label}: tamanho e desenho devem permanecer iguais`);
    assert.equal(before.fill, 'none');
    assert.equal(marked.fill, 'rgb(245, 197, 66)', `${label}: marcador deve ser amarelo`);
    await page.reload();
    await page.locator('#reader-stage').click({ position: { x: 195, y: 300 } });
    await bookmark.waitFor({ state: 'visible' });
    assert.equal(await bookmark.getAttribute('aria-pressed'), 'true', `${label}: marcador deve persistir`);
    const removed = page.waitForResponse(response => response.url().includes('/api/bookmarks') && response.request().method() === 'GET');
    await bookmark.click();
    await removed;
    assert.equal(await bookmark.getAttribute('aria-pressed'), 'false');
    assert.equal((await icon()).fill, 'none');
  }
  await page.addInitScript(() => localStorage.setItem("pugotiread-epub-appearance:tester", JSON.stringify({ mode: "vertical-scroll" })));
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.goto(`${origin}/biblioteca/4/titulo/${encodeURIComponent(contentId)}/ler?p=1`);
  await page.locator(".reader-epub").waitFor();
  assert.equal(await page.locator(".reader-epub").getAttribute("data-epub-mode"), "horizontal", "o padrão salvo no servidor prevalece sobre o modo antigo da aparência");
  const frame = page.frameLocator(".reader-epub");
  await frame.locator("main p:last-child").waitFor();
  await frame.locator("body").click({ position: { x: 400, y: 300 } });
  const epubView = page.locator('[data-reader-action="epub-view"]');
  assert.equal(await epubView.getAttribute("aria-label"), "Modo de leitura: Páginas. Mudar para rolagem");
  assert.equal(await epubView.locator("svg").getAttribute("data-epub-view-icon"), "pages");
  await page.waitForFunction(() => document.querySelector(".reader-epub")?.contentDocument?.documentElement.scrollWidth > 1000);
  if (process.env.PUGOTI_QA_SCREENSHOTS) await page.screenshot({ path: "/tmp/pugotiread-kindle-desktop.png" });
  const initial = await frame.locator("main").evaluate(main => ({
    width: main.ownerDocument.documentElement.scrollWidth,
    viewport: main.ownerDocument.documentElement.clientWidth,
    last: main.querySelector("p:last-child").getBoundingClientRect().left,
    overflow: getComputedStyle(main.ownerDocument.body).overflow
  }));
  assert.equal(initial.overflow, "visible");
  assert.ok(initial.width > initial.viewport * 2 && initial.last > initial.viewport, "o fim do EPUB deve caber em páginas alcançáveis");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForFunction(() => document.querySelector(".reader-epub")?.clientWidth >= 1800);
  await page.waitForFunction(() => {
    const main = document.querySelector(".reader-epub")?.contentDocument?.querySelector("main");
    if (!main) return false;
    const rect = main.getBoundingClientRect();
    return rect.width <= 760 && rect.left > 500 && rect.right < main.ownerDocument.documentElement.clientWidth - 500;
  });
  const wide = await frame.locator("main").evaluate(main => {
    const rect = main.getBoundingClientRect();
    return { left: rect.left, width: rect.width, viewport: main.ownerDocument.documentElement.clientWidth };
  });
  assert.ok(wide.width <= 760 && wide.left > 500 && wide.left + wide.width < wide.viewport - 500,
    "em tela larga, a coluna do livro deve ficar legível e centralizada");
  if (process.env.PUGOTI_QA_SCREENSHOTS) await page.screenshot({ path: "/tmp/pugotiread-epub-wide.png" });
  await page.setViewportSize({ width: 800, height: 600 });
  await page.waitForFunction(() => document.querySelector(".reader-epub")?.contentDocument?.querySelector("main")?.getBoundingClientRect().width <= 744);
  await frame.locator("body").click({ position: { x: 700, y: 300 } });
  await page.waitForFunction(() => document.querySelector(".reader-epub")?.contentDocument?.scrollingElement?.scrollLeft >= 700);
  await page.waitForFunction(() => Number(document.querySelector("[data-epub-progress]")?.textContent) > 0);
  assert.ok(Number(await page.locator("[data-epub-progress]").innerText()) > 0);
  await page.waitForTimeout(1400);
  assert.ok(progress.epubOffset > 0 && progress.epubOffset < 1, "posição interna precisa ser persistida");
  await page.reload();
  await page.locator(".reader-epub").waitFor();
  assert.equal(await page.locator(".reader-epub").getAttribute("data-epub-mode"), "horizontal", "reabrir o livro volta às páginas");
  await page.waitForFunction(() => Math.abs(document.querySelector(".reader-epub")?.contentDocument?.scrollingElement?.scrollLeft ?? 0) > 0);
  await page.frameLocator(".reader-epub").locator("body").click({ position: { x: 400, y: 300 } });
  await page.locator('[data-reader-action="epub-appearance"]').click();
  assert.equal(await page.locator('[data-epub-setting="font"]').count(), 1);
  await page.locator('[data-epub-setting="font"]').selectOption("sans");
  for (const [setting, value] of [["size", "30"], ["line", "2.1"], ["margin", "60"]]) {
    await page.locator(`[data-epub-setting="${setting}"]`).evaluate((el, value) => {
      el.value = value; el.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
  }
  const appearanceIcons = page.locator('.epub-appearance-actions svg');
  assert.equal(await appearanceIcons.count(), 2);
  for (const icon of await appearanceIcons.all()) {
    assert.equal(await icon.getAttribute("stroke-width"), "1.5");
    const box = await icon.boundingBox();
    assert.equal(box.width, 24); assert.equal(box.height, 24);
  }
  await page.getByRole("button", { name: "Fechar aparência", exact: true }).click();
  assert.equal(await page.locator('[aria-label="Aparência do livro"]').count(), 0);
  assert.equal(await page.locator('[data-reader-action="epub-appearance"]').getAttribute("aria-expanded"), "false");
  await page.locator('[data-reader-action="epub-appearance"]').click();
  assert.equal(await page.locator('[data-epub-setting="size"]').inputValue(), "30", "fechar preserva ajustes");
  await page.getByRole("button", { name: "Restaurar aparência padrão" }).click();
  for (const [setting, expected] of [["font", "serif"], ["size", "20"], ["line", "1.7"], ["margin", "28"]]) {
    assert.equal(await page.locator(`[data-epub-setting="${setting}"]`).inputValue(), expected);
  }
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("pugotiread-epub-appearance:tester")));
  assert.deepEqual([saved.font, saved.size, saved.line, saved.margin], ["serif", 20, 1.7, 28]);

  await frame.locator("body").evaluate(body => {
    const makeTouch = (identifier, x) => new Touch({ identifier, target: body, clientX: x, clientY: 200 });
    const fire = (type, touches, changedTouches) => body.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches, changedTouches }));
    const start = [makeTouch(1, 100), makeTouch(2, 200)];
    const spread = [makeTouch(1, 75), makeTouch(2, 225)];
    fire("touchstart", start, start);
    fire("touchmove", spread, spread);
    fire("touchend", [], spread);
  });
  assert.equal(await page.locator(".reader-zoom-value").innerText(), "150%");
  await page.locator('[data-reader-action="epub-view"]').click();
  await page.waitForFunction(() => document.querySelector(".reader-epub")?.dataset.epubMode === "vertical-scroll");
  assert.equal(await epubView.getAttribute("aria-label"), "Modo de leitura: Rolagem. Mudar para páginas");
  assert.equal(await epubView.locator("svg").getAttribute("data-epub-view-icon"), "scroll");
  await page.waitForFunction(() => (document.querySelector(".reader-epub")?.offsetHeight ?? 0) > 600);
  await page.reload();
  await page.waitForFunction(() => document.querySelector(".reader-epub")?.dataset.epubMode === "horizontal");
  assert.equal(await epubView.locator("svg").getAttribute("data-epub-view-icon"), "pages");
  if (process.env.PUGOTI_QA_SCREENSHOTS) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.locator(".reader-epub").waitFor();
    await page.screenshot({ path: "/tmp/pugotiread-kindle-mobile.png" });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/biblioteca/5/titulo/${encodeURIComponent(manga.id)}/ler?p=1`);
  const mangaMode = page.locator('[data-reader-action="toggle-mode"] .icon');

  await mangaMode.waitFor();
  assert.match(await mangaMode.textContent(), /view_carousel/);
  assert.equal(await page.locator('[data-reader-action="toggle-direction"]').count(), 0);
  await page.locator("#reader-stage").click({ position: { x: 195, y: 300 } });
  const mangaFullscreen = page.locator('[data-reader-action="fullscreen"]');
  assert.ok(await mangaFullscreen.isVisible(), "tela cheia deve aparecer no leitor de mangá");
  await checkImageBookmark('Mangá');
  const fullscreenBox = await mangaFullscreen.boundingBox();
  assert.ok(fullscreenBox && fullscreenBox.x >= 0 && fullscreenBox.x + fullscreenBox.width <= 390 && fullscreenBox.y + fullscreenBox.height <= 844, "botão de tela cheia deve caber na tela do tablet");
  const fittingMobileBox = await page.locator('[data-reader-action="toggle-fitting"]').boundingBox();
  assert.ok(fittingMobileBox && fittingMobileBox.x >= 0 && fittingMobileBox.x + fittingMobileBox.width <= 390 && fittingMobileBox.y + fittingMobileBox.height <= 844,
    "nome e ícone do ajuste devem caber na tela do tablet");
  await assertAlignedFittingControls(page, "tablet: Página inteira");
  if (process.env.PUGOTI_QA_SCREENSHOTS) await page.screenshot({ path: "/tmp/pugotiread-image-fitting-mobile.png" });
  await page.setViewportSize({ width: 800, height: 600 });
  const image = page.locator(".reader-image");
  await page.waitForFunction(() => document.querySelector(".reader-image")?.naturalWidth === 1600);
  const fitting = page.locator('[data-reader-action="toggle-fitting"]');
  const measureImage = async () => {
    await page.waitForFunction(() => { const img = document.querySelector("#reader-stage img"); return img && img.complete && img.naturalWidth > 0; });
    return image.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  };
  assert.equal(await fitting.locator(".label").innerText(), "Inteira");
  assert.match(await fitting.getAttribute("aria-label"), /Página inteira\. Mudar para Preencher largura/);
  assert.equal(await fitting.locator("svg").getAttribute("data-fitting-icon"), "height");
  const wholePage = await measureImage();
  await assertAlignedFittingControls(page, "desktop: Página inteira");
  assert.ok(Math.abs(wholePage.height - 600) < 2 && Math.abs(wholePage.width - 400) < 2,
    `Página inteira deve caber na tela sem deformação: ${JSON.stringify(wholePage)}`);
  const iconBox = await fitting.locator("svg").boundingBox();
  const labelBox = await fitting.locator(".label").boundingBox();
  assert.ok(iconBox && labelBox && labelBox.y >= iconBox.y + iconBox.height,
    "o nome do ajuste deve aparecer abaixo do ícone");
  await fitting.click();
  assert.equal(await fitting.locator(".label").innerText(), "Largura");
  assert.match(await fitting.getAttribute("aria-label"), /Preencher largura\. Mudar para Tamanho real/);
  assert.equal(await fitting.locator("svg").getAttribute("data-fitting-icon"), "width");
  await assertAlignedFittingControls(page, "desktop: Preencher largura");
  const filledWidth = await measureImage();
  assert.ok(Math.abs(filledWidth.width - 800) < 2 && Math.abs(filledWidth.height - 1200) < 2,
    `Preencher largura deve ocupar a tela sem deformação: ${JSON.stringify(filledWidth)}`);
  await fitting.click();
  assert.equal(await fitting.locator(".label").innerText(), "Real");
  assert.match(await fitting.getAttribute("aria-label"), /Tamanho real\. Mudar para Página inteira/);
  assert.equal(await fitting.locator("svg").getAttribute("data-fitting-icon"), "original");
  await assertAlignedFittingControls(page, "desktop: Tamanho real");
  const naturalSize = await measureImage();
  assert.ok(Math.abs(naturalSize.width - 1600) < 2 && Math.abs(naturalSize.height - 2400) < 2,
    `Tamanho real deve preservar os pixels originais: ${JSON.stringify(naturalSize)}`);
  await fitting.click();
  assert.equal(await fitting.locator(".label").innerText(), "Inteira");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-reader-action="toggle-mode"]').click();
  assert.match(await mangaMode.textContent(), /view_stream/);
  assert.equal(await page.locator('[data-reader-action="toggle-mode"] .label').innerText(), "Scroll");
  await page.locator('[data-reader-action="toggle-mode"]').click();
  assert.match(await mangaMode.textContent(), /view_carousel/);
  assert.equal(await page.locator('[data-reader-action="toggle-mode"] .label').innerText(), "Horizontal");
  if (await mangaFullscreen.isEnabled()) {
    await mangaFullscreen.click();
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    await mangaFullscreen.click();
    await page.waitForFunction(() => !document.fullscreenElement);
  }
  await page.goto(`${origin}/biblioteca/6/titulo/${encodeURIComponent(manhwa.id)}/ler?p=1`);
  await page.locator('[data-reader-action="fullscreen"]').waitFor();
  await page.locator("#reader-stage").click({ position: { x: 195, y: 300 } });
  assert.ok(await page.locator('[data-reader-action="fullscreen"]').isVisible(), "tela cheia deve aparecer no leitor de manhwa");
  await checkImageBookmark('Manhwa');
  // Admin saves text-reader defaults; a regular account must receive and use them.
  user.role = "admin";
  await page.setViewportSize({ width: 1159, height: 900 });
  await page.goto(`${origin}/config`);
  await page.locator('[data-server-section="reading"]').click();
  for (const kind of ["book", "lightNovel"]) {
    assert.deepEqual(await page.locator(`[name="${kind}.mode"] option`).allTextContents(), ["Páginas", "Rolagem"]);
    assert.equal(await page.locator(`[name="${kind}.fitting"]`).count(), 0);
  }
  assert.deepEqual(await page.locator('[name="manga.mode"] option').allTextContents(), ["Horizontal", "Scroll"]);
  for (const width of [1159, 800, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const widths = await page.locator('#reading-settings-form select').evaluateAll(selects => selects.map(select => {
      const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d');
      const css = getComputedStyle(select); ctx.font = css.font;
      const textWidth = Math.max(...Array.from(select.options, option => ctx.measureText(option.textContent).width));
      return { actual: select.clientWidth, needed: textWidth + parseFloat(css.paddingLeft) + parseFloat(css.paddingRight) + 22 };
    }));
    assert.ok(widths.every(w => w.actual >= w.needed), `opções sem cortes em ${width}px: ${JSON.stringify(widths)}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `sem transbordamento em ${width}px`);
  }
  await page.locator('[name="book.mode"]').selectOption('vertical-scroll');
  await page.locator('[name="book.controlsVisible"]').check();
  await page.locator('#reading-settings-form button[type="submit"]').click();
  await page.getByText('Configuração salva.', { exact: true }).waitFor();
  assert.equal(readingDefaults.book.mode, 'vertical-scroll');
  assert.equal(readingDefaults.book.fitting, 'height', 'campo oculto deve preservar ajuste de imagens/PDFs');
  user.role = "user";
  await page.goto(`${origin}/biblioteca/4/titulo/${encodeURIComponent(contentId)}/ler?p=1`);
  await page.locator('.reader-epub').waitFor();
  assert.equal(await page.locator('.reader-epub').getAttribute('data-epub-mode'), 'vertical-scroll');
  assert.equal(await page.locator(".reader-overlay.bottom").getAttribute("aria-hidden"), "false", "respeita controles visíveis para usuário comum");
  readingDefaults.book.mode = 'horizontal';
  readingDefaults.book.controlsVisible = false;
  await page.reload();
  await page.locator('.reader-epub').waitFor();
  assert.equal(await page.locator('.reader-epub').getAttribute('data-epub-mode'), 'horizontal');
  assert.equal(await page.locator(".reader-overlay.bottom").getAttribute("aria-hidden"), "true", "respeita controles ocultos");
  console.log('PASS PugotiQA: preferências de livros salvas, aplicadas para usuário comum e sem campos truncados');
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("PASS PugotiQA: os ajustes de imagem têm dimensões corretas, ícones alinhados e espaçamento uniforme");
} finally {
  await browser.close();
  server.close();
}
