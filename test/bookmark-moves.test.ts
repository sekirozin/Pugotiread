import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {PDFDocument} from 'pdf-lib';

test('Bookmarks follow ordinary PDF moves on the first request, preserve pages/names, and enforce access',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'bookmark-move-')),media=path.join(root,'media');await fs.mkdir(media);
 const pdf=await PDFDocument.create();pdf.addPage();pdf.addPage();const bytes=await pdf.save();await fs.writeFile(path.join(media,'Book.pdf'),bytes);
 const socket=net.createServer();await new Promise<void>(r=>socket.listen(0,'127.0.0.1',r));const port=(socket.address() as net.AddressInfo).port;await new Promise<void>(r=>socket.close(()=>r()));
 const server=spawn(process.execPath,['dist/server/index.js'],{env:{...process.env,PORT:String(port),DB_FILE:path.join(root,'store.db'),DATA_FILE:path.join(root,'data.json'),LIBRARY_CACHE_DB_FILE:path.join(root,'cache.db'),CACHE_DIR:path.join(root,'cache'),MEDIA_ROOT:media,VAULT_MEDIA_ROOT:path.join(root,'vault'),SESSION_SECRET:'isolated-bookmark-test',PUGOTILAB_PROFILE_URL:'http://127.0.0.1:1'},stdio:'pipe'});
 let logs='';server.stdout.on('data',b=>logs+=b);server.stderr.on('data',b=>logs+=b);
 const base=`http://127.0.0.1:${port}`;
 const req=(url:string,cookie='',body?:unknown,method=body?'POST':'GET')=>fetch(base+url,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 try{
  for(let i=0;i<100;i++){if(await fetch(base+'/health').then(r=>r.ok).catch(()=>false))break;await new Promise(r=>setTimeout(r,100));}
  const setup=await req('/api/setup/admin','',{username:'admin',displayName:'Admin',email:'admin@example.com',password:'isolated-password-123'});assert.equal(setup.status,201,logs);const admin=setup.headers.get('set-cookie')!.split(';')[0];
  const lib=(await (await req('/api/libraries',admin,{name:'RPG',kind:'other',path:media})).json() as any).library;
  const id=(name:string)=>lib.id+':'+Buffer.from(name).toString('base64url');
  const original=id('Book.pdf');
  for(const page of [0,1]){assert.equal((await req('/api/bookmarks',admin,{contentId:original,page})).status,200);assert.equal((await req('/api/bookmarks',admin,{contentId:original,page,name:'Saved '+page},'PATCH')).status,200);}
  await fs.mkdir(path.join(media,'System'));await fs.rename(path.join(media,'Book.pdf'),path.join(media,'System/Book.pdf'));
  let payload=await (await req('/api/bookmarks?includeContents=1',admin)).json() as any;
  assert.equal(payload.bookmarks.length,2);assert.equal(payload.contents[0].id,id('System/Book.pdf'));
  assert.deepEqual(payload.bookmarks.map((b:any)=>[b.contentId,b.page,b.name]),[[id('System/Book.pdf'),0,'Saved 0'],[id('System/Book.pdf'),1,'Saved 1']]);
  assert.equal((await req('/api/contents/'+encodeURIComponent(payload.contents[0].id)+'/pages/0',admin)).status,200);
  // A second rename is also tracked, without relying on matching filenames.
  await fs.rename(path.join(media,'System/Book.pdf'),path.join(media,'System/Renamed.pdf'));
  payload=await (await req('/api/bookmarks?includeContents=1',admin)).json() as any;
  assert.equal(payload.bookmarks[0].contentId,id('System/Renamed.pdf'));
  // Private sheets never become accessible through the bookmarked-pages endpoint.
  await req('/api/admin/users',admin,{username:'reader',displayName:'Reader',email:'reader@example.com',password:'isolated-password-123',role:'user',allowedLibraryIds:[lib.id]});
  const login=await req('/api/login','',{username:'reader',password:'isolated-password-123'});const reader=login.headers.get('set-cookie')!.split(';')[0];
  const current=id('System/Renamed.pdf');assert.equal((await req('/api/bookmarks',reader,{contentId:current,page:0})).status,200);
  const owner=(await (await req('/api/me',admin)).json() as any).user.id;
  assert.equal((await req('/api/contents/'+encodeURIComponent(current)+'/rpg',admin,{role:'sheet',ownerUserId:owner,visibility:'private'},'PATCH')).status,200);
  const denied=await (await req('/api/bookmarks?includeContents=1',reader)).json() as any;assert.deepEqual(denied.bookmarks,[]);assert.deepEqual(denied.contents,[]);
  // A different file with the same name is not guessed as a replacement.
  await fs.rm(path.join(media,'System/Renamed.pdf'));await fs.writeFile(path.join(media,'Book.pdf'),bytes);
  payload=await (await req('/api/bookmarks?includeContents=1',admin)).json() as any;assert.deepEqual(payload.bookmarks,[]);
  const retained=await (await req('/api/bookmarks',admin)).json() as any;assert.equal(retained.bookmarks.length,2);
 }finally{server.kill('SIGTERM');await new Promise<void>(r=>server.once('exit',()=>r()));await fs.rm(root,{recursive:true,force:true});}
});
