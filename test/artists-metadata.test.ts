import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanLibrary } from '../src/server/media.js';

test('metadados distinguem autores de artistas, inclusive quando só há artista', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pugoti-artists-'));
  try {
    for (const [name, metadata] of Object.entries({
      ambos: { authors: ['Autor'], artists: ['Artista'] },
      artista: { artists: ['Outro artista'] },
      ausente: {}
    })) {
      const dir = path.join(root, name);
      await mkdir(dir);
      await writeFile(path.join(dir, 'metadata.json'), JSON.stringify(metadata));
      await writeFile(path.join(dir, '001.jpg'), 'fixture');
    }
    const results = await scanLibrary({ id: `artists-${Date.now()}`, name: 'Teste', kind: 'manga', path: root }, { refresh: true });
    const byTitle = Object.fromEntries(results.map(item => [item.title, item]));
    assert.deepEqual(byTitle.ambos.authors, ['Autor']);
    assert.deepEqual(byTitle.ambos.artists, ['Artista']);
    assert.deepEqual(byTitle.artista.authors, []);
    assert.deepEqual(byTitle.artista.artists, ['Outro artista']);
    assert.deepEqual(byTitle.ausente.artists, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
