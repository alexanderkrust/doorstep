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
 * Holds the lock in a separate process, like an import in another container.
 * Resolves as soon as the lock is taken.
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

  it('records PID and host and releases the lock again', async () => {
    const release = await acquireLock(lockPath);
    expect(await holder()).toMatchObject({ pid: process.pid, host: hostname() });

    await release();
    expect(existsSync(`${lockPath}.json`)).toBe(false);
    await (
      await acquireLock(lockPath)
    )();
  });

  it('refuses a second lock in the same process', async () => {
    const release = await acquireLock(lockPath);
    await expect(acquireLock(lockPath)).rejects.toThrow(LockError);
    await release();
  });

  it('refuses the lock while another process holds it, and names it', async () => {
    const other = await holdInOtherProcess();
    await expect(acquireLock(lockPath)).rejects.toThrow(
      new RegExp(`PID ${String(other.pid)} on ${hostname()}`),
    );
  });

  it('is free immediately when the holder is killed (e.g. container rebuilt)', async () => {
    const other = await holdInOtherProcess();
    await expect(acquireLock(lockPath)).rejects.toThrow(LockError);

    other.kill('SIGKILL');
    await once(other, 'exit');
    // The dead holder's details are still there but must not lock.
    expect(existsSync(`${lockPath}.json`)).toBe(true);
    const release = await acquireLock(lockPath);
    expect(await holder()).toMatchObject({ pid: process.pid });
    await release();
  });
});
