import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DiskFullError,
  diskSpaceWarning,
  freeBytes,
  isDiskFull,
  REQUIRED_SPACE_FACTOR,
} from '../../src/import/disk.js';
import { IndexWriter } from '../../src/import/index-writer.js';
import { isOsmiumAvailable } from '../../src/import/osmium.js';
import { importFromPbf } from '../../src/import/pipeline.js';

const PBF = join(import.meta.dirname, '..', 'fixtures', 'koenigsallee.osm.pbf');
const GB = 1024 ** 3;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'doorstep-disk-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The error SQLite throws when it cannot grow a file (SQLITE_FULL). */
function sqliteFullError(): unknown {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA max_page_count = 2; CREATE TABLE t (x)');
  try {
    for (let i = 0; i < 100; i++) db.prepare('INSERT INTO t VALUES (?)').run('x'.repeat(1000));
  } catch (err) {
    return err;
  } finally {
    db.close();
  }
  throw new Error('SQLite did not run full');
}

describe('isDiskFull', () => {
  it('recognizes SQLITE_FULL and ENOSPC', () => {
    expect(isDiskFull(sqliteFullError())).toBe(true);
    expect(isDiskFull(Object.assign(new Error('write failed'), { code: 'ENOSPC' }))).toBe(true);
  });

  it('ignores other errors', () => {
    expect(isDiskFull(new Error('database is locked'))).toBe(false);
    expect(isDiskFull('database or disk is full')).toBe(false);
  });
});

describe('DiskFullError', () => {
  it('names the directory, the free space and where to read on', () => {
    const err = new DiskFullError('/data', 0.4 * GB, sqliteFullError());
    expect(err.message).toMatch(/^disk full while building the index in \/data \(0\.4 GB free\)/);
    expect(err.message).toMatch(/System requirements/);
    expect(err.cause).toBeInstanceOf(Error);
  });
});

describe('diskSpaceWarning', () => {
  const extract = 4.9 * GB;

  it('warns when less than the estimate is free', () => {
    const warning = diskSpaceWarning('/data', 12 * GB, extract);
    expect(warning).toMatch(/12\.0 GB free in \/data/);
    expect(warning).toMatch(
      new RegExp(`about ${(REQUIRED_SPACE_FACTOR * 4.9).toFixed(1)} GB for this extract`),
    );
  });

  it('says nothing with enough space', () => {
    expect(diskSpaceWarning('/data', 100 * GB, extract)).toBeNull();
  });
});

describe('freeBytes', () => {
  it('reads the free space of a directory', async () => {
    expect(await freeBytes(dir)).toBeGreaterThan(0);
  });
});

describe('IndexWriter temp files', () => {
  it('keeps SQLite temp files next to the index while it builds', () => {
    const probe = new DatabaseSync(':memory:');
    // Without a directory set, the pragma returns no row.
    const tempDir = () =>
      (probe.prepare('PRAGMA temp_store_directory').all() as { temp_store_directory: string }[])
        .map((row) => row.temp_store_directory)
        .join('');
    const writer = new IndexWriter(join(dir, 'index.sqlite'));
    expect(tempDir()).toBe(dir);
    writer.finish({});
    expect(tempDir()).toBe('');
    probe.close();
  });
});

describe.runIf(isOsmiumAvailable())('importFromPbf disk use', () => {
  it('deletes the filtered extract before building the index', async () => {
    const filtered = join(dir, 'filtered.osm.pbf');
    let filteredWhileBuilding: boolean | undefined;
    await importFromPbf(PBF, join(dir, 'index.sqlite'), {
      workDir: dir,
      log: (msg) => {
        if (msg.includes('Building the index')) filteredWhileBuilding = existsSync(filtered);
      },
    });
    expect(filteredWhileBuilding).toBe(false);
    expect((await stat(join(dir, 'index.sqlite'))).size).toBeGreaterThan(0);
  });
});
