import { readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

/** Ein anderer Import oder ein Update läuft bereits. */
export class LockError extends Error {
  override name = 'LockError';
}

interface Holder {
  pid: number;
  host: string;
  startedAt: string;
}

/** SQLITE_BUSY: Ein anderer Prozess hält die Sperre. */
const SQLITE_BUSY = 5;

/** Angaben zum Halter, nur für die Fehlermeldung; sie entscheiden nicht über die Sperre. */
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
    ? `Es läuft bereits ein Import (PID ${String(holder.pid)} auf ${holder.host}, seit ${holder.startedAt}).`
    : 'Es läuft bereits ein Import.';
}

/**
 * Sperrt `path` exklusiv für diesen Prozess, damit nie zwei Imports gleichzeitig
 * `index.next.sqlite` schreiben (z. B. UPDATE_CRON und `docker exec … update`).
 * Liefert eine Funktion, die die Sperre wieder freigibt.
 *
 * Die Sperre ist eine exklusive SQLite-Transaktion auf der Datei `path`, also eine
 * Dateisperre des Betriebssystems. Endet der Prozess, gibt das System sie sofort
 * frei, auch nach `kill -9` oder wenn der Container mitten im Import ersetzt wird.
 * Eine verwaiste Sperre gibt es damit nicht; PID und Host in `<path>.json` dienen
 * nur der Fehlermeldung. Das Dateisystem muss POSIX-Sperren können (lokales
 * Docker-Volume oder Bind-Mount, nicht NFS).
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
    // Die Datei der Sperre bleibt liegen: Löschen könnte einem wartenden Prozess
    // eine zweite, unabhängige Sperre auf einer neuen Datei ermöglichen.
    await rm(infoPath, { force: true });
    if (db.isOpen) {
      db.exec('ROLLBACK');
      db.close();
    }
  };
}
