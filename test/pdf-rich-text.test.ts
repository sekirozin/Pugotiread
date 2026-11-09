import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { fillCopyBytes, describePdf } from '../src/server/pdf-forms.js';
import { bodyStyle, formatRuns } from '../src/shared/pdf-rich-text.js';

test('Formatting only changes the selected text and preserves other runs',()=>{
 const runs=formatRuns([{...bodyStyle,text:'Olá mundo'}],4,9,{bold:true,underline:true,color:'#cc0000'});
 assert.equal(runs[0].text,'Olá ');assert.equal(runs[0].bold,undefined);
 assert.equal(runs[1].text,'mundo');assert.equal(runs[1].bold,true);assert.equal(runs[1].underline,true);
});

test('New page body uses margins; rich appearance and editable formatting survive save/reopen',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pdf-rich-'));
 try{
  const doc=await PDFDocument.create();doc.addPage([595,842]);const source=path.join(dir,'source.pdf');const original=await doc.save();await fs.writeFile(source,original);
  const name='pugoti_body_test',edits=[{kind:'insert',position:'start',name}];
  const empty=await PDFDocument.load(await fillCopyBytes(source,{}, {},edits));
  assert.deepEqual(empty.getForm().getTextField(name).acroField.getWidgets()[0].getRectangle(),{x:72,y:72,width:451,height:698});
  const runs=formatRuns([{...bodyStyle,text:'Olá mundo\nSegunda linha'}],4,9,{bold:true,italic:true,underline:true,color:'#cc0000',fontSize:18});
  const bytes=await fillCopyBytes(source,{[name]:runs.map(r=>r.text).join('')},{[name]:{...bodyStyle,alignment:'left',runs}},edits);
  const result=await PDFDocument.load(bytes),field=result.getForm().getTextField(name);
  assert.equal(result.getPageCount(),2);assert.equal(field.getText(),'Olá mundo\nSegunda linha');
  const schema=describePdf(result,'test');assert.equal(schema.fields[0].style?.runs?.[1].bold,true);
  assert.equal(schema.fields[0].style?.runs?.[1].underline,true);
  const stream=field.acroField.getWidgets()[0].getNormalAppearance();
  const raw=result.context.lookup(stream,PDFRawStream);
  const operators=Buffer.from(decodePDFRawStream(raw).decode()).toString();
  assert.match(operators,/Helvetica-BoldOblique/);assert.match(operators,/0\.8 0 0 rg/);assert.match(operators,/\nS\n/);
  assert.ok(raw.dict.get(PDFName.of('Resources')));
  const saved=path.join(dir,'saved.pdf');await fs.writeFile(saved,bytes);
  const again=await PDFDocument.load(await fillCopyBytes(saved,{},{}));
  assert.deepEqual(describePdf(again,'test').fields[0].style?.runs,schema.fields[0].style?.runs);
  assert.deepEqual(await fs.readFile(source),Buffer.from(original));
  await assert.rejects(fillCopyBytes(source,{[name]:'oops'},{[name]:{...bodyStyle,alignment:'left',runs}},edits),/não correspondem/);
  const long='Linha\n'.repeat(100);
  await assert.rejects(fillCopyBytes(source,{[name]:long},{[name]:{...bodyStyle,alignment:'left',runs:[{...bodyStyle,text:long}]}},edits),/ultrapassa/);
  const deleted=await PDFDocument.load(await fillCopyBytes(source,{}, {},[...edits,{kind:'delete',page:1}]));
  assert.equal(deleted.getForm().getFields().length,0);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
