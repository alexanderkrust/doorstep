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
  it('reports no change while the file is the same', async () => {
    await importFromGeoJsonSeq(SMALL, path);
    expect(index.open()).toBe(true);
    expect(index.reloadIfChanged()).toBe(false);
  });

  it('reports no change when no index is open yet', () => {
    expect(index.reloadIfChanged()).toBe(false);
  });

  it('keeps reading the old index after the atomic swap and switches only on reload', async () => {
    await importFromGeoJsonSeq(SMALL, path);
    expect(names('Oberbilker Allee')).not.toContain('Oberbilker Allee');

    await importFromGeoJsonSeq(LARGE, path);
    // The old file is renamed/deleted, but stays open and readable.
    expect(names('Königsallee')).toContain('Königsallee');
    expect(names('Oberbilker Allee')).not.toContain('Oberbilker Allee');

    expect(index.reloadIfChanged()).toBe(true);
    expect(names('Oberbilker Allee')).toContain('Oberbilker Allee');
    expect(index.reloadIfChanged()).toBe(false);
  });

  it('keeps the old index when the new file is unusable', async () => {
    await importFromGeoJsonSeq(SMALL, path);
    expect(index.open()).toBe(true);

    await rm(path);
    await writeFile(path, 'kein sqlite');
    expect(() => index.reloadIfChanged()).toThrow(IndexUnavailableError);
    expect(names('Königsallee')).toContain('Königsallee');
  });

  it('keeps the old index when the file disappears', async () => {
    await importFromGeoJsonSeq(SMALL, path);
    expect(index.open()).toBe(true);

    await rm(path);
    expect(index.reloadIfChanged()).toBe(false);
    expect(names('Königsallee')).toContain('Königsallee');
  });
});

describe('SearchIndex.meta', () => {
  it('returns metadata of the open index', async () => {
    expect(index.meta()).toBeNull();
    await importFromGeoJsonSeq(SMALL, path);
    expect(index.open()).toBe(true);

    const meta = index.meta();
    expect(Number(meta?.['places'])).toBeGreaterThan(0);
    expect(meta?.['imported_at']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
