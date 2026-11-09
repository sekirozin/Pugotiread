"""Real disposable backend, /fixtures containing RPG PDFs; never use production."""
import os
import re
import base64
import uuid
from urllib.parse import quote
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('RPG_TEST_URL', 'http://127.0.0.1:18099')
assert BASE.startswith('http://127.0.0.1:'), 'Only disposable local servers'

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    context = browser.new_context(base_url=BASE, viewport={'width':1280,'height':900})
    api = context.request
    setup = api.post('/api/setup/admin',data={'username':'browseradmin','displayName':'Admin','email':'browser@example.com','password':'test-password-123'})
    if setup.status != 201:
        assert api.post('/api/login',data={'username':'browseradmin','password':'test-password-123'}).ok
    libs = api.get('/api/libraries').json()['libraries']
    library = libs[0] if libs else api.post('/api/libraries',data={'name':'RPG','kind':'other','path':'/fixtures'}).json()['library']
    lib = library['id']
    def cid(name): return lib+':'+base64.urlsafe_b64encode(name.encode()).decode().rstrip('=')
    def title(id): return '/biblioteca/'+lib+'/titulo/'+quote(id,safe='')
    template = cid('Tormenta RPG/Fichas/Modelo.pdf')
    module = cid('Tormenta RPG/Modulo.pdf')
    page = context.new_page()
    errors=[]
    page.on('pageerror',lambda error: errors.append(str(error)))
    page.goto(BASE+title(template))
    props=page.locator('.rpg-properties')
    props.locator('summary').click()
    props.locator('[name=role]').select_option('template')
    props.get_by_role('button',name='Salvar propriedades').click()
    expect(page.locator('[data-rpg-status]')).to_have_text('Propriedades salvas.')
    page.goto(BASE+title(module))
    props=page.locator('.rpg-properties');props.locator('summary').click()
    props.locator('[name=role]').select_option('module')
    props.locator('[name=templateIds]').check()
    props.get_by_role('button',name='Salvar propriedades').click()
    expect(page.get_by_role('heading',name='Fichas deste módulo')).to_be_visible()
    character='Personagem navegador '+uuid.uuid4().hex[:8]
    page.once('dialog',lambda dialog: dialog.accept(character))
    page.get_by_role('button',name='Criar minha ficha',exact=True).click()
    page.wait_for_url(re.compile('/ler\\?p=1'))
    sheet_url=page.url.split('/ler?')[0]
    expect(page.locator('.pdf-form-toggle')).to_be_enabled(timeout=30000)
    page.locator('.pdf-form-toggle').click()
    expect(page.locator('[data-pdf-form-field=Nome]')).to_be_visible()
    page.locator('[data-pdf-form-field=Nome]').fill('Personagem teste')
    page.get_by_role('button',name='Salvar',exact=True).click()
    expect(page.locator('.pdf-form-panel')).to_be_hidden(timeout=30000)
    page.goto(BASE+title(module))
    expect(page.locator('.rpg-related').filter(has=page.get_by_role('heading',name='Minhas fichas')).get_by_role('link',name=character,exact=True)).to_be_visible()
    page.goto(BASE+title(cid('Avatar Legends/Modulo.pdf')))
    props=page.locator('.rpg-properties');props.locator('summary').click()
    if props.locator('[name=role]').count():
        props.locator('[name=role]').select_option('sheet')
        props.locator('[data-rpg-sheet] [name=ownerUserId]').select_option(index=1)
        props.get_by_role('button',name='Salvar propriedades').click()
        expect(props.locator('summary')).to_have_text('Propriedade e compartilhamento da ficha')
    # Folder tabs, nested folders, deep links and browser history, desktop + touch widths.
    for width in [1280,390,320]:
        page.set_viewport_size({'width':width,'height':900})
        page.goto(sheet_url)
        expect(page.locator('.pdf-document-detail')).to_be_visible()
        expect(page.locator('.series-tabs')).to_have_count(0)
        expect(page.locator('.series-detail-stats')).to_have_count(0)
        expect(page.locator('.rpg-access-summary')).to_contain_text('Ficha privada')
        expect(page.get_by_role('button',name='Abrir ficha',exact=True)).to_be_visible()
        expect(page.get_by_role('heading',name='Páginas marcadas')).to_be_visible()
        page.locator('.rpg-properties summary').click()
        page.locator('[name=visibility]').select_option('shared')
        expect(page.locator('[data-rpg-sharing]')).to_be_visible()
        page.locator('[name=visibility]').select_option('private')
        expect(page.locator('[data-rpg-sharing]')).to_be_hidden()
        page.locator('.rpg-properties summary').click()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'PDF overflow at {width}'
        page.screenshot(path=f'artifacts/pdf-details-{width}.png',full_page=True)
        page.goto(BASE+'/biblioteca/'+lib)
        tabs=page.locator('.library-system-tabs')
        expect(tabs).to_be_visible()
        expect(page.locator('.library-heading')).to_contain_text('materiais')
        tabs.get_by_role('link',name='Tormenta RPG',exact=True).click()
        expect(page).to_have_url(re.compile('pasta=Tormenta'))
        page.locator('.library-subfolders').get_by_role('link',name='Fichas').click()
        expect(page.locator('.library-breadcrumbs')).to_contain_text('Fichas')
        url=page.url;page.reload();expect(page).to_have_url(url)
        expect(page.locator('.library-breadcrumbs')).to_contain_text('Fichas')
        page.go_back();expect(page.locator('.library-subfolders').get_by_role('link',name='Fichas')).to_be_visible()
        page.go_forward();expect(page.locator('.library-breadcrumbs')).to_contain_text('Fichas')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'Overflow at {width}'
        page.screenshot(path=f'artifacts/rpg-folders-{width}.png',full_page=True)
    assert not errors, errors
    context.close();browser.close()
    # Actual Chromium app window, sharing the same account cookies.
    import tempfile
    with tempfile.TemporaryDirectory(prefix='rpg-app-') as profile:
        app=p.chromium.launch_persistent_context(profile,executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--app=about:blank'],viewport={'width':1280,'height':900},base_url=BASE)
        assert app.request.post('/api/login',data={'username':'browseradmin','password':'test-password-123'}).ok
        page=app.pages[0];page.goto(BASE+'/biblioteca/'+lib+'?pasta=Tormenta%20RPG%2FFichas')
        expect(page.locator('.library-breadcrumbs')).to_contain_text('Fichas')
        page.goto(BASE+title(template)+'/ler?p=1')
        expect(page.locator('.pdf-form-toggle')).to_be_enabled(timeout=30000)
        page.locator('.pdf-form-toggle').click()
        expect(page.locator('.pdf-form-editor-note')).to_contain_text('Modelo original preservado')
        app.close()
    print('RPG browser: admin properties, personal creation/save, folders/history, 1280/390/320, Linux app OK')
