import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isOsmiumAvailable } from '../../src/import/osmium.js';
import { EXTRACT_FILE, INDEX_FILE, runImport } from '../../src/import/pipeline.js';
import {
  parseState,
  planRefresh,
  readReplicationHeader,
  sequencePath,
} from '../../src/import/replication.js';
import { SearchIndex } from '../../src/search/search-index.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const BASE_PBF = join(FIXTURES, 'koenigsallee.osm.pbf');
const DIFF = join(FIXTURES, 'koenigsallee-diff.osc.gz');
const DAY = 24 * 60 * 60 * 1000;

describe('sequencePath', () => {
  it('splits the 9-digit number into three folders', () => {
    expect(sequencePath(4321)).toBe('000/004/321');
    expect(sequencePath(123456789)).toBe('123/456/789');
  });
});

describe('parseState', () => {
  it('reads sequence number and timestamp (with escaped colons)', () => {
    const text =
      '# original OSM minutely replication sequence number 7358731\n' +
      'timestamp=2026-11-04T21\\:21\\:03Z\nsequenceNumber=4943\n';
    expect(parseState(text)).toEqual({ sequence: 4943, timestamp: '2026-11-04T21:21:03Z' });
  });

  it('returns null without a sequence number', () => {
    expect(parseState('<html>404</html>')).toBeNull();
  });
});

describe('planRefresh', () => {
  const now = Date.parse('2026-11-06T00:00:00Z');
  const header = { baseUrl: 'https://example.org/region-updates', sequence: 4943, timestamp: null };
  const region = 'https://example.org/region-latest.osm.pbf';
  const fresh = { regionUrl: region, fullDownloadAt: new Date(now - DAY).toISOString() };
  const plan = (overrides: Partial<Parameters<typeof planRefresh>[0]>) =>
    planRefresh({
      diffUpdates: true,
      regionUrl: region,
      record: fresh,
      header,
      now,
      ...overrides,
    });

  it('takes the diffs for an extract with replication header', () => {
    expect(plan({})).toEqual({ kind: 'diff', baseUrl: header.baseUrl, sequence: 4943 });
  });

  it.each([
    ['DIFF_UPDATES is off', { diffUpdates: false }, /DIFF_UPDATES/],
    ['there is no extract yet', { header: null, record: null }, /no extract/],
    ['the extract has no replication header', { header: null }, /replication header/],
    ['REGION_URL changed', { regionUrl: 'https://example.org/other-latest.osm.pbf' }, /REGION_URL/],
    [
      'the last full download is older than 30 days',
      { record: { ...fresh, fullDownloadAt: new Date(now - 31 * DAY).toISOString() } },
      /30 days/,
    ],
  ])('downloads everything when %s', (_label, overrides, reason) => {
    const result = plan(overrides);
    expect(result.kind).toBe('full');
    expect(result.kind === 'full' ? result.reason : '').toMatch(reason);
  });
});

