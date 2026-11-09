"""Full reader UI regression with isolated PDF/API fixtures.
Build first, then run with Python + playwright/reportlab and system Chromium.
Only the test-served app skips authentication boot and exposes test entry points.
"""
import pathlib,tempfile,threading,http.server,functools,json,os,shutil
from playwright.sync_api import sync_playwright
from reportlab.pdfgen import canvas
ROOT=pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as td:
 t=pathlib.Path(td)
 pdf=canvas.Canvas(str(t/'sample.pdf'))
 for i in range(4):
  pdf.bookmarkPage('page'+str(i))
  if i == 0: pdf.addOutlineEntry('Introdução', 'page0', 0)
  if i == 1: pdf.addOutlineEntry('Capítulo 1', 'page1', 0)
  if i == 2: pdf.addOutlineEntry('Seção interna', 'page2', 1)
  if i == 3: pdf.addOutlineEntry('Fim', 'page3', 0)
  pdf.setFont('Helvetica',16)
  pdf.drawString(50,700,'Antes Desenvolvimento depois desengajar DeSeNtErRadO.')
  # Force a word to be split into separate PDF text items with different fonts.
  pdf.setFont('Helvetica-Bold',16);pdf.drawString(50,650,'Desen')
  x=50+pdf.stringWidth('Desen','Helvetica-Bold',16)
  pdf.setFont('Helvetica',16);pdf.drawString(x,650,'volvida')
  pdf.drawString(50,600,'Outra linha independente sem resultado.')
  pdf.showPage()
 pdf.save()
 if os.environ.get('PDF_VALIDATION_FILE'): shutil.copyfile(os.environ['PDF_VALIDATION_FILE'],t/'sample.pdf')
 empty=canvas.Canvas(str(t/'empty.pdf'));empty.drawString(50,700,'Sem sumário');empty.save()
 for name,target in [('styles.css',ROOT/'public/styles.css'),('pdfjs',ROOT/'public/pdfjs'),('UI',ROOT/'dist/UI'),('shared',ROOT/'dist/shared')]: (t/name).symlink_to(target)
 code=(ROOT/'dist/UI/Web/app.js').read_text().replace('void boot();','window.testApp = { openReaderAtPageAndRender, renderShell, state, router };')
 class Handler(http.server.SimpleHTTPRequestHandler):
  def log_message(self,*args): pass
  def do_POST(self):
   size=int(self.headers.get('Content-Length',0));payload=json.loads(self.rfile.read(size) or b'{}')
   if self.path=='/api/bookmarks':
    key=payload['page']
    if key in self.server.marks:self.server.marks.remove(key)
    else:self.server.marks.add(key)
   self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{}')
  def do_PUT(self):
   self.rfile.read(int(self.headers.get('Content-Length',0)))
   self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{}')
  def do_GET(self):
   if self.path=='/api/bookmarks':
    data={'bookmarks':[{'userId':'fixture','contentId':'test','page':p,'createdAt':'2026-09-07'} for p in self.server.marks]}
    self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(data).encode());return
   if self.path.split('?')[0]=='/UI/Web/app.js':
    self.send_response(200);self.send_header('Content-Type','text/javascript');self.end_headers();self.wfile.write(code.encode());return
   if '/api/contents/' in self.path and '/pages/' in self.path:
    self.path='/sample.pdf'
   return super().do_GET()
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(t)))
 server.marks=set()
 threading.Thread(target=server.serve_forever,daemon=True).start()
 (t/'index.html').write_text('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><div id="app"></div><script type="module" src="/UI/Web/app.js"></script>')
 with sync_playwright() as p:
  for mode in ['desktop','linux-app','mobile']:
   width=390 if mode=='mobile' else 1280
   url=f'http://127.0.0.1:{server.server_port}'
   profile=tempfile.TemporaryDirectory()
   context=p.chromium.launch_persistent_context(profile.name,executable_path='/usr/bin/chromium',headless=not (mode=='linux-app' and os.environ.get('DISPLAY')),args=['--no-sandbox']+(['--app='+url] if mode=='linux-app' else []),viewport={'width':width,'height':900},is_mobile=mode=='mobile',has_touch=mode=='mobile')
   page=context.pages[0] if context.pages else context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(url);page.wait_for_function('window.testApp')
   page.evaluate("testApp.state.user={id:'fixture',username:'fixture',role:'user',allowedLibraryIds:[],favoriteContentIds:[]}")
   page.evaluate("testApp.state.libraries=[{id:'books',name:'Livros',kind:'other'}]")
   page.evaluate("testApp.router.start()")
   fixture={"id":"test","libraryId":"books","title":"Avatar Legends","description":None,"authors":[],"genres":[],"pageCount":308,"chapterCount":0,"chapters":[],"coverUrl":None,"pageTypes":["pdf"]}
   page.evaluate('(content)=>testApp.openReaderAtPageAndRender(content,5)',fixture)
   page.wait_for_selector('[data-pdf-page="6"] canvas',timeout=60000)
   toggle=page.locator('[data-reader-action="pdf-outline"]');toggle.click()
   panel=page.locator('.pdf-outline-panel');assert panel.is_visible()
   page.wait_for_selector('.pdf-outline-link',timeout=60000)
   assert page.locator('.pdf-outline-link').count()>10
   # Navigate a real outline destination and verify that the page control changed.
   target=page.locator('.pdf-outline-link').nth(10);label=target.inner_text();target.click()
   page.wait_for_function("document.querySelector('[data-pdf-page-input]').value==='23'",timeout=60000)
   if mode=='mobile':page.wait_for_function("document.querySelector('.pdf-outline-panel').hidden")
   print(mode,'outline target',label,'page',page.locator('[data-pdf-page-input]').input_value(),flush=True)
   if panel.is_visible():page.get_by_role('button',name='Minimizar sumário').click()
   page.locator('[data-reader-action="pdf-search"]').click()
   search=page.locator('[data-pdf-search-input]');search.fill('dEsEn');search.press('Enter')
   page.wait_for_function("document.querySelector('[data-pdf-search-status]').textContent.includes('ocorrência')",timeout=120000)
   field=page.locator('[data-pdf-page-input]');field.fill('6');field.press('Enter')
   page.wait_for_selector('[data-pdf-page="6"] .pdf-text-match')
   texts=page.locator('[data-pdf-page="6"] .pdf-text-match').all_text_contents()
   assert 'Desenvolvimento' in texts,texts
   assert 'Desen' not in texts,texts
   print(mode,'real PDF complete words',texts,flush=True)
   for zoom in [100,150]:
    if zoom==150:
     page.locator('[data-reader-action="zoom-in"]').click();page.locator('[data-reader-action="zoom-in"]').click();page.wait_for_timeout(1000)
    mark=page.locator('[data-pdf-page="6"] .pdf-text-match',has_text='Desenvolvimento').first
    mark.scroll_into_view_if_needed()
    page.screenshot(path=str(ROOT/'artifacts'/f'avatar-word-{mode}-{zoom}.png'))
    assert mark.bounding_box()['width']>40
   field=page.locator('[data-pdf-page-input]');field.fill('285');field.press('Enter')
   page.wait_for_selector('[data-pdf-page="285"] .pdf-text-match',timeout=60000)
   words=page.locator('[data-pdf-page="285"] .pdf-text-match').all_text_contents()
   assert 'desengajar' in words,words
   page.locator('[data-pdf-page="285"] .pdf-text-match',has_text='desengajar').first.scroll_into_view_if_needed()
   page.screenshot(path=str(ROOT/'artifacts'/f'avatar-desengajar-{mode}.png'))
   print(mode,'desengajar complete',words,flush=True)
   page.locator('[data-pdf-search-close]').click();assert page.locator('.pdf-text-match').count()==0
   assert not errors,errors
   print('PASS real PDF',mode,flush=True)
   context.close();profile.cleanup()
 server.shutdown()
