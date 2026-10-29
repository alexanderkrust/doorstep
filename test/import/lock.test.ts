import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, LockError } from '../../src/import/lock.js';

let dir: string;
let lockPath: string;
let child: ChildProcess | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'doorstep-lock-'));
  lockPath = join(dir, 'import.lock.sqlite');
});

afterEach(async () => {
  child?.kill('SIGKILL');
  child = undefined;
  await rm(dir, { recursive: true, force: true });
});

/**
 * Hält die Sperre in einem eigenen Prozess, wie ein Import in einem anderen
 * Container. Löst auf, sobald die Sperre gesetzt ist.
 */
async function holdInOtherProcess(): Promise<ChildProcess> {
  const script = `
    import { acquireLock } from ${JSON.stringify(join(import.meta.dirname, '../../src/import/lock.ts'))};
    await acquireLock(process.argv[1]);
    console.log('held');
    setInterval(() => {}, 1000);
  `;
  const proc = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script, lockPath],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  child = proc;
  const [chunk] = (await once(proc.stdout, 'data')) as [Buffer];
  expect(chunk.toString()).toContain('held');
  return proc;
}

describe('acquireLock', () => {
  const holder = async () =>
    JSON.parse(await readFile(`${lockPath}.json`, 'utf8')) as Record<string, unknown>;

  it('hält PID und Host fest und gibt die Sperre wieder frei', async () => {
    const release = await acquireLock(lockPath);
    expect(await holder()).toMatchObject({ pid: process.pid, host: hostname() });

    await release();
    expect(existsSync(`${lockPath}.json`)).toBe(false);
    await (
      await acquireLock(lockPath)
    )();
  });

  it('verweigert eine zweite Sperre im selben Prozess', async () => {
    const release = await acquireLock(lockPath);
    await expect(acquireLock(lockPath)).rejects.toThrow(LockError);
    await release();
  });

  it('verweigert die Sperre, solange ein anderer Prozess sie hält, und nennt ihn', async () => {
    const other = await holdInOtherProcess();
    await expect(acquireLock(lockPath)).rejects.toThrow(
      new RegExp(`PID ${String(other.pid)} auf ${hostname()}`),
    );
  });

  it('ist sofort frei, wenn der Halter hart beendet wird (z. B. Container neu gebaut)', async () => {
    const other = await holdInOtherProcess();
    await expect(acquireLock(lockPath)).rejects.toThrow(LockError);

    other.kill('SIGKILL');
    await once(other, 'exit');
    // Die Angaben des toten Halters liegen noch da, dürfen aber nicht sperren.
    expect(existsSync(`${lockPath}.json`)).toBe(true);
    const release = await acquireLock(lockPath);
    expect(await holder()).toMatchObject({ pid: process.pid });
    await release();
  });
});
