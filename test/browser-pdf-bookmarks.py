"""Full reader UI regression with isolated PDF/API fixtures.
Build first, then run with Python + playwright/reportlab and system Chromium.
Only the test-served app skips authentication boot and exposes test entry points.
"""
import pathlib,tempfile,threading,http.server,functools,json
from playwright.sync_api import sync_playwright
from reportlab.pdfgen import canvas
ROOT=pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as td:
 t=pathlib.Path(td)
 pdf=canvas.Canvas(str(t/'sample.pdf'))
 for i in range(20): pdf.drawString(50,700,'PDF test page '+str(i+1));pdf.showPage()
 pdf.save()
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
  def do_PATCH(self):
   payload=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
   page=payload['page'];name=payload['name'].strip()
   self.server.names[page]=name
   data={'bookmark':{'userId':'fixture','contentId':'test','page':page,'name':name,'createdAt':'2026-09-07'}}
   self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(data).encode())
  def do_PUT(self):
   self.rfile.read(int(self.headers.get('Content-Length',0)))
   self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{}')
  def do_GET(self):
   if self.path.startswith('/api/bookmarks'):
    data={'bookmarks':[{'userId':'fixture','contentId':'test','page':p,'name':self.server.names.get(p,''),'createdAt':'2026-09-07'} for p in self.server.marks]}
    if 'includeContents=1' in self.path: data['contents']=[fixture]
    self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(data).encode());return
   if self.path.split('?')[0]=='/UI/Web/app.js':
    self.send_response(200);self.send_header('Content-Type','text/javascript');self.end_headers();self.wfile.write(code.encode());return
   if '/api/contents/' in self.path and '/pages/' in self.path:
    self.path='/sample.pdf'
   return super().do_GET()
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(t)))
 server.marks=set();server.names={}
 fixture={"id":"test","libraryId":"books","title":"Manual de teste","description":None,"authors":[],"genres":[],"pageCount":1,"chapterCount":0,"chapters":[],"coverUrl":None,"pageTypes":["pdf"]}
 threading.Thread(target=server.serve_forever,daemon=True).start()
 (t/'index.html').write_text('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><div id="app"></div><script type="module" src="/UI/Web/app.js"></script>')
 with sync_playwright() as p:
  b=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width in [1280,390]:
   server.marks.clear();server.names.clear()
   context=b.new_context(viewport={'width':width,'height':844},is_mobile=width<700,has_touch=width<700)
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   def boot():
    page.goto(f'http://127.0.0.1:{server.server_port}')
    page.wait_for_function('window.testApp')
    page.evaluate("testApp.state.user={id:'fixture',username:'fixture',role:'user',allowedLibraryIds:[],favoriteContentIds:[]}")
    page.evaluate("testApp.state.libraries=[{id:'books',name:'Livros',kind:'other'}]")
    page.evaluate("testApp.router.start()")
   def marks_view():
    page.evaluate("document.querySelector('[data-nav-view=bookmarks]').click()")
    page.wait_for_selector('.marked-page-row')
   boot()
   page.evaluate('(content)=>testApp.openReaderAtPageAndRender(content,4)',fixture)
   page.wait_for_selector('[data-pdf-page="5"] canvas')
   for n in [12,19]:
    page.locator('[data-pdf-page-input]').fill(str(n));page.locator('[data-pdf-page-input]').press('Enter')
    page.locator('.reader-pdf-bookmark').click()
    page.wait_for_function("document.querySelector('.reader-pdf-bookmark').getAttribute('aria-busy')==='false'")
   page.locator('.reader-pdf-back').click()
   marks_view()
   assert page.locator('.marked-page-row').count()==2
   row=page.locator('[data-marked-page="11"]')
   row.locator('summary').click()
   row.locator('input').fill('Regras & <ações>')
   row.locator('[type=submit]').click()
   page.wait_for_function("document.querySelector('[data-marked-page=\"11\"] .marked-page-name').textContent==='Regras & <ações>'")
   assert row.locator('.marked-page-name').inner_html()=='Regras &amp; &lt;ações&gt;'
   row.locator('summary').click();row.locator('input').fill('Descartar')
   row.locator('[data-cancel-marked-name]').click()
   assert row.locator('.marked-page-name').inner_text()=='Regras & <ações>'
   boot()
   page.evaluate('testApp.renderShell()')
   marks_view()
   row=page.locator('[data-marked-page="11"]')
   assert row.locator('.marked-page-name').inner_text()=='Regras & <ações>'
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
   (ROOT/'artifacts').mkdir(exist_ok=True)
   page.screenshot(path=str(ROOT/'artifacts'/f'bookmarks-{width}.png'))
   row.locator('[data-open-marked-page]').click()
   page.wait_for_selector('[data-pdf-page="12"] canvas')
   page.wait_for_timeout(300)
   assert page.locator('[data-pdf-page-input]').input_value()=='12'
   assert page.locator('.reader-pdf-bookmark').get_attribute('aria-pressed')=='true'
   page.locator('.reader-pdf-back').click()
   # PDF details expose saved pages directly, without the series tabs.
   page.evaluate("(content)=>{testApp.state.contents=[content];testApp.state.activeSeriesId=content.id;testApp.state.seriesTab='chapters';testApp.renderShell()}",fixture)
   page.wait_for_selector('.pdf-document-bookmarks')
   page.locator('[data-marked-page="18"] [data-open-marked-page]').click()
   page.wait_for_selector('[data-pdf-page="19"] canvas')
   assert page.locator('[data-pdf-page-input]').input_value()=='19'
   assert not errors,errors
   print(json.dumps({'width':width,'result':'PASS: mark, rename, cancel, persist after reload, direct PDF jump, PDF details'}))
   context.close()
  b.close()
 server.shutdown()
