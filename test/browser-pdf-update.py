"""UI integration with a mocked API; actual PDF bytes and authorization are tested over HTTP."""
import functools, http.server, json, pathlib, tempfile, threading
from playwright.sync_api import sync_playwright, expect

ROOT=pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as directory:
    root=pathlib.Path(directory)
    (root/'UI').symlink_to(ROOT/'dist/UI'); (root/'shared').symlink_to(ROOT/'dist/shared')
    (root/'styles.css').symlink_to(ROOT/'public/styles.css')
    html='''<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css">
    <div id="reader"><div class="reader-pdf-side-toolbar"></div><div id="sheet"><canvas></canvas></div></div>
    <script type="module">import {PdfFormEditor} from '/UI/Web/pdf-form.js';
    const editor=new PdfFormEditor(document.querySelector('#reader'),'books:copy');
    editor.attach(document.querySelector('#sheet'),{getAnnotations:async()=>[{subtype:'Widget',fieldName:'Nome',rect:[0,0,200,30]}]},
    {width:600,height:800,convertToViewportRectangle:r=>r});</script>'''
    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self,*_): pass
        def do_GET(self):
            if self.path.endswith('/pdf-form'):
                self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers()
                self.wfile.write(json.dumps({'originalName':'Ficha preenchida','fields':[{'name':'Nome','type':'text','value':self.server.value}], 'revision':'test','canSave':True}).encode()); return
            if not self.path.startswith(('/UI/','/shared/','/styles.css')):
                self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(html.encode());return
            return super().do_GET()
        def do_POST(self):
            body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            self.server.requests.append((self.path,body))
            if self.path.endswith('/save'):self.server.value=body['values'].get('Nome',self.server.value)
            self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
            self.wfile.write(json.dumps({'content':{'id':'books:renamed' if body.get('name')=='Nome completo' else 'books:copy'},'filename':'Nome completo.pdf'}).encode())
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=directory))
    server.requests=[];server.value='Anterior'
    threading.Thread(target=server.serve_forever,daemon=True).start()
    with sync_playwright() as p:
        for mode,width in [('desktop',1280),('mobile',390),('mobile',320),('linux-app',1280)]:
            browser=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox']+(['--app=about:blank'] if mode=='linux-app' else []))
            page=browser.new_page(viewport={'width':width,'height':844},is_mobile=mode=='mobile',has_touch=mode=='mobile')
            errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{server.server_port}/biblioteca/books/titulo/books%3Acopy/ler?p=2')
            page.get_by_role('button',name='Editar PDF').click()
            expect(page.get_by_role('button',name='Reconhecer cópia antiga')).to_have_count(0)
            field=page.locator('[data-pdf-form-field=Nome]');field.fill('Atualizado')
            with page.expect_navigation():
                page.get_by_role('button',name='Salvar',exact=True).click()
            page.get_by_role('button',name='Editar PDF').click()
            expect(page.locator('[data-pdf-form-field=Nome]')).to_have_value('Atualizado')
            assert server.requests[-1][0].endswith('/save')
            page.get_by_label('Nome da ficha',exact=True).fill('Nome completo')
            page.get_by_role('button',name='Salvar',exact=True).click()
            page.wait_for_url('**/titulo/books%3Arenamed/ler?p=2')
            assert server.requests[-1][1]['name']=='Nome completo'
            page.get_by_role('button',name='Editar PDF').click()
            box=page.locator('.pdf-form-panel').bounding_box()
            assert box['x']>=0 and box['x']+box['width']<=width
            assert not errors,errors
            print('PASS',mode,width,flush=True);browser.close()
    server.shutdown()
