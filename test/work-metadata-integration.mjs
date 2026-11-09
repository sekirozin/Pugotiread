import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'pqa-work-metadata-'));
process.env.CACHE_DIR=path.join(root,'cache');process.env.LIBRARY_CACHE_DB_FILE=path.join(root,'cache.db');
try {
 const dir=path.join(root,'media','Fixture');await fs.mkdir(path.join(dir,'Cap. 01'),{recursive:true});
 await fs.writeFile(path.join(dir,'Cap. 01','001.jpg'),Buffer.from([255,216,255,217]));
 await fs.writeFile(path.join(dir,'metadata.json'),'\ufeff'+JSON.stringify({title:'Obra finalizada',description:'Sinopse completa',status:'Completo',rating:'4.8/5'}));
 const {scanLibrary}=await import('../dist/server/media.js');
 const library={id:'qa',name:'QA',kind:'manga',path:path.join(root,'media')};
 const [content]=await scanLibrary(library,{refresh:true});
 assert.equal(content.publicationStatus,'Completo');assert.equal(content.rating,'4.8/5');assert.equal(content.description,'Sinopse completa');assert.equal(content.chapterCount,1);assert.equal(content.pageCount,1);
 await fs.writeFile(path.join(dir,'metadata.json'),JSON.stringify({title:'Fixture',rating:'357',status:'hiatus'}));
 const [updated]=await scanLibrary(library,{refresh:true});assert.equal(updated.rating,null);assert.equal(updated.publicationStatus,'hiatus');
 console.log('PASS PugotiQA: scanner real lê BOM, status, sinopse, contagens e rejeita votos como nota');
} finally {await fs.rm(root,{recursive:true,force:true});}
