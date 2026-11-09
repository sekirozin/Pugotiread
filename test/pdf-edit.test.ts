import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, degrees } from 'pdf-lib';
import { fillCopyBytes, previewPdf } from '../src/server/pdf-forms.js';
import { EditHistory } from '../src/UI/Web/pdf-edit-history.js';

test('Page and text edits preserve source bytes and survive reopening', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-edit-'));
  try {
    const source = path.join(dir, 'original.pdf');
    const doc = await PDFDocument.create(); doc.addPage([600, 800]);
    const original = await doc.save(); await fs.writeFile(source, original);
    const edits = [{ kind: 'insert', position: 'start' }, { kind: 'insert', position: 'end' }, { kind: 'text', page: 1, name: 'pugoti_text_test', rect: [30, 600, 250, 100] }, { kind: 'delete', page: 2 }];
    const styles = { pugoti_text_test: { font: 'times', fontSize: 18, color: '#227744', alignment: 'center' } };
    const bytes = await fillCopyBytes(source, { pugoti_text_test: 'Olá! Nova página\nTexto livre' }, styles, edits);
    const result = await PDFDocument.load(bytes);
    assert.equal(result.getPageCount(), 2);
    assert.deepEqual(result.getPage(0).getSize(), { width: 600, height: 800 });
    assert.equal(result.getForm().getTextField('pugoti_text_test').getText(), 'Olá! Nova página\nTexto livre');
    const preview = await previewPdf(source, {}, {}, edits);
    assert.equal(preview.schema.pageCount, 2);
    assert.equal(preview.schema.fields[0].name, 'pugoti_text_test');
    assert.deepEqual(await fs.readFile(source), Buffer.from(original));
    await assert.rejects(fillCopyBytes(source, {}, {}, [{ kind: 'delete', page: 1 }]), /pelo menos uma/);
    await assert.rejects(fillCopyBytes(source, {}, {}, [{ kind: 'delete', page: 5 }]), /Página inválida/);
    await assert.rejects(fillCopyBytes(source, {}, {}, [{ kind: 'text', page: 1, name: 'pugoti_text_test', rect: [-10, 10, 100, 100] }]), /dentro da página/);
    await assert.rejects(fillCopyBytes(source, {}, {}, [{ kind: 'insert', position: 'invalid' }]), /Posição inválida/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Removing pages cleans their fields but preserves shared widgets on other pages', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-edit-fields-'));
  try {
    const doc = await PDFDocument.create(); const first = doc.addPage(); const second = doc.addPage();
    const form = doc.getForm();
    const shared = form.createTextField('Shared'); shared.addToPage(first); shared.addToPage(second);
    const removed = form.createTextField('Removed'); removed.addToPage(first);
    const source = path.join(dir, 'form.pdf'); await fs.writeFile(source, await doc.save());
    const bytes = await fillCopyBytes(source, { Shared: 'Still here', Removed: 'Discarded' }, {}, [{ kind: 'delete', page: 1 }]);
    const result = await PDFDocument.load(bytes);
    assert.equal(result.getPageCount(), 1);
    assert.equal(result.getForm().getFieldMaybe('Removed'), undefined);
    assert.equal(result.getForm().getTextField('Shared').acroField.getWidgets().length, 1);
    assert.equal(result.getForm().getTextField('Shared').getText(), 'Still here');
    doc.getPage(1).setRotation(degrees(90)); await fs.writeFile(source, await doc.save());
    const rotated = await PDFDocument.load(await fillCopyBytes(source, {}, {}, [{ kind: 'insert', position: 'end' }]));
    assert.deepEqual(rotated.getPage(2).getSize(), { width: second.getHeight(), height: second.getWidth() });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('History restores snapshots, drops redo on new edits, and caps history', () => {
  const history = new EditHistory<{ value: string[] }>(2);
  const a = { value: ['a'] }; history.record(a); a.value.push('mutated');
  assert.deepEqual(history.undo({ value: ['b'] }), { value: ['a'] });
  assert.deepEqual(history.redo({ value: ['a'] }), { value: ['b'] });
  history.record({ value: ['b'] }); history.record({ value: ['c'] });
  assert.deepEqual(history.undo({ value: ['d'] }), { value: ['c'] });
  assert.deepEqual(history.undo({ value: ['c'] }), { value: ['b'] });
  assert.equal(history.undo({ value: ['b'] }), undefined);
  history.record({ value: ['new'] }); assert.equal(history.canRedo, false);
});
