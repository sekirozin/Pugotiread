"""Real server/PDF.js editing in desktop, mobile and Linux app mode.
Requires a disposable server at PDF_TEST_URL with a blank database and /fixtures media.
"""
import base64, os, tempfile
from urllib.parse import quote
from playwright.sync_api import sync_playwright, expect

base = os.environ.get('PDF_TEST_URL', 'http://127.0.0.1:18099')
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    setup = browser.new_context()
    response = setup.request.post(base + '/api/setup/admin', data={
        'username': 'testadmin', 'displayName': 'Test', 'email': 'test@example.com', 'password': 'isolated-password-123'})
    if response.status != 201:
        response = setup.request.post(base + '/api/login', data={'username':'testadmin','password':'isolated-password-123'})
        assert response.ok, response.text()
    library = setup.request.post(base + '/api/libraries', data={'name': 'RPG', 'kind': 'other', 'path': '/fixtures'}).json()['library']
    auth = setup.storage_state()
    for mode, width in [('desktop',1280), ('mobile',390), ('mobile-small',320), ('linux-app',1280)]:
        profile = tempfile.TemporaryDirectory()
        if mode == 'linux-app':
            context = p.chromium.launch_persistent_context(profile.name, executable_path='/usr/bin/chromium', headless=True,
                args=['--no-sandbox', '--app=about:blank'], viewport={'width':width,'height':900})
            context.add_cookies(auth['cookies'])
        else:
            context = browser.new_context(storage_state=auth, viewport={'width':width,'height':900},
                                          is_mobile=mode.startswith('mobile'), has_touch=mode.startswith('mobile'))
        # randomUUID is unavailable over plain HTTP on LAN IP addresses.
        context.add_init_script("Object.defineProperty(crypto, 'randomUUID', {value: undefined})")
        page = context.new_page(); errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
        content = library['id'] + ':' + base64.urlsafe_b64encode(b'Ficha.pdf').decode().rstrip('=')
        route = f"/biblioteca/{library['id']}/titulo/{quote(content, safe='')}/ler?p=1"
        page.goto(base + route)
        page.locator('.pdf-form-toggle:enabled').click(timeout=30000)
        page.get_by_role('button', name='Página no início', exact=True).click()
        expect(page.locator('.pdf-page')).to_have_count(3, timeout=30000)
        page.get_by_role('button', name='Texto', exact=True).click()
        canvas = page.locator('.pdf-page').first
        page.locator('.pdf-page canvas').first.wait_for()
        bounds = canvas.bounding_box()
        page.mouse.click(bounds['x'] + bounds['width']*.15, bounds['y'] + min(bounds['height']*.4, 180))
        text = page.locator('textarea[data-pdf-form-field^="pugoti_text_"]')
        expect(text).to_be_visible(timeout=30000)
        expect(text).to_be_focused(timeout=30000)
        text.fill('Olá mundo!\nFicha de RPG')
        text.press('Control+z')
        expect(page.locator('.pdf-form-panel')).to_have_attribute('aria-busy', 'false', timeout=30000)
        expect(text).to_have_value('', timeout=30000)
        text.press('Control+Shift+z')
        expect(page.locator('.pdf-form-panel')).to_have_attribute('aria-busy', 'false', timeout=30000)
        expect(text).to_have_value('Olá mundo!\nFicha de RPG', timeout=30000)
        text.click()
        page.locator('#pdf-form-style-font').select_option('courier')
        page.locator('#pdf-form-style-size').fill('18'); page.locator('#pdf-form-style-size').press('Tab')
        page.locator('#pdf-form-style-color').fill('#227744'); page.locator('#pdf-form-style-color').dispatch_event('change')
        page.get_by_role('button', name='Centralizar', exact=True).click()
        page.get_by_role('button', name='Desfazer', exact=True).click()
        expect(text).to_have_css('text-align', 'left', timeout=30000)
        page.get_by_role('button', name='Refazer', exact=True).click()
        expect(text).to_have_css('text-align', 'center', timeout=30000)
        page.get_by_role('button', name='Página no fim', exact=True).click()
        expect(page.locator('.pdf-page')).to_have_count(4, timeout=30000)
        accept_dialog = lambda dialog: dialog.accept()
        page.on('dialog', accept_dialog)
        page.get_by_role('button', name='Excluir página', exact=True).click()
        expect(page.locator('.pdf-page')).to_have_count(3, timeout=30000)
        page.get_by_role('button', name='Desfazer', exact=True).click()
        expect(page.locator('.pdf-page')).to_have_count(4, timeout=30000)
        page.get_by_role('button', name='Refazer', exact=True).click()
        expect(page.locator('.pdf-page')).to_have_count(3, timeout=30000)
        page.locator('.pdf-form-name input').fill('Edited-' + mode)
        page.screenshot(path='/tmp/pdf-editor-' + mode + '.png')
        assert page.locator('.pdf-form-panel').evaluate('(el)=>el.scrollWidth<=el.clientWidth+1')
        with page.expect_response(lambda response: response.url.endswith('/pdf-form/copies')) as saved:
            page.get_by_role('button', name='Salvar como nova cópia', exact=True).click()
        assert saved.value.status == 201, saved.value.text()
        saved_id = saved.value.json()['content']['id']
        endpoint = base + '/api/contents/' + quote(saved_id, safe='') + '/pdf-form'
        schema = context.request.get(endpoint).json()
        assert schema['pageCount'] == 3, schema
        field = next(f for f in schema['fields'] if f['name'].startswith('pugoti_text_'))
        assert field['value'] == 'Olá mundo!\nFicha de RPG', field
        assert field['style'] == {'font':'courier','fontSize':18,'color':'#227744','alignment':'center'}, field
        assert context.request.get(base + '/api/contents/' + quote(content, safe='') + '/pdf-form').json()['pageCount'] == 2
        page.goto(base + f"/biblioteca/{library['id']}/titulo/{quote(saved_id, safe='')}/ler?p=1")
        page.locator('.pdf-form-toggle:enabled').click(timeout=30000)
        updated_text = page.locator('textarea[data-pdf-form-field^="pugoti_text_"]')
        updated_text.fill('Atualizado sem criar outra cópia')
        with page.expect_response(lambda response: response.url.endswith('/pdf-form/save')) as updated:
            page.get_by_role('button', name='Salvar', exact=True).click()
        assert updated.value.status == 200, updated.value.text()
        final_schema = context.request.get(endpoint).json()
        assert final_schema['pageCount'] == 3
        assert next(f for f in final_schema['fields'] if f['name'].startswith('pugoti_text_'))['value'] == 'Atualizado sem criar outra cópia'
        assert not errors, errors
        expect(page.locator('.pdf-form-panel')).to_be_hidden(timeout=30000)
        page.remove_listener('dialog', accept_dialog)
        context.close(); profile.cleanup(); print(mode, 'OK', flush=True)
    browser.close()
