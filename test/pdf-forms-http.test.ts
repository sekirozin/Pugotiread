import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { PDFDocument } from "pdf-lib";

test("HTTP: authenticated form filling, immediate library listing, denied access, original preserved", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-form-http-"));
  const media = path.join(root, "media"); await fs.mkdir(media);
  const document = await PDFDocument.create(); const page = document.addPage();
  document.getForm().createTextField("Nome").addToPage(page, { x: 40, y: 600, width: 240, height: 30 });
  const original = await document.save(); await fs.writeFile(path.join(media, "Ficha.pdf"), original);
  const reservation = net.createServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as net.AddressInfo).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...process.env,
    PORT: String(port), DB_FILE: path.join(root,"store.db"), DATA_FILE: path.join(root,"store.json"),
    CACHE_DIR: path.join(root,"cache"), LIBRARY_CACHE_DB_FILE: path.join(root,"library-cache.db"),
    MEDIA_ROOT: media, VAULT_MEDIA_ROOT: path.join(root,"vault"), SESSION_SECRET: "isolated-test-only", PUGOTILAB_PROFILE_URL: "http://127.0.0.1:1"
  }, stdio: ["ignore","pipe","pipe"] });
  let logs = ""; server.stdout.on("data", data => logs += data); server.stderr.on("data", data => logs += data);
  const base = `http://127.0.0.1:${port}`;
  const request = (url: string, cookie = "", body?: unknown) => fetch(base + url, {
    method: body === undefined ? "GET" : "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 600; attempt++) {
      if (await fetch(base + "/health").then(r => r.ok).catch(() => false)) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, logs);
    const setup = await request("/api/setup/admin", "", { username: "testadmin", displayName: "Test", email: "test@example.com", password: "isolated-password-123" });
    assert.equal(setup.status, 201, await setup.text()); const admin = setup.headers.get("set-cookie")!.split(";")[0];
    const created = await request("/api/libraries", admin, { name: "RPG", kind: "other", path: media });
    const payload = await created.json() as any; assert.equal(created.status, 201, JSON.stringify(payload));
    const library = payload.library;
    const id = `${library.id}:${Buffer.from("Ficha.pdf").toString("base64url")}`;
    const endpoint = `/api/contents/${encodeURIComponent(id)}/pdf-form`;
    assert.equal((await request(endpoint)).status, 401);
    const metadata = await request(endpoint, admin); assert.equal(metadata.status, 200);
    const initialSchema = await metadata.json() as any;
    assert.equal(initialSchema.fields[0].name, "Nome");
    const edits = [{ kind: 'insert', position: 'end' }, { kind: 'text', page: 2, name: 'pugoti_text_http', rect: [40, 600, 200, 70] }];
    const previewResponse = await request(endpoint + '/preview', admin, { revision: initialSchema.revision, values: { pugoti_text_http: 'Teste' }, edits });
    assert.equal(previewResponse.status, 200, await previewResponse.clone().text());
    const preview = await previewResponse.json() as any;
    assert.equal(preview.schema.pageCount, 2);
    assert.equal((await PDFDocument.load(Buffer.from(preview.pdf, 'base64'))).getForm().getTextField('pugoti_text_http').getText(), 'Teste');
    assert.deepEqual(await fs.readFile(path.join(media, 'Ficha.pdf')), Buffer.from(original));
    assert.equal((await request(endpoint + '/preview', admin, { revision: 'stale', values: {}, edits })).status, 400);
    assert.equal((await request(endpoint + '/preview', '', { revision: initialSchema.revision, values: {}, edits })).status, 401);
    const saved = await request(endpoint + "/copies", admin, { name: "Enrick", values: { Nome: "Enrick" }, styles: { Nome: { font: "courier", fontSize: 12, color: "#14532d", alignment: "right" } } });
    const result = await saved.json() as any; assert.equal(saved.status, 201, JSON.stringify(result));
    assert.equal(result.filename, "Fichas/Enrick.pdf"); assert.ok(result.content?.id);
    const listing = await (await request(`/api/libraries/${library.id}/contents`, admin)).json() as any;
    assert.ok(listing.contents.some((item: any) => item.id === result.content.id));
    const opened = await request(`/api/contents/${encodeURIComponent(result.content.id)}/pages/0`, admin);
    const savedDocument = await PDFDocument.load(await opened.arrayBuffer());
    assert.equal(savedDocument.getForm().getTextField("Nome").getText(), "Enrick");
    assert.match(savedDocument.getForm().getTextField("Nome").acroField.getDefaultAppearance() ?? "", /Courier 12 Tf/);
    assert.deepEqual(await fs.readFile(path.join(media,"Ficha.pdf")), Buffer.from(original));
    const copyEndpoint=`/api/contents/${encodeURIComponent(result.content.id)}/pdf-form`;
    const copySchema=await (await request(copyEndpoint,admin)).json() as any;
    assert.equal((await request('/api/bookmarks',admin,{contentId:result.content.id,page:0})).status,200);
    const profile=await fetch(base+'/api/me/profile',{method:'PATCH',headers:{Cookie:admin,'Content-Type':'application/json'},body:JSON.stringify({favoriteContentIds:[result.content.id]})});
    assert.equal(profile.status,200,await profile.text());
    const collectionResult=await request('/api/collections',admin,{name:'Fichas'});
    const collectionBody=await collectionResult.json() as any;
    assert.equal(collectionResult.status,201,JSON.stringify(collectionBody));
    await request(`/api/collections/${collectionBody.collection.id}/contents`,admin,{contentId:result.content.id});
    assert.equal(copySchema.canSave,true);
    const originalSchema=await (await request(endpoint,admin)).json() as any;
    assert.equal(originalSchema.canSave,true);
    const changed=await request(copyEndpoint+'/save',admin,{revision:copySchema.revision,values:{Nome:'Enrick atualizado'}});
    assert.equal(changed.status,200,await changed.clone().text());
    const changedBody=await changed.json() as any;
    assert.equal(changedBody.content.id,result.content.id);
    assert.equal((await fs.readdir(media,{recursive:true})).filter(name=>name.endsWith('.pdf') && !name.split(path.sep).some(part=>part.startsWith('.'))).length,2);
    assert.equal((await PDFDocument.load(await fs.readFile(path.join(media,'Fichas/Enrick.pdf')))).getForm().getTextField('Nome').getText(),'Enrick atualizado');
    assert.equal((await request(copyEndpoint+'/save',admin,{revision:copySchema.revision,values:{Nome:'Obsoleto'}})).status,400);
    const renamed=await request(copyEndpoint+'/save',admin,{revision:changedBody.revision,name:'Herói de Arton',values:{Nome:'Herói'}});
    assert.equal(renamed.status,200,await renamed.clone().text());
    const renamedBody=await renamed.json() as any;
    assert.equal(renamedBody.filename,'Fichas/Herói de Arton.pdf');
    assert.equal((await PDFDocument.load(await fs.readFile(path.join(media,'Fichas/Herói de Arton.pdf')))).getForm().getTextField('Nome').getText(),'Herói');
    const me=await (await request('/api/me',admin)).json() as any;
    assert.ok(me.user.favoriteContentIds.includes(renamedBody.content.id));
    const marks=await (await request('/api/bookmarks',admin)).json() as any;
    assert.ok(marks.bookmarks.some((b:any)=>b.contentId===renamedBody.content.id));
    const lists=await (await request('/api/user-lists',admin)).json() as any;
    assert.ok(lists.collections.some((c:any)=>c.contentIds.includes(renamedBody.content.id)));
    assert.equal(await fs.stat(path.join(media,'Fichas/Enrick.pdf')).then(()=>true,()=>false),false);
    const newEndpoint=`/api/contents/${encodeURIComponent(renamedBody.content.id)}/pdf-form`;
    assert.equal(((await (await request(newEndpoint,admin)).json()) as any).canSave,true);
    await fs.writeFile(path.join(media,'Fichas/Ficha.pdf'),original);
    assert.equal((await request(newEndpoint+'/rename',admin,{revision:renamedBody.revision,name:'Ficha'})).status,400);
    assert.equal((await request(newEndpoint+'/save',admin,{revision:renamedBody.revision,name:'Ficha',values:{Nome:'Não salvar'}})).status,400);
    assert.equal((await PDFDocument.load(await fs.readFile(path.join(media,'Fichas/Herói de Arton.pdf')))).getForm().getTextField('Nome').getText(),'Herói');
    assert.deepEqual(await fs.readFile(path.join(media,'Ficha.pdf')),Buffer.from(original));
    await fs.unlink(path.join(media,'Fichas/Ficha.pdf'));
    await fs.copyFile(path.join(media,'Fichas/Herói de Arton.pdf'),path.join(media,'Ficha antiga.pdf'));
    await request(`/api/libraries/${library.id}/scan`,admin,{});
    const legacyId=`${library.id}:${Buffer.from('Ficha antiga.pdf').toString('base64url')}`;
    const legacyEndpoint=`/api/contents/${encodeURIComponent(legacyId)}/pdf-form`;
    const legacySchema=await (await request(legacyEndpoint,admin)).json() as any;
    assert.equal(legacySchema.canSave,true);
    assert.equal((await request(legacyEndpoint+'/save',admin,{values:{Nome:'Antiga atualizada'},revision:legacySchema.revision})).status,200);
    assert.equal(((await (await request(legacyEndpoint,admin)).json()) as any).canSave,true);
    const user = await request("/api/admin/users", admin, { username: "blocked", displayName: "Blocked", email: "blocked@example.com", password: "isolated-password-123", role: "user", allowedLibraryIds: [library.id] });
    assert.equal(user.status, 201, await user.text());
    const login = await request("/api/login", "", { username: "blocked", password: "isolated-password-123" });
    assert.equal(login.status, 200, await login.text()); const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const patchSettings = (body: unknown, session = admin) => fetch(base + "/api/admin/settings", {
      method: "PATCH", headers: { Cookie: session, "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    const adminId = ((await (await request("/api/me", admin)).json()) as any).user.id;
    const blockedId = ((await (await request("/api/me", cookie)).json()) as any).user.id;
    assert.equal((await request("/api/me/startup")).status, 401);
    assert.equal((await patchSettings({ startupLibraries: { [adminId]: library.id } }, cookie)).status, 403);
    assert.equal((await patchSettings({ startupLibraries: { [blockedId]: library.id } })).status, 200);
    assert.equal((await patchSettings({ startupLibraries: { [adminId]: "missing" } })).status, 400);
    assert.equal((await patchSettings({ startupLibraries: { [adminId]: library.id } })).status, 200);
    await patchSettings({ vaultTimeoutMinutes: 8 });
    assert.deepEqual(await (await request("/api/me/startup", admin)).json(), { libraryId: library.id });
    assert.deepEqual(await (await request("/api/me/startup", cookie)).json(), { libraryId: library.id });
    assert.equal((await patchSettings({ startupLibraries: { [adminId]: "" } })).status, 200);
    assert.deepEqual(await (await request("/api/me/startup", admin)).json(), { libraryId: null });
    assert.equal((await request(endpoint, cookie)).status, 200, "o modelo original continua acessível");
    assert.equal((await request(newEndpoint, cookie)).status, 404, "a ficha preenchida é privada ao criador");
    const userListing = await (await request(`/api/libraries/${library.id}/contents`, cookie)).json() as any;
    assert.ok(!userListing.contents.some((item:any) => item.id === renamedBody.content.id));
    const accessUpdate = await fetch(base + `/api/admin/pdf-form-copies/${encodeURIComponent(renamedBody.content.id)}`, {
      method: "PATCH", headers: { Cookie: admin, "Content-Type": "application/json" },
      body: JSON.stringify({ ownerUserId: adminId, visibility: "shared", sharedWithUserIds: [blockedId], system: "Tormenta Clássico" })
    });
    assert.equal(accessUpdate.status, 200, await accessUpdate.text());
    assert.equal((await request(newEndpoint, cookie)).status, 200, "o administrador pode compartilhar a ficha");
    assert.equal((await request(endpoint + "/copies", cookie, { values: { Nome: "Ficha do usuário" } })).status, 201);
    assert.equal((await fs.readdir(media,{recursive:true})).filter(file => file.endsWith(".pdf") && !file.split(path.sep).some(part=>part.startsWith('.'))).length, 4);
  } finally {
    server.kill(); await new Promise(resolve => server.once("exit", resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
