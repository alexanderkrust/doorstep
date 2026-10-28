import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, LockError } from '../../src/import/lock.js';

let dir: string;
let lockPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'doorstep-lock-'));
  lockPath = join(dir, 'import.lock');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('acquireLock', () => {
  const holder = async () =>
    JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
  const writeHolder = (data: Record<string, unknown>) => writeFile(lockPath, JSON.stringify(data));

  it('legt die Sperrdatei mit PID und Host an und entfernt sie wieder', async () => {
    const release = await acquireLock(lockPath);
    expect(await holder()).toMatchObject({ pid: process.pid, host: hostname() });

    await release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('verweigert eine zweite Sperre, solange der Halter lebt', async () => {
    const release = await acquireLock(lockPath);
    await expect(acquireLock(lockPath)).rejects.toThrow(LockError);
    await release();
    await (
      await acquireLock(lockPath)
    )();
  });

  it('übernimmt eine verwaiste Sperre eines beendeten Prozesses auf demselben Host', async () => {
    // PIDs dieser Größe gibt es praktisch nicht.
    await writeHolder({ pid: 999_999_999, host: hostname(), startedAt: new Date().toISOString() });
    const release = await acquireLock(lockPath);
    expect(await holder()).toMatchObject({ pid: process.pid });
    await release();
  });

  it('respektiert eine frische Sperre eines anderen Hosts (anderer Container)', async () => {
    await writeHolder({ pid: 1, host: 'anderer-container', startedAt: new Date().toISOString() });
    await expect(acquireLock(lockPath)).rejects.toThrow(LockError);
  });

  it('übernimmt eine Sperre, die älter als die Höchstdauer ist', async () => {
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    await writeHolder({ pid: 1, host: 'anderer-container', startedAt: old });
    await (
      await acquireLock(lockPath)
    )();
  });

  it('übernimmt eine Sperre mit unlesbarem Inhalt', async () => {
    await writeFile(lockPath, 'kaputt');
    await (
      await acquireLock(lockPath)
    )();
  });
});
