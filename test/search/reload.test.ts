import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importFromGeoJsonSeq, INDEX_FILE } from '../../src/import/pipeline.js';
import { IndexUnavailableError, SearchIndex } from '../../src/search/search-index.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const SMALL = join(FIXTURES, 'koenigsallee.geojsonseq');
const LARGE = join(FIXTURES, 'duesseldorf.geojsonseq');

let dir: string;
let path: string;
let index: SearchIndex;

const names = (q: string) => (index.search({ q, limit: 5 }) ?? []).map((row) => row.name);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'doorstep-reload-'));
  path = join(dir, INDEX_FILE);
  index = new SearchIndex(path);
});

afterEach(async () => {
  index.close();
  await rm(dir, { recursive: true, force: true });
});

describe('SearchIndex.reloadIfChanged', () => {
  it('meldet keine Änderung, solange die Datei dieselbe ist', async () => {
    await importFromGeoJsonSeq(SMALL, path);
    expect(index.open()).toBe(true);
    expect(index.reloadIfChanged()).toBe(false);
  });

  it('meldet keine Änderung, wenn noch kein Index geöffnet ist', () => {
    expect(index.reloadIfChanged()).toBe(false);
  });

  it('liest nach dem atomaren Tausch den alten Index weiter und wechselt erst beim Neuladen', async () => {
    await importFromGeoJsonSeq(SMALL, path);
    expect(names('Oberbilker Allee')).not.toContain('Oberbilker Allee');

    await importFromGeoJsonSeq(LARGE, path);
    // Die alte Datei ist zwar umbenannt/gelöscht, bleibt aber geöffnet und lesbar.
    expect(names('Königsallee')).toContain('Königsallee');
    expect(names('Oberbilker Allee')).not.toContain('Oberbilker Allee');

    expect(index.reloadIfChanged()).toBe(true);
    expect(names('Oberbilker Allee')).toContain('Oberbilker Allee');
    expect(index.reloadIfChanged()).toBe(false);
  });

  it('behält den alten Index, wenn die neue Datei unbrauchbar ist', async () => {
    await importFromGeoJsonSeq(SMALL, path);
    expect(index.open()).toBe(true);

    await rm(path);
    await writeFile(path, 'kein sqlite');
    expect(() => index.reloadIfChanged()).toThrow(IndexUnavailableError);
    expect(names('Königsallee')).toContain('Königsallee');
  });

  it('behält den alten Index, wenn die Datei verschwindet', async () => {
    await importFromGeoJsonSeq(SMALL, path);
    expect(index.open()).toBe(true);

    await rm(path);
    expect(index.reloadIfChanged()).toBe(false);
    expect(names('Königsallee')).toContain('Königsallee');
  });
});

describe('SearchIndex.meta', () => {
  it('liefert Metadaten des geöffneten Index', async () => {
    expect(index.meta()).toBeNull();
    await importFromGeoJsonSeq(SMALL, path);
    expect(index.open()).toBe(true);

    const meta = index.meta();
    expect(Number(meta?.['places'])).toBeGreaterThan(0);
    expect(meta?.['imported_at']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
