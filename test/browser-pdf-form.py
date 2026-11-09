"""Real PDF.js widgets, zoom, saved values and layout in desktop/mobile/app mode.
Run after build with Python playwright + reportlab and Chromium installed.
"""
import base64, functools, http.server, json, pathlib, tempfile, threading
from playwright.sync_api import sync_playwright
from reportlab.pdfgen import canvas

ROOT = pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    pdf = canvas.Canvas(str(root / 'fixture.pdf'), pagesize=(600, 800))
    pdf.drawString(50, 730, 'Ficha RPG - formulario de teste')
    pdf.acroForm.textfield(name='Nome', x=50, y=620, width=240, height=32)
    pdf.acroForm.textfield(name='Talento', x=50, y=570, width=240, height=32)
    pdf.acroForm.checkbox(name='Treinado', x=50, y=560, size=24)
    pdf.showPage(); pdf.drawString(50, 730, 'Pagina 2'); pdf.save()
    for name, target in [('UI', ROOT/'dist/UI'), ('shared', ROOT/'dist/shared'), ('pdfjs', ROOT/'public/pdfjs'), ('styles.css', ROOT/'public/styles.css')]:
        (root/name).symlink_to(target)
    code=(ROOT/'dist/UI/Web/app.js').read_text().replace('void boot();', 'window.testApp={state,router,openReaderAtPageAndRender,setReaderZoom};')
    (root/'index.html').write_text('''<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/styles.css"><div id="app"></div><script type="module" src="/UI/Web/app.js"></script>''')
    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_GET(self):
            if self.path.split('?')[0]=='/UI/Web/app.js':
                self.send_response(200); self.send_header('Content-Type','text/javascript'); self.end_headers(); self.wfile.write(code.encode()); return
            if self.path.endswith('/pdf-form'):
                result = {'originalName':'Ficha', 'fields':[{'name':'Nome','type':'text','value':''},{'name':'Talento','type':'text','value':''},{'name':'Treinado','type':'checkbox','value':False}]}
                self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(json.dumps(result).encode()); return
            if '/pages/0' in self.path: self.path='/fixture.pdf'
            return super().do_GET()
        def do_POST(self):
            payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            if self.path.endswith('/preview'):
                result={'pdf':base64.b64encode((root/'fixture.pdf').read_bytes()).decode(), 'schema':{'originalName':'Ficha','pageCount':2,'fields':[{'name':'Nome','type':'text','value':''},{'name':'Talento','type':'text','value':''},{'name':'Treinado','type':'checkbox','value':False}]}}
                self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(json.dumps(result).encode()); return
            self.server.saved=payload
            self.send_response(201); self.send_header('Content-Type','application/json'); self.end_headers()
            self.wfile.write(b'{"filename":"Ficha - Enrick.pdf"}')
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=directory))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    with sync_playwright() as playwright:
        for mode, width in [('desktop',1280),('mobile',390),('mobile',320),('linux-app',1280)]:
            with tempfile.TemporaryDirectory() as profile:
                context=playwright.chromium.launch_persistent_context(profile, executable_path='/usr/bin/chromium', headless=True,
                    args=['--no-sandbox']+(['--app=about:blank'] if mode=='linux-app' else []), viewport={'width':width,'height':844}, is_mobile=mode=='mobile', has_touch=mode=='mobile')
                page=context.pages[0]; errors=[]; page.on('pageerror',lambda error: errors.append(str(error)))
                page.goto(f'http://127.0.0.1:{server.server_port}'); page.wait_for_function('window.testApp')
                page.evaluate("""testApp.state.user={id:'fixture',username:'fixture',role:'user',allowedLibraryIds:['books'],favoriteContentIds:[]};
                testApp.state.libraries=[{id:'books',name:'RPG',kind:'other'}]; testApp.router.start();
                testApp.openReaderAtPageAndRender({id:'books:fixture',libraryId:'books',title:'Ficha',description:null,authors:[],genres:[],pageCount:2,chapterCount:0,chapters:[],coverUrl:null,pageTypes:['pdf']},0);
                window.zoom=value=>testApp.setReaderZoom(value*100);""")
                page.locator('.pdf-form-toggle:enabled').click()
                field=page.locator('.pdf-form-layer input[type=text]').nth(0); field.fill('Enrick')
                page.locator('.pdf-form-layer input[type=text]').nth(1).click(modifiers=['Shift'])
                page.locator('.pdf-form-layer input[type=checkbox]').check()
                style_panel=page.locator('.pdf-form-style-panel')
                assert style_panel.is_visible()
                assert page.get_by_role('button', name='Aumentar fonte').is_visible()
                toolbar=page.locator('.reader-pdf-toolbar').bounding_box()
                assert toolbar['y']>700
                page.screenshot(path=f'/tmp/pdf-ribbon-{mode}-{width}.png')
                assert page.locator('.pdf-form-panel').evaluate('(el)=>el.scrollWidth<=el.clientWidth+1'), page.locator('.pdf-form-panel').evaluate('(el)=>[el.clientWidth,el.scrollWidth,Array.from(el.children).map(x=>[x.className,x.getBoundingClientRect().width,x.scrollWidth,getComputedStyle(x).overflowX])]')
                page.screenshot(path=f'/tmp/pdf-ribbon-{mode}-{width}.png')
                page.locator('#pdf-form-style-font').select_option('times')
                page.locator('#pdf-form-style-size').fill('13')
                page.locator('#pdf-form-style-color').fill('#14532d')
                page.get_by_role('button', name='Centralizar').click()
                assert page.locator('.pdf-form-layer [data-pdf-form-selected]').count()==2
                page.locator('#pdf-form-bulk-text').fill('Talento 15')
                page.get_by_role('button', name='Aplicar texto').click()
                page.evaluate('zoom(1.5,1)'); page.wait_for_timeout(350)
                page.wait_for_function("document.querySelector('.pdf-form-layer input[type=text]')?.value === 'Talento 15'")
                assert page.locator('.pdf-form-layer input[type=checkbox]').is_checked()
                rect=field.bounding_box(); sheet=page.locator('[data-pdf-page="1"]').bounding_box()
                assert abs((rect['x']-sheet['x'])/sheet['width']-50/600)<.01
                page.locator('.pdf-form-name input').fill('Enrick')
                page.get_by_role('button',name='Salvar como nova cópia').click()
                page.wait_for_function("document.querySelector('.pdf-form-panel [role=status]').textContent.includes('Cópia salva')")
                assert server.saved=={'name':'Enrick','edits':[],'values':{'Nome':'Talento 15','Talento':'Talento 15','Treinado':True},'styles':{'Nome':{'font':'times','fontSize':13,'color':'#14532d','alignment':'center'},'Talento':{'font':'times','fontSize':13,'color':'#14532d','alignment':'center'}}},server.saved
                assert page.locator('.pdf-form-layer input').count()==0
                page.locator('.pdf-form-toggle').click()
                assert page.locator('.pdf-form-layer input[type=text]').nth(0).input_value()==''
                box=page.locator('.pdf-form-panel').bounding_box(); assert box['x']>=0 and box['x']+box['width']<=width
                assert not errors,errors
                print('PASS',mode,flush=True); context.close()
    server.shutdown()