describe.skipIf(!isOsmiumAvailable())('update with diffs', () => {
  let dir: string;
  let site: string;
  let server: Server;
  let url: string;
  let requests: string[];
  let state: string | null;

  /** The test extract with a replication header pointing to the local server. */
  function withHeader(input: string, output: string, sequence: number): void {
    execFileSync('osmium', [
      'cat',
      input,
      '-o',
      output,
      '--overwrite',
      `--output-header=osmosis_replication_base_url=${url}/updates`,
      `--output-header=osmosis_replication_sequence_number=${String(sequence)}`,
      '--output-header=osmosis_replication_timestamp=2026-11-04T21:21:03Z',
    ]);
  }

  async function publishRegion(pbf: string): Promise<void> {
    const target = join(site, 'region-latest.osm.pbf');
    await cp(pbf, target);
    const md5 = createHash('md5')
      .update(await readFile(target))
      .digest('hex');
    await writeFile(`${target}.md5`, `${md5}  region-latest.osm.pbf\n`);
  }

  const setState = (sequence: number) => {
    state = `timestamp=2026-11-05T21\\:21\\:03Z\nsequenceNumber=${String(sequence)}\n`;
  };

  beforeAll(async () => {
    site = await mkdtemp(join(tmpdir(), 'doorstep-site-'));
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      requests.push(path);
      if (path === '/updates/state.txt') {
        if (state === null) res.writeHead(404).end();
        else res.writeHead(200, { 'content-type': 'text/plain' }).end(state);
        return;
      }
      readFile(join(site, path)).then(
        (body) => res.writeHead(200, { 'content-length': String(body.length) }).end(body),
        () => res.writeHead(404).end(),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(site, { recursive: true, force: true });
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'doorstep-diff-'));
    await rm(join(site, 'updates'), { recursive: true, force: true });
    await mkdir(join(site, 'updates', '000', '000'), { recursive: true });
    requests = [];
    // The region on the server: the test extract at sequence 100.
    withHeader(BASE_PBF, join(dir, 'v1.osm.pbf'), 100);
    await publishRegion(join(dir, 'v1.osm.pbf'));
    setState(100);
  });

  const region = () => `${url}/region-latest.osm.pbf`;
  const update = (mode: 'import' | 'update', dataDir = join(dir, 'data')) =>
    runImport({ dataDir, regionUrl: region(), mode });
  const find = (q: string, dataDir = join(dir, 'data')) => {
    const index = new SearchIndex(join(dataDir, INDEX_FILE));
    try {
      return index.search({ q, limit: 1 })?.[0]?.name ?? null;
    } finally {
      index.close();
    }
  };
  const identity = async () => {
    const s = await stat(join(dir, 'data', INDEX_FILE));
    return `${String(s.ino)}:${String(s.mtimeMs)}`;
  };

  it('downloads only the missing diffs and rebuilds the index with them', async () => {
    await update('import');
    expect(find('Diffweg')).toBeNull();

    await cp(DIFF, join(site, 'updates', '000', '000', '101.osc.gz'));
    setState(101);
    requests = [];
    const result = await update('update');

    expect(result.extract).toMatchObject({ kind: 'diff', diffs: 1 });
    expect(result.rebuilt).toBe(true);
    expect(requests).toContain('/updates/000/000/101.osc.gz');
    expect(requests).not.toContain('/region-latest.osm.pbf');
    expect(find('Diffweg')).toBe('Diffweg');
    expect(find('Diffcafé')).toBe('Diffcafé');
    const header = await readReplicationHeader(join(dir, 'data', EXTRACT_FILE));
    expect(header).toMatchObject({ baseUrl: `${url}/updates`, sequence: 101 });
  });

  it('skips the rebuild when there is nothing new', async () => {
    await update('import');
    const before = await identity();
    requests = [];

    const result = await update('update');

    expect(result.extract.kind).toBe('unchanged');
    expect(result.rebuilt).toBe(false);
    expect(await identity()).toBe(before);
    expect(requests).toEqual(['/updates/state.txt']);
  });

  it('still rebuilds with `import`, even with nothing new', async () => {
    await update('import');
    const before = await identity();
    const result = await update('import');
    expect(result.rebuilt).toBe(true);
    expect(await identity()).not.toBe(before);
  });

  it('falls back to the full download when a diff is missing', async () => {
    await update('import');
    await cp(DIFF, join(site, 'updates', '000', '000', '101.osc.gz'));
    setState(102); // 102 is not on the server
    // The full extract on the server already contains the changes.
    execFileSync('osmium', [
      'apply-changes',
      join(dir, 'v1.osm.pbf'),
      DIFF,
      '-o',
      join(dir, 'v2.osm.pbf'),
      '--overwrite',
    ]);
    withHeader(join(dir, 'v2.osm.pbf'), join(dir, 'v2h.osm.pbf'), 102);
    await publishRegion(join(dir, 'v2h.osm.pbf'));
    requests = [];

    const result = await update('update');

    expect(result.extract).toMatchObject({ kind: 'full' });
    expect(requests).toContain('/region-latest.osm.pbf');
    expect(find('Diffweg')).toBe('Diffweg');
  });

  it('falls back to the full download when a diff is broken, and keeps the old extract until then', async () => {
    await update('import');
    await writeFile(join(site, 'updates', '000', '000', '101.osc.gz'), 'not gzip');
    setState(101);
    requests = [];

    const result = await update('update');

    expect(result.extract).toMatchObject({ kind: 'full' });
    expect(requests).toContain('/region-latest.osm.pbf.md5');
    expect(find('Königsallee')).toBe('Königsallee');
  });

  it('rebuilds when the index has other INDEX_TYPES than wanted, even with nothing new', async () => {
    await update('import');
    const result = await runImport({
      dataDir: join(dir, 'data'),
      regionUrl: region(),
      mode: 'update',
      indexTypes: ['street'],
    });
    expect(result.extract.kind).toBe('unchanged');
    expect(result.rebuilt).toBe(true);
  });
});
