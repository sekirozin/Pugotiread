"""Full reader UI regression with isolated PDF/API fixtures.
Build first, then run with Python + playwright/reportlab and system Chromium.
Only the test-served app skips authentication boot and exposes test entry points.
"""
import pathlib,tempfile,threading,http.server,functools,json
from playwright.sync_api import sync_playwright
from reportlab.pdfgen import canvas
from pypdf import PdfReader, PdfWriter
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
 writer=PdfWriter(clone_from=str(t/'sample.pdf'));writer.pages[3].rotate(90)
 writer.write(t/'sample.pdf')
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
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width in [1280,390,320]:
   context=browser.new_context(viewport={'width':width,'height':844},is_mobile=width<700,has_touch=width<700,device_scale_factor=2 if width<700 else 1)
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(f'http://127.0.0.1:{server.server_port}')
   page.wait_for_function('window.testApp')
   page.evaluate("testApp.state.user={id:'fixture',username:'fixture',role:'user',allowedLibraryIds:[],favoriteContentIds:[]}")
   page.evaluate("testApp.state.libraries=[{id:'books',name:'Livros',kind:'other'}]")
   page.evaluate("testApp.router.start()")
   fixture={"id":"test","libraryId":"books","title":"Teste PDF","description":None,"authors":[],"genres":[],"pageCount":4,"chapterCount":0,"chapters":[],"coverUrl":None,"pageTypes":["pdf"]}
   page.evaluate('(content)=>testApp.openReaderAtPageAndRender(content,0)',fixture)
   page.wait_for_selector('[data-pdf-page="1"] canvas')
   toggle=page.locator('[data-reader-action="pdf-outline"]')
   toggle.click()
   panel=page.locator('.pdf-outline-panel');assert panel.is_visible()
   page.get_by_role('button',name='Expandir Capítulo 1',exact=True).click()
   page.get_by_role('button',name='Seção interna',exact=True).click()
   page.wait_for_function("document.querySelector('[data-pdf-page-input]').value==='3'")
   if width<700: assert not panel.is_visible()
   else: page.get_by_role('button',name='Minimizar sumário').click()
   toggle.click();assert panel.is_visible();page.get_by_role('button',name='Minimizar sumário').click()
   assert not panel.is_visible()
   page.locator('[data-reader-action="pdf-search"]').click()
   search=page.locator('[data-pdf-search-input]');search.fill('dEsEn');search.press('Enter')
   page.wait_for_function("document.querySelector('[data-pdf-search-status]').textContent.includes('ocorrência')")
   page.wait_for_selector('[data-pdf-page="1"] .pdf-text-match')
   for zoom in [100,125,75]:
    if zoom!=100:
     page.locator('[data-reader-action="zoom-reset"]').click()
     page.locator('[data-reader-action="zoom-in"]' if zoom==125 else '[data-reader-action="zoom-out"]').click()
     page.wait_for_timeout(800)
    marks=page.locator('[data-pdf-page="1"] .pdf-text-match')
    texts=marks.all_text_contents()
    assert texts==['Desenvolvimento','desengajar','DeSeNtErRadO','Desen','volvida'],texts
    geometry=page.evaluate("""()=>{
     const p=document.querySelector('[data-pdf-page="1"]');const c=p.querySelector('canvas').getBoundingClientRect();
     const marks=[...p.querySelectorAll('.pdf-text-match')].map(e=>{const r=e.getBoundingClientRect();return {x:(r.x-c.x)/c.width,y:(r.y-c.y)/c.height,w:r.width/c.width,h:r.height/c.height,bg:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color}});
     return {marks,overflow:document.documentElement.scrollWidth>innerWidth};
    }""")
    # A4 fixture: text baseline at 700/841.89, first line is 16pt tall.
    assert abs(geometry['marks'][0]['y'] - (841.89-700-16*.8)/841.89)<.008,geometry
    assert .14<geometry['marks'][0]['w']<.25,geometry
    assert geometry['marks'][0]['color']=='rgba(0, 0, 0, 0)',geometry
   (ROOT/'artifacts').mkdir(exist_ok=True)
   page.screenshot(path=str(ROOT/'artifacts'/f'pdf-search-outline-{width}.png'))
   field=page.locator('[data-pdf-page-input]');field.fill('4');field.press('Enter')
   page.wait_for_selector('[data-pdf-page="4"] .pdf-text-match')
   rotated=page.evaluate("""()=>{const p=document.querySelector('[data-pdf-page="4"]'),c=p.querySelector('canvas').getBoundingClientRect(),r=p.querySelector('.pdf-text-match').getBoundingClientRect();return {inside:r.x>=c.x&&r.y>=c.y&&r.right<=c.right&&r.bottom<=c.bottom,vertical:r.height>r.width}}""")
   assert rotated['inside'] and rotated['vertical'],rotated
   search.fill('indep');search.press('Enter')
   page.wait_for_function("document.querySelector('[data-pdf-search-status]').textContent.includes('ocorrência')")
   assert page.locator('[data-pdf-page="1"] .pdf-text-match').all_text_contents()==['independente']
   page.locator('[data-pdf-search-close]').click();assert page.locator('.pdf-text-match').count()==0
   search=page.locator('[data-pdf-search-input]')
   page.locator('[data-reader-action="pdf-search"]').click();search.fill('no-match');search.press('Enter')
   page.wait_for_function("document.querySelector('[data-pdf-search-status]').textContent==='Nenhum resultado.'")
   assert page.locator('.pdf-text-match').count()==0
   page.locator('[data-pdf-search-close]').click()
   # Re-render/reopen the document: no stale detached outline panel.
   page.evaluate('(content)=>testApp.openReaderAtPageAndRender(content,0)',fixture)
   page.wait_for_selector('[data-pdf-page="1"] canvas');toggle.click();assert panel.is_visible()
   # Delayed/empty/error outlines must keep the panel open and offer feedback.
   await_js = """async()=>{
    const {PdfOutline}=await import('/UI/Web/pdf-outline.js');
    const root=document.createElement('section');root.innerHTML='<button data-reader-action="pdf-outline">Sumário</button>';document.body.append(root);
    window.outlineCase=new PdfOutline(root,()=>{});
    window.outlineCase.toggleOpen();
    window.outlineCase.load({numPages:1,getOutline:()=>new Promise(r=>window.resolveOutline=r)});
   }"""
   page.evaluate(await_js)
   active=page.locator('.pdf-outline-panel').last
   assert active.is_visible()
   page.evaluate('resolveOutline(null)');page.wait_for_timeout(50)
   assert active.is_visible() and 'não possui' in active.inner_text()
   page.evaluate('outlineCase.load({numPages:1,getOutline:async()=>{throw Error("test")}})')
   page.wait_for_timeout(50);assert active.get_by_role('button',name='Tentar novamente').is_visible()
   page.evaluate('outlineCase.destroy()')
   assert not errors,errors
   print('PASS desktop/mobile' ,width,flush=True)
   context.close()
  browser.close()
 server.shutdown()
