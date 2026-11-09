"""Disposable local server only; verifies document-body editing and PDF persistence."""
import base64, uuid, tempfile
from urllib.parse import quote
from playwright.sync_api import sync_playwright, expect
base='http://127.0.0.1:18099'
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 setup=browser.new_context()
 response=setup.request.post(base+'/api/setup/admin',data={'username':'testadmin','displayName':'Test','email':'test@example.com','password':'isolated-password-123'})
 if response.status!=201:
  assert setup.request.post(base+'/api/login',data={'username':'testadmin','password':'isolated-password-123'}).ok
 library=setup.request.post(base+'/api/libraries',data={'name':'RPG','kind':'other','path':'/fixtures'}).json()['library']
 auth=setup.storage_state()
 for mode,width in [('desktop',1280),('mobile',390),('mobile-small',320),('linux-app',1280)]:
  profile=tempfile.TemporaryDirectory()
  if mode=='linux-app':
   context=p.chromium.launch_persistent_context(profile.name,executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--app=about:blank'],viewport={'width':width,'height':900});context.add_cookies(auth['cookies'])
  else: context=browser.new_context(storage_state=auth,viewport={'width':width,'height':900},is_mobile=mode.startswith('mobile'),has_touch=mode.startswith('mobile'))
  page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  content=library['id']+':'+base64.urlsafe_b64encode(b'Tormenta RPG/Modulo.pdf').decode().rstrip('=')
  def route(cid):return base+f"/biblioteca/{library['id']}/titulo/{quote(cid,safe='')}/ler?p=1"
  page.goto(route(content));page.locator('.pdf-form-toggle:enabled').click(timeout=30000)
  page.get_by_role('button',name='Página no início',exact=True).click()
  body=page.get_by_role('textbox',name='Texto da página',exact=True)
  expect(body).to_be_visible(timeout=30000);expect(body).to_be_focused(timeout=30000)
  body.press_sequentially('Ola mundo')
  body.evaluate("el=>{const r=document.createRange();r.selectNodeContents(el);const s=getSelection();s.removeAllRanges();s.addRange(r);el.dispatchEvent(new KeyboardEvent('keyup'));}")
  page.get_by_role('button',name='Negrito',exact=True).click()
  page.get_by_role('button',name='Sublinhado',exact=True).click()
  page.locator('#pdf-form-style-color').fill('#cc0000');page.locator('#pdf-form-style-color').dispatch_event('change')
  expect(body.locator('span').first).to_have_css('font-weight','700')
  expect(body.locator('span').first).to_have_css('color','rgb(204, 0, 0)')
  body.press('End');body.press('Enter');body.press_sequentially('Segunda linha')
  # Select only the second line and apply a different face and italic.
  body.evaluate("el=>{const n=el.lastChild.firstChild;const r=document.createRange();r.setStart(n,n.textContent.indexOf('Segunda'));r.setEnd(n,n.length);const s=getSelection();s.removeAllRanges();s.addRange(r);el.dispatchEvent(new KeyboardEvent('keyup'));}")
  page.get_by_role('button',name='Itálico',exact=True).click()
  page.locator('#pdf-form-style-font').select_option('times')
  page.locator('#pdf-form-style-size').fill('18');page.locator('#pdf-form-style-size').press('Tab')
  page.get_by_role('button',name='Desfazer',exact=True).click();expect(page.locator('.pdf-form-panel')).to_have_attribute('aria-busy','false',timeout=30000)
  page.get_by_role('button',name='Refazer',exact=True).click();expect(page.locator('.pdf-form-panel')).to_have_attribute('aria-busy','false',timeout=30000)
  expect(body).to_have_text('Ola mundo\nSegunda linha')
  assert body.evaluate('el=>el.scrollHeight<=el.clientHeight+2')
  assert page.locator('.pdf-form-panel').evaluate('el=>el.scrollWidth<=el.clientWidth+1')
  page.locator('.pdf-form-name input').fill('Rich-'+mode+'-'+uuid.uuid4().hex[:8])
  page.screenshot(path='/tmp/pdf-rich-'+mode+'.png')
  with page.expect_response(lambda r:r.url.endswith('/pdf-form/copies')) as saved:page.get_by_role('button',name='Salvar como nova cópia',exact=True).click()
  assert saved.value.status==201,saved.value.text()
  cid=saved.value.json()['content']['id'];endpoint=base+'/api/contents/'+quote(cid,safe='')+'/pdf-form'
  schema=context.request.get(endpoint).json();field=next(f for f in schema['fields'] if f['name'].startswith('pugoti_body_'))
  assert field['value']=='Ola mundo\nSegunda linha',field
  runs=field['style']['runs'];assert runs[0]['bold'] and runs[0]['underline'] and runs[0]['color']=='#cc0000',runs
  assert runs[-1]['italic'] and runs[-1]['font']=='times' and runs[-1]['fontSize']==18,runs
  page.goto(route(cid));page.locator('.pdf-form-toggle:enabled').click(timeout=30000)
  expect(body).to_have_text('Ola mundo\nSegunda linha',timeout=30000)
  expect(body.locator('span').last).to_have_css('font-style','italic')
  body.click();body.press('Control+End');body.press_sequentially('!')
  with page.expect_response(lambda r:r.url.endswith('/pdf-form/save')) as saved:page.get_by_role('button',name='Salvar',exact=True).click()
  assert saved.value.status==200,saved.value.text()
  assert next(f for f in context.request.get(endpoint).json()['fields'] if f['name'].startswith('pugoti_body_'))['value'].endswith('!')
  assert not errors,errors
  expect(page.locator('.pdf-form-panel')).to_be_hidden(timeout=30000)
  print(mode,'OK',flush=True)
  context.close();profile.cleanup()
 browser.close()
