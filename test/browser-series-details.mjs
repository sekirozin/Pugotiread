import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { renderPdfDetails } from "../dist/UI/Web/views/pdf-details.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.match(fs.readFileSync(path.join(root, "public/index.html"), "utf8"), /app\.js\?v=search-modal-20261021/, "a versão do script deve invalidar o cache anterior");
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
assert.match(renderPdfDetails({...book, pageTypes: ['pdf']}, library, null, false, '', 0), /Autor\(es\): N\/A/,
  'PDF sem autor deve apresentar N/A');
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
 const page = await browser.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 manga.chapters = manga.chapters.map(chapter=>({...chapter,addedAt:new Date().toISOString()}));
 manga.description = ('Uma sinopse completa, com acentos e vários parágrafos.\n').repeat(20);
 manga.authors = ['Autor de teste']; manga.artists = ['Artista de teste'];
 manga.rating = '4.8/5'; manga.publicationStatus = 'Completo'; manga.pageCount = 120; manga.chapterCount = 2;
 responses['/api/reviews'] = { reviews: [{ userId:'tester', displayName:'Teste', role:'user', rating:8, comment:'Muito bom', contentId:manga.id, createdAt:'2026-10-20' }] };
 await page.setViewportSize({width: 1280, height: 900});
 await page.goto(`${origin}/biblioteca/5/titulo/${encodeURIComponent(manga.id)}`);
 await page.locator('#search-button').click();
 const searchDialog = page.locator('.global-search-panel');
 const searchInput = page.locator('#global-search-input');
 await searchDialog.waitFor();
 assert.ok(await searchInput.evaluate(input => input === document.activeElement), 'a busca deve receber foco ao abrir');
 assert.equal(await searchDialog.getByText(/digite pelo menos/i).count(), 0, 'não deve exibir instrução de quantidade mínima');
 assert.ok(await page.locator('.global-search-backdrop').evaluate(element => getComputedStyle(element).backdropFilter !== 'none'));
 await searchInput.fill('Artista de teste');
 await page.getByRole('button', { name: /Mangá de teste/ }).waitFor();
 assert.match(await page.locator('.global-search-result').innerText(), /Autor de teste.*Artista de teste/s, 'busca deve considerar e exibir autores e artistas');
 await searchInput.fill('EPUB de teste');
 await page.getByRole('button', { name: /EPUB de teste/ }).waitFor();
 await page.keyboard.press('Escape');
 assert.equal(await searchDialog.count(), 0, 'Esc deve fechar a busca');
 await page.keyboard.press('Control+y');
 await searchDialog.waitFor();
 await page.locator('.global-search-backdrop').click({ position: { x: 5, y: 5 } });
 assert.equal(await searchDialog.count(), 0, 'clicar fora deve fechar a busca');
 await page.setViewportSize({width: 390, height: 800});
 await page.locator('#search-button').click();
 await searchInput.fill('Mangá de teste');
 await page.locator('.global-search-result').click();
 await page.locator('.series-description-card').waitFor();
 assert.equal(await searchDialog.count(), 0, 'abrir o resultado deve fechar a busca');
 assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'a busca deve caber no celular');
 for (const width of [1280,800,390]) {
  await page.setViewportSize({width,height:900});
  await page.goto(`${origin}/biblioteca/5/titulo/${encodeURIComponent(manga.id)}`);
  await page.locator('.series-description-card').waitFor();
  assert.equal(await page.locator('.series-description').innerText(),manga.description.trim());
  assert.ok(await page.locator('.series-description').evaluate(e=>e.scrollHeight<=e.clientHeight+1),'sinopse completa sem corte');
  assert.equal(await page.locator('.publication-completed').textContent(),'Finalizada');
  assert.ok(await page.locator('.series-rating-display').innerText().then(t=>t.includes('4.8') && t.includes('/5')));
  await page.waitForFunction(()=>document.querySelector('.personal-rating-display')?.textContent.includes('8.0'));
  const actionCopy=(await page.locator('.series-detail-actions').innerText()).replace(/\s+/g,' ').trim();
  assert.match(actionCopy,/Ler primeiro[\s\S]*Favoritar[\s\S]*Sem progresso[\s\S]*2 capítulos[\s\S]*120 páginas/);
  assert.equal((await page.locator('.series-creator-grid').innerText()).replace(/\s+/g,' ').trim(), 'Autor(es): Autor de teste Artista(s): Artista de teste');
  if (width === 1280) {
   const layout = await page.evaluate(() => {
    const cover=document.querySelector('.series-detail-image,.series-detail-placeholder').getBoundingClientRect();
    const synopsis=document.querySelector('.series-description-card').getBoundingClientRect();
    const stats=[...document.querySelectorAll('.series-stat-card')].map(card=>card.getBoundingClientRect().height);
    const actions=[...document.querySelectorAll('.series-detail-actions > *')].map(item=>item.getBoundingClientRect());
    const info=document.querySelector('.series-detail-info').getBoundingClientRect();
    return {cover,info,synopsis,stats,actionTops:actions.map(item=>item.top),actionRights:actions.map(item=>item.right)};
   });
   assert.ok(Math.abs(layout.cover.top-layout.info.top)<=1 && Math.abs(layout.cover.bottom-layout.info.bottom)<=1,
    `capa e informações devem terminar perfeitamente alinhadas: ${JSON.stringify({cover:layout.cover,info:layout.info})}`);
   assert.ok(layout.synopsis.left <= layout.cover.left + 1 && layout.synopsis.right >= layout.cover.right,
    `sinopse deve ocupar também a coluna da capa: ${JSON.stringify(layout)}`);
   assert.ok(layout.stats.every(height => height <= 100), `cards superiores compactos: ${layout.stats}`);
   assert.ok(Math.max(...layout.actionTops)-Math.min(...layout.actionTops)<=1 && layout.actionRights.at(-1)<=layout.synopsis.right+1,
    `ações, capítulos e páginas na mesma linha: ${JSON.stringify(layout.actionTops)}`);
  }
  const overflow = await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,elements:[...document.querySelectorAll('.series-detail *')].filter(e=>e.getBoundingClientRect().right>innerWidth).map(e=>({cls:e.className,tag:e.tagName,text:e.textContent.slice(0,100),parent:e.parentElement.className,right:e.getBoundingClientRect().right})).slice(0,12)}));
  assert.ok(overflow.scroll<=width,JSON.stringify(overflow));
 }
 // Obras com e sem gêneros/artista devem manter os cards nas mesmas posições.
 await page.setViewportSize({width: 1500, height: 900});
 const measure = () => page.evaluate(() => {
  const cover = document.querySelector('.series-detail-image,.series-detail-placeholder').getBoundingClientRect();
  const selectors = ['.series-detail-stats', '.series-detail-actions', '.series-creator-grid'];
  return {coverBottom: cover.bottom, boxes: selectors.flatMap(selector => [...document.querySelector(selector).children].map(element => {
   const box = element.getBoundingClientRect();
   return {top: box.top, bottom: box.bottom, width: box.width, height: box.height};
  }))};
 });
 manga.genres = ['Ação', 'Artes Marciais', 'Aventura', 'Drama', 'Fantasia', 'Manhwa'];
 await page.goto(`${origin}/biblioteca/5/titulo/${encodeURIComponent(manga.id)}`);
 await page.locator('.series-genre-row span').first().waitFor();
 const withCredits = await measure();
 manga.genres = []; manga.artists = []; manga.authors = [];
 await page.goto(`${origin}/biblioteca/5/titulo/${encodeURIComponent(manga.id)}`);
 await page.locator('.series-creator-grid').waitFor();
 assert.match(await page.locator('.series-creator-grid').innerText(), /Artista\(s\):\s*N\/A/);
 assert.match(await page.locator('.series-creator-grid').innerText(), /Autor\(es\):\s*N\/A/);
 const withoutCredits = await measure();
 assert.equal(withCredits.boxes.length, withoutCredits.boxes.length);
 for (let i=0; i<withCredits.boxes.length; i++) for (const key of ['top','bottom','width','height']) {
  assert.ok(Math.abs(withCredits.boxes[i][key]-withoutCredits.boxes[i][key])<=1,
   `card ${i} deve preservar ${key}: ${JSON.stringify({withCredits,withoutCredits})}`);
 }
 assert.ok(Math.abs(withCredits.boxes.at(-1).bottom-withCredits.coverBottom)<=1,
  'a última linha de créditos deve terminar junto à capa');
 manga.artists = ['Artista de teste']; manga.authors = ['Autor de teste'];
 await page.goto(`${origin}/biblioteca/5`);
 await page.locator('.series-completed-tag').waitFor();
 for (const width of [1280,390]) {
  await page.setViewportSize({width,height:900});
  for (const route of ['/biblioteca/5','/']) {
   await page.goto(origin+route);
   await page.locator('.series-completed-tag').first().waitFor();
   const box=await page.locator('.series-card:has(.series-completed-tag)').first().evaluate(card=>{
    const tag=card.querySelector('.series-completed-tag').getBoundingClientRect();
    const cover=card.querySelector('.cover-image,.cover-placeholder').getBoundingClientRect();
    const kind=card.querySelector('.content-kind-tag:not(.series-completed-tag)')?.getBoundingClientRect();
    return {tag:{top:tag.top,bottom:tag.bottom,left:tag.left,right:tag.right,height:tag.height},cover:{top:cover.top,bottom:cover.bottom,left:cover.left,right:cover.right},kind:kind?{bottom:kind.bottom,height:kind.height}:null};
   });
   assert.ok(box.tag.top>=box.cover.top-2 && box.tag.bottom<box.cover.bottom && box.tag.left>=box.cover.left-2 && box.tag.right<=box.cover.right+2,`Finalizada sobre a capa: ${JSON.stringify(box)}`);
   if(route==='/') { assert.ok(box.kind,'tipo visível na página inicial');assert.ok(box.tag.top>=box.kind.bottom+3,'etiquetas não se sobrepõem');assert.equal(box.tag.height,box.kind.height,'mesma altura e estilo'); }
  }
 }
 manga.publicationStatus='hiatus';manga.rating='357';manga.description='';
 await page.goto(`${origin}/biblioteca/5/titulo/${encodeURIComponent(manga.id)}`);
 await page.locator('.series-description-card').waitFor();
 assert.equal(await page.locator('.publication-completed').count(),0,'hiato não é finalizada');
 assert.ok((await page.locator('.series-rating-display').innerText()).includes('N/A'));
 assert.equal(await page.locator('.series-description').innerText(),'Sem sinopse disponível para esta obra.');
 assert.deepEqual(errors,[]);
 console.log('PASS PugotiQA: detalhes, sinopse, notas, capítulos/páginas e finalizada em desktop/tablet/celular');
} finally {
 await browser.close();server.close();
}
