import { readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

/** Another import or update is already running. */
export class LockError extends Error {
  override name = 'LockError';
}

interface Holder {
  pid: number;
  host: string;
  startedAt: string;
}

/** SQLITE_BUSY: another process holds the lock. */
const SQLITE_BUSY = 5;

/** Details about the holder, only for the error message; they do not decide the lock. */
async function readHolder(path: string): Promise<Holder | null> {
  try {
    const data = JSON.parse(await readFile(path, 'utf8')) as Partial<Holder>;
    if (typeof data.pid !== 'number' || typeof data.host !== 'string') return null;
    return { pid: data.pid, host: data.host, startedAt: String(data.startedAt) };
  } catch {
    return null;
  }
}

function lockedMessage(holder: Holder | null): string {
  return holder
    ? `An import is already running (PID ${String(holder.pid)} on ${holder.host}, since ${holder.startedAt}).`
    : 'An import is already running.';
}

/**
 * Locks `path` exclusively for this process so that two imports never write
 * `index.next.sqlite` at the same time (e.g. UPDATE_CRON and `docker exec … update`).
 * Returns a function that releases the lock.
 *
 * The lock is an exclusive SQLite transaction on the file `path`, i.e. an operating
 * system file lock. When the process ends, the system releases it immediately, even
 * after `kill -9` or when the container is replaced in the middle of an import. So
 * there are no stale locks; PID and host in `<path>.json` are only for the error
 * message. The file system must support POSIX locks (local Docker volume or bind
 * mount, not NFS).
 */
export async function acquireLock(path: string): Promise<() => Promise<void>> {
  const infoPath = `${path}.json`;
  const db = new DatabaseSync(path, { timeout: 0 });
  try {
    db.exec('BEGIN EXCLUSIVE');
  } catch (err) {
    db.close();
    if ((err as { errcode?: number }).errcode === SQLITE_BUSY) {
      throw new LockError(lockedMessage(await readHolder(infoPath)));
    }
    throw err;
  }

  const holder: Holder = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
  };
  await writeFile(infoPath, `${JSON.stringify(holder)}\n`);

  return async () => {
    // The lock file stays: deleting it could let a waiting process take a second,
    // independent lock on a new file.
    await rm(infoPath, { force: true });
    if (db.isOpen) {
      db.exec('ROLLBACK');
      db.close();
    }
  };
}
