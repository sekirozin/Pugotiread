import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pqa-reading-settings-'));
const port = 18749;
const child = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), DB_FILE: `${dir}/db.sqlite`, DATA_FILE: `${dir}/data.json`, LIBRARY_CACHE_DB_FILE: `${dir}/cache.db`, CACHE_DIR: `${dir}/cache`, MEDIA_ROOT: `${dir}/media`, VAULT_MEDIA_ROOT: `${dir}/vault`, SESSION_SECRET: 'isolated-qa-reading-settings', PUGOTILAB_PROFILE_URL: 'http://127.0.0.1:1' }, stdio: ['ignore','ignore','pipe'] });
let stderr = ''; child.stderr.on('data', chunk => stderr += chunk);
const base = `http://127.0.0.1:${port}`;
async function request(url, method = 'GET', cookie = '', body) {
 return fetch(base + url, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
}
try {
 let ready = false;
 for (let i = 0; i < 100; i++) {
  if (child.exitCode !== null) throw Error(stderr);
  if (await fetch(base+'/health').then(r=>r.ok).catch(()=>false)) {ready=true;break;}
  await new Promise(r=>setTimeout(r,100));
 }
 assert.ok(ready, 'servidor isolado pronto');
 assert.equal((await request('/api/me/reading-settings')).status, 401);
 const setup = await request('/api/setup/admin', 'POST', '', { username:'qa-admin', displayName:'QA', email:'qa@example.test', password:'fixture-password-123' });
 assert.equal(setup.status,201);
 const cookie = setup.headers.get('set-cookie').split(';')[0];
 const initial = await (await request('/api/me/reading-settings','GET',cookie)).json();
 assert.deepEqual(Object.keys(initial), ['readingDefaults'], 'não expõe configurações privadas');
 assert.equal(initial.readingDefaults.book.mode,'horizontal');
 assert.equal(initial.readingDefaults.lightNovel.mode,'horizontal');
 initial.readingDefaults.book.mode='vertical-scroll';
 initial.readingDefaults.book.controlsVisible=false;
 assert.equal((await request('/api/admin/settings','PATCH',cookie,initial)).status,200);
 const saved = await (await request('/api/me/reading-settings','GET',cookie)).json();
 assert.equal(saved.readingDefaults.book.mode,'vertical-scroll');
 assert.equal(saved.readingDefaults.book.controlsVisible,false);
 const account = { username:'qa-reader', displayName:'Leitor QA', email:'reader@example.test', password:'fixture-password-123', role:'user', allowedLibraryIds:[], canLogin:true, canDownload:true, canChangePassword:true };
 assert.equal((await request('/api/admin/users','POST',cookie,account)).status,201);
 const login = await request('/api/login','POST','',account);
 assert.equal(login.status,200);
 const readerCookie = login.headers.get('set-cookie').split(';')[0];
 const reader = await request('/api/me/reading-settings','GET',readerCookie);
 assert.equal(reader.status,200);
 assert.deepEqual(await reader.json(), saved);
 assert.equal((await request('/api/admin/settings','GET',readerCookie)).status,403);
 console.log('PASS PugotiQA HTTP: autenticação, privacidade, padrão Páginas e persistência das preferências');
} finally {
 if(child.exitCode===null) { child.kill('SIGTERM'); await new Promise(resolve=>child.once('exit',resolve)); }
 await fs.rm(dir,{recursive:true,force:true});
}
