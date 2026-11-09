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
  b=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width,height in [(1280,844),(390,844),(360,844),(320,844),(844,390)]:
   server.marks.clear()
   c=b.new_context(viewport={'width':width,'height':height},is_mobile=width<700,has_touch=True)
   page=c.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(f'http://127.0.0.1:{server.server_port}')
   page.wait_for_function('window.testApp')
   page.evaluate("testApp.state.user={id:'fixture',username:'fixture',role:'user',allowedLibraryIds:[],favoriteContentIds:[]}")
   page.evaluate("testApp.state.libraries=[{id:'books',name:'Livros',kind:'other'}]")
   page.evaluate("testApp.router.start()")
   page.evaluate("testApp.openReaderAtPageAndRender({id:'test',libraryId:'books',title:'Teste PDF',description:null,authors:[],genres:[],pageCount:20,chapterCount:0,chapters:[],coverUrl:null,pageTypes:['pdf']},4)")
   page.wait_for_selector('[data-pdf-page="5"] canvas')
   page.wait_for_timeout(500)
   toolbar=page.locator('.reader-pdf-toolbar')
   def check_layout():
    box=toolbar.bounding_box()
    assert box['x']>=0 and box['x']+box['width']<=page.viewport_size['width'],box
    buttons=toolbar.locator('button')
    rects=[]
    for i in range(buttons.count()):
     rect=buttons.nth(i).bounding_box();assert rect['width']>=40 and rect['height']>=44,rect
     assert rect['x']>=box['x'] and rect['x']+rect['width']<=box['x']+box['width']+.1,rect
     for old in rects:
      overlap=min(rect['x']+rect['width'],old['x']+old['width'])-max(rect['x'],old['x'])
      vertical=min(rect['y']+rect['height'],old['y']+old['height'])-max(rect['y'],old['y'])
      assert overlap<=0 or vertical<=0,(rect,old)
     rects.append(rect)
   check_layout()
   icons=page.locator('.reader-pdf-toolbar-icon')
   for i in range(icons.count()):
    box=icons.nth(i).bounding_box()
    if box: assert 0<box['width']<=24 and 0<box['height']<=24,box
   top=toolbar.bounding_box();side=page.locator('.reader-pdf-side-toolbar').bounding_box()
   assert top['height']<=56,top
   assert side['width']<=56 and side['x']+side['width']<=width,side
   assert page.locator('.reader-pdf-toolbar .reader-pdf-search-button').count()==0
   assert page.locator('.reader-pdf-side-toolbar .reader-pdf-search-button').count()==1
   (ROOT/'artifacts').mkdir(exist_ok=True)
   page.screenshot(path=str(ROOT/'artifacts'/f'pdf-controls-{width}.png'))
   assert page.locator('.reader-overlay').count()==0
   zoom=page.locator('.reader-pdf-zoom-value')
   zbox=zoom.bounding_box()
   plus=toolbar.locator('[data-reader-action="zoom-in"]')
   minus=toolbar.locator('[data-reader-action="zoom-out"]')
   plus.click();assert zoom.inner_text()=='125%'
   assert zoom.bounding_box()==zbox
   zoom.click();assert zoom.inner_text()=='100%'
   for i in range(6):plus.click()
   assert zoom.inner_text()=='250%' and plus.is_disabled()
   zoom.click()
   minus.click();minus.click();assert zoom.inner_text()=='50%' and minus.is_disabled()
   zoom.click();page.wait_for_timeout(300)
   page.locator('.reader-pdf-options summary').click()
   page.locator('[data-reader-brightness]').focus()
   page.locator('[data-reader-brightness]').press('ArrowLeft')
   assert page.evaluate('testApp.state.reader.brightness')==99
   assert page.locator('.reader').evaluate('(e)=>e.style.getPropertyValue("--reader-brightness")')=='99%'
   page.locator('[data-reader-brightness]').press('End')
   page.locator('.reader-pdf-options summary').click()
   # Actual touch input, including displayed percentage and reset after pinch.
   if width<700:
    cdp=c.new_cdp_session(page)
    x=width/2
    cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x-50,'y':400,'id':0},{'x':x+50,'y':400,'id':1}]})
    for d in range(5,51,5):
     cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x-50-d,'y':400,'id':0},{'x':x+50+d,'y':400,'id':1}]})
    cdp.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
    page.wait_for_timeout(400)
    assert zoom.inner_text()=='200%'
    assert page.evaluate('visualViewport.scale')==1
    assert zoom.bounding_box()==zbox
    zoom.tap();assert zoom.inner_text()=='100%'
   page_input=page.locator('[data-pdf-page-input]')
   page_input.fill('12');page_input.press('Enter');page.wait_for_timeout(300)
   assert page_input.input_value()=='12'
   assert not page_input.evaluate('(e)=>e===document.activeElement')
   bookmark=page.locator('.reader-pdf-side-toolbar [data-reader-action="bookmark"]')
   bookmark.click();page.wait_for_function("document.querySelector('.reader-pdf-bookmark').getAttribute('aria-pressed')==='true'")
   page_input.fill('13');page_input.press('Enter');page.wait_for_timeout(250)
   assert bookmark.get_attribute('aria-pressed')=='false'
   page_input.fill('12');page_input.press('Enter');page.wait_for_timeout(250)
   assert bookmark.get_attribute('aria-pressed')=='true',page.evaluate('({page:testApp.state.reader.page, bookmarks:testApp.state.bookmarks,input:document.querySelector("[data-pdf-page-input]").value})')
   bookmark.click();page.wait_for_timeout(200);assert bookmark.get_attribute('aria-pressed')=='false'
   page.locator('.reader-pdf-side-toolbar [data-reader-action="pdf-search"]').click()
   search=page.locator('[data-pdf-search]');assert search.is_visible()
   page.wait_for_timeout(100)
   assert search.bounding_box()['y']>=toolbar.bounding_box()['y']+toolbar.bounding_box()['height']
   page.locator('[data-pdf-search-input]').fill('PDF test page')
   page.locator('[data-pdf-search-input]').press('Enter')
   page.wait_for_function("document.querySelector('[data-pdf-search-status]').textContent.includes('ocorr')")
   page.wait_for_selector('.pdf-text-match', timeout=3000)
   assert page.locator('.pdf-text-match').count() > 0
   current=int(page_input.input_value())
   page.locator('[data-pdf-search-next]').click();assert int(page_input.input_value())==current+1
   page.locator('[data-pdf-search-previous]').click();assert int(page_input.input_value())==current
   page.locator('[data-pdf-search-close]').click();assert search.is_hidden()
   assert page.locator('.pdf-text-match').count() == 0
   assert page.locator('.pdf-page.is-search-result').count() == 0
   fullscreen=toolbar.locator('[data-reader-action="fullscreen"]')
   fullscreen.click();page.wait_for_function('!!document.fullscreenElement')
   assert fullscreen.get_attribute('aria-pressed')=='true'
   assert page.evaluate('document.fullscreenElement===document.documentElement')
   # Refreshing the shell cannot eject fullscreen by removing its target.
   page.evaluate('testApp.renderShell()');page.wait_for_selector('.pdf-page canvas')
   assert page.evaluate('!!document.fullscreenElement')
   fullscreen.click();page.wait_for_function('!document.fullscreenElement')
   assert fullscreen.get_attribute('aria-pressed')=='false'
   if width==390:
    page.set_viewport_size({'width':844,'height':390});page.wait_for_timeout(600);check_layout()
    page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(600);check_layout()
   if width==1280:
    # Denial produces visible feedback and leaves the control usable.
    page.evaluate("() => {window.nativeRequest=document.documentElement.requestFullscreen; document.documentElement.requestFullscreen=()=>Promise.reject(new Error('fixture denial'));}")
    fullscreen.click();page.wait_for_selector('.reader-pdf-feedback:not([hidden])')
    assert not fullscreen.is_disabled()
    page.evaluate('() => {document.documentElement.requestFullscreen=window.nativeRequest;}')
    # Simulate a WebKit-only API, using native calls underneath.
    page.evaluate("window.nativeExit=document.exitFullscreen; document.documentElement.webkitRequestFullscreen=function(){return window.nativeRequest.call(this)}; document.webkitExitFullscreen=function(){return window.nativeExit.call(this)}; document.documentElement.requestFullscreen=undefined; document.exitFullscreen=undefined;")
    page.evaluate('testApp.renderShell()');page.wait_for_selector('.pdf-page canvas')
    fullscreen.click();page.wait_for_function('!!document.fullscreenElement')
    fullscreen.click();page.wait_for_function('!document.fullscreenElement')
    page.evaluate('() => {document.documentElement.requestFullscreen=window.nativeRequest;document.exitFullscreen=window.nativeExit;}')
   fullscreen.click();page.wait_for_function('!!document.fullscreenElement')
   page.locator('.reader-pdf-back').click()
   page.wait_for_function('!document.fullscreenElement && !document.querySelector(".reader")')
   assert not errors,errors
   print(json.dumps({'viewport':[width,height],'result':'PASS: layout, zoom, navigation, bookmarks, search, fullscreen, close'}))
   c.close()
  b.close()
 server.shutdown()
