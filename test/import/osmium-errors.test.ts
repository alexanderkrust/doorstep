import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  exportGeoJsonSeq,
  filterExtract,
  isOsmiumAvailable,
  osmiumFailure,
} from '../../src/import/osmium.js';
import { importFromPbf } from '../../src/import/pipeline.js';

const PBF = join(import.meta.dirname, '..', 'fixtures', 'koenigsallee.osm.pbf');

describe('osmiumFailure', () => {
  it('names the exit code and stderr', () => {
    expect(osmiumFailure(['export', 'x.pbf'], 1, null, ' bad input \n').message).toBe(
      'osmium export failed (code 1): bad input',
    );
  });

  it('names the signal and points to memory when osmium was killed', () => {
    const message = osmiumFailure(['export', 'x.pbf'], null, 'SIGKILL', '').message;
    expect(message).toMatch(/^osmium export was killed by SIGKILL/);
    expect(message).toMatch(/out of memory/);
    expect(message).toMatch(/IMPORT_NODE_INDEX=file/);
  });

  it('names other signals without the memory hint', () => {
    const message = osmiumFailure(['tags-filter'], null, 'SIGTERM', '').message;
    expect(message).toBe('osmium tags-filter was killed by SIGTERM');
  });
});

describe('osmium killed by a signal', () => {
  let dir: string;
  let path: string | undefined;

  beforeAll(async () => {
    // A fake osmium that kills itself the way the out-of-memory killer does.
    dir = await mkdtemp(join(tmpdir(), 'doorstep-fake-osmium-'));
    const fake = join(dir, 'osmium');
    await writeFile(fake, '#!/bin/sh\nkill -9 $$\n');
    await chmod(fake, 0o755);
    path = process.env['PATH'];
    process.env['PATH'] = `${dir}${delimiter}${path ?? ''}`;
  });

  afterAll(async () => {
    process.env['PATH'] = path;
    await rm(dir, { recursive: true, force: true });
  });

  it('reports the signal for a command', async () => {
    await expect(filterExtract('in.pbf', join(dir, 'out.pbf'))).rejects.toThrow(
      /killed by SIGKILL.*out of memory/s,
    );
  });

  it('reports the signal for a streamed export', async () => {
    const lines = async () => {
      const read: string[] = [];
      for await (const line of exportGeoJsonSeq('in.pbf')) read.push(line);
      return read;
    };
    await expect(lines()).rejects.toThrow(/osmium export was killed by SIGKILL/);
  });
});

describe.skipIf(!isOsmiumAvailable())('node locations on disk (IMPORT_NODE_INDEX=file)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'doorstep-node-index-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const count = (path: string) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return (db.prepare('SELECT count(*) AS n FROM places').get() as { n: number }).n;
    } finally {
      db.close();
    }
  };

  it('builds the same index as with the locations in memory and cleans up', async () => {
    const memory = join(dir, 'memory.sqlite');
    const file = join(dir, 'file.sqlite');
    const work = join(dir, 'work');
    await importFromPbf(PBF, memory, { workDir: join(dir, 'work-memory') });
    await importFromPbf(PBF, file, { workDir: work, nodeIndex: 'file' });
    expect(count(file)).toBe(count(memory));
    expect(count(file)).toBeGreaterThan(0);
    expect(await readdir(work)).toEqual([]);
  });
});
