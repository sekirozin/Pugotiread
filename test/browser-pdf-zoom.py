"""Browser regression: pip install playwright reportlab; build TypeScript first.
Uses system Chromium and a generated PDF; does not access library/user data.
"""
import functools
import http.server
import json
import pathlib
import tempfile
import threading
from reportlab.pdfgen import canvas
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]

with tempfile.TemporaryDirectory() as tmp:
    tmp = pathlib.Path(tmp)
    pdf = canvas.Canvas(str(tmp / 'sample.pdf'))
    for page in range(1, 21):
        pdf.drawString(80, 750, f'Zoom regression - page {page}')
        pdf.rect(30, 30, 535, 782)
        pdf.showPage()
    pdf.save()
    for name, target in [('styles.css', ROOT / 'public/styles.css'), ('pdfjs', ROOT / 'public/pdfjs'), ('viewer.js', ROOT / 'dist/UI/Web/pdf-viewer.js')]:
        (tmp / name).symlink_to(target)
    (tmp / 'index.html').write_text('''<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css">
    <section class="reader reader-pdf-reader"><nav class="reader-pdf-toolbar"><button id="minus">−</button><button id="reset">100%</button><button id="plus">+</button></nav><div id="reader-stage" class="reader-stage fit-width"><div class="reader-media-shell"><div class="reader-pdf"><div data-pdf-status></div><div class="pdf-pages" data-pdf-pages></div></div></div></div></section>
    <script type="module">import * as viewer from '/viewer.js'; window.viewer=viewer;
    window.addEventListener('pugotiread:pdf-zoom-change',e=>document.querySelector('#reset').textContent=e.detail.zoom+'%');
    for(const [id,delta] of [['plus',.25],['minus',-.25],['reset',0]]) document.getElementById(id).onclick=()=>viewer.aplicarZoomPdf(delta ? viewer.obterZoomPdf()+delta : 1,viewer.obterPaginaAtualPdf());
    await viewer.iniciarLeitorPdf('/sample.pdf',5); window.ready=true;</script>''')
    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args): pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(tmp)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        for mobile, width, height in [(False,1280,900),(True,390,844)]:
            context=browser.new_context(viewport={'width':width,'height':height},is_mobile=mobile,has_touch=mobile,device_scale_factor=2 if mobile else 1)
            page=context.new_page()
            errors=[]
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{server.server_port}')
            page.wait_for_function('window.ready && document.querySelector(\'[data-pdf-page="5"] canvas\')')
            page.wait_for_timeout(350)
            def geometry():
                return page.evaluate('''() => {const s=document.querySelector('#reader-stage'),p=document.querySelector('[data-pdf-page="5"]'),c=p.querySelector('canvas');return {width:p.clientWidth,canvas:c?.clientWidth,left:p.getBoundingClientRect().left,scroll:s.scrollTop,scrollWidth:s.scrollWidth,stage:s.clientWidth,zoom:viewer.obterZoomPdf(),canvases:document.querySelectorAll('canvas').length};}''')
            base=geometry()
            page.click('#plus')
            page.wait_for_timeout(400)
            enlarged=geometry()
            assert abs(enlarged['width']/base['width']-1.25)<.02, (base,enlarged)
            assert enlarged['canvas']==enlarged['width']
            page.click('#reset')
            page.wait_for_timeout(300)
            assert abs(geometry()['width']-base['width'])<=1
            # Preserve the document point under the midpoint during zoom.
            anchor=page.evaluate('''() => {const s=document.querySelector('#reader-stage');s.scrollTop+=180;const r=document.querySelector('[data-pdf-page="5"]').getBoundingClientRect();return (s.clientHeight/2-r.top)/r.height;}''')
            page.evaluate('viewer.aplicarZoomPdf(2,5)')
            page.wait_for_timeout(400)
            after=page.evaluate('''() => {const s=document.querySelector('#reader-stage'),r=document.querySelector('[data-pdf-page="5"]').getBoundingClientRect();return (s.clientHeight/2-r.top)/r.height;}''')
            assert abs(anchor-after)<.015, (anchor,after)
            assert geometry()['scrollWidth']>geometry()['stage']
            page.evaluate('''() => {const s=document.querySelector('#reader-stage');s.scrollLeft=1e6;}''')
            right=page.locator('[data-pdf-page="5"]').bounding_box()
            assert right['x']+right['width']<=width+1, right
            if mobile:
                page.click('#reset');page.wait_for_timeout(300)
                cdp=context.new_cdp_session(page)
                cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':145,'y':420,'id':0},{'x':245,'y':420,'id':1}]})
                for delta in range(5,51,5):
                    cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':145-delta,'y':420,'id':0},{'x':245+delta,'y':420,'id':1}]})
                cdp.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
                page.wait_for_timeout(400)
                assert geometry()['zoom']>1.8, geometry()
                assert page.evaluate('visualViewport.scale')==1
                assert page.locator('#reset').inner_text()=='200%'
                cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':95,'y':420,'id':0},{'x':295,'y':420,'id':1}]})
                for delta in range(5,51,5):
                    cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':95+delta,'y':420,'id':0},{'x':295-delta,'y':420,'id':1}]})
                cdp.send('Input.dispatchTouchEvent',{'type':'touchCancel','touchPoints':[]})
                page.wait_for_timeout(400)
                assert abs(geometry()['zoom']-1)<.01
                # One-finger swipe still scrolls the document after the pinch.
                old=geometry()['scroll']
                cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':190,'y':600,'id':0}]})
                for y in range(580,299,-20):
                    cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':190,'y':y,'id':0}]})
                    page.wait_for_timeout(16)
                cdp.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
                page.wait_for_timeout(400)
                assert geometry()['scroll']>old+100
            page.evaluate('''() => {for (const z of [2.5,.5,2,1.25,2.5]) viewer.aplicarZoomPdf(z,viewer.obterPaginaAtualPdf());}''')
            page.wait_for_timeout(600)
            assert geometry()['zoom']==2.5
            assert geometry()['canvases']<=10
            page.evaluate('viewer.navegarParaPaginaPdf(18)')
            page.wait_for_function('document.querySelector(\'[data-pdf-page="18"] canvas\')')
            assert page.evaluate('viewer.obterPaginaAtualPdf()')==18
            page.evaluate("viewer.iniciarLeitorPdf('/sample.pdf',5,1.5)")
            page.wait_for_timeout(600)
            assert geometry()['zoom']==1.5
            assert abs(geometry()['width']/base['width']-1.5)<.02
            assert not errors, errors
            print(json.dumps({'mobile':mobile,'base':base,'zoom125':enlarged,'result':'PASS'}))
            context.close()
        browser.close()
    server.shutdown()
