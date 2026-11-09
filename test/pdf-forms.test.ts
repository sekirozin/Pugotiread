import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PDFDocument, degrees } from "pdf-lib";
import { describeForm, fillCopyBytes, copyName, publishCopy } from "../src/server/pdf-forms.js";

test('personal-copy publication removes the file when registering ownership fails',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'forms-register-'));
  try{
    await assert.rejects(publishCopy(directory,'Private',new Uint8Array([1,2,3]),()=>{throw new Error('database unavailable');}),/database unavailable/);
    assert.deepEqual(await fs.readdir(directory),[]);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test("AcroForm: filled copies retain fields, layout and pages; original bytes and blank values stay intact", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forms-test-"));
  try {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]); doc.addPage([400, 500]).setRotation(degrees(90));
    page.drawText("Ficha de RPG");
    const form = doc.getForm();
    const name = form.createTextField("Nome"); name.addToPage(page, { x: 60, y: 650, width: 240, height: 30 });
    const check = form.createCheckBox("Treinado"); check.addToPage(page, { x: 60, y: 600 });
    const choice = form.createDropdown("Classe"); choice.addOptions(["Guerreiro", "Mago"]); choice.addToPage(page, { x: 60, y: 550 });
    const radio = form.createRadioGroup("Origem"); radio.addOptionToPage("Humano", page, { x: 60, y: 500 }); radio.addOptionToPage("Elfo", page, { x: 90, y: 500 });
    const readonly = form.createTextField("Sistema"); readonly.addToPage(page, { x: 60, y: 450 }); readonly.enableReadOnly();
    const original = path.join(dir, "Ficha Tormenta 20.pdf"); const blank = await doc.save(); await fs.writeFile(original, blank);
    const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const schema = await describeForm(original); assert.equal(schema.fields.length, 4);
    assert.equal(schema.fields[0].name, "Nome");
    const filled = await fillCopyBytes(original, { Nome: "Enrick — ação", Treinado: true, Classe: ["Mago"], Origem: "Elfo" }, {
      Nome: { font: "times", fontSize: 14, color: "#9b1c1c", alignment: "center" }
    });
    const copies = await Promise.all(Array.from({ length: 3 }, () => publishCopy(dir, copyName(original, ""), filled)));
    assert.deepEqual(copies.sort(), ["Ficha Tormenta 20 - copia (2).pdf", "Ficha Tormenta 20 - copia (3).pdf", "Ficha Tormenta 20 - copia.pdf"]);
    assert.equal(copyName(original, "Enrick"), "Ficha Tormenta 20 - Enrick");
    const result = await PDFDocument.load(await fs.readFile(path.join(dir, copies[0])));
    assert.equal(result.getPageCount(), 2); assert.equal(result.getPage(1).getRotation().angle, 90);
    assert.deepEqual(result.getPage(0).getSize(), { width: 600, height: 800 });
    assert.equal(result.getForm().getFields().length, 5);
    assert.equal(result.getForm().getTextField("Nome").getText(), "Enrick — ação");
    assert.match(result.getForm().getTextField("Nome").acroField.getDefaultAppearance() ?? "", /Times-Roman 14 Tf/);
    assert.match(result.getForm().getTextField("Nome").acroField.getDefaultAppearance() ?? "", /0\.60784313725490\d+ 0\.10980392156862745 0\.10980392156862745 rg/);
    assert.equal(result.getForm().getCheckBox("Treinado").isChecked(), true);
    assert.deepEqual(result.getForm().getDropdown("Classe").getSelected(), ["Mago"]);
    assert.equal(result.getForm().getRadioGroup("Origem").getSelected(), "Elfo");
    assert.equal(hash(await fs.readFile(original)), hash(blank));
    assert.equal((await PDFDocument.load(await fs.readFile(original))).getForm().getTextField("Nome").getText(), undefined);
    await assert.rejects(fillCopyBytes(original, { Sistema: "alterado" }));
    await assert.rejects(fillCopyBytes(original, { Inexistente: "alterado" }));
    await assert.rejects(fillCopyBytes(original, { Classe: ["inexistente"] }));
    assert.throws(() => copyName(original, "../original"));
    assert.throws(() => copyName(original, 123));
    // A malicious/preexisting destination symlink is never followed/replaced.
    await fs.symlink(original, path.join(dir, "Ficha Tormenta 20 - Enrick.pdf"));
    assert.equal(await publishCopy(dir, copyName(original, "Enrick"), filled), "Ficha Tormenta 20 - Enrick (2).pdf");
    assert.equal(hash(await fs.readFile(original)), hash(blank));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("PDF without fields supports the page editor", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forms-empty-"));
  try {
    const doc = await PDFDocument.create(); doc.addPage();
    const file = path.join(dir, "empty.pdf"); await fs.writeFile(file, await doc.save());
    assert.deepEqual((await describeForm(file)).fields, []);
    assert.equal((await PDFDocument.load(await fillCopyBytes(file, {}))).getPageCount(), 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
