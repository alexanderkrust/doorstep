import { link, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';

/** Ein anderer Import oder ein Update läuft bereits. */
export class LockError extends Error {
  override name = 'LockError';
}

interface Holder {
  pid: number;
  host: string;
  startedAt: string;
}

/**
 * Nach dieser Zeit gilt eine Sperre als verwaist, auch wenn sich der Halter nicht
 * prüfen lässt (anderer Container). Ein Deutschland-Import dauert deutlich kürzer.
 */
const MAX_AGE_MS = 24 * 3600 * 1000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: Prozess existiert, gehört aber einem anderen Nutzer.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readHolder(path: string): Promise<Holder | null> {
  try {
    const data = JSON.parse(await readFile(path, 'utf8')) as Partial<Holder>;
    if (typeof data.pid !== 'number' || typeof data.host !== 'string') return null;
    return { pid: data.pid, host: data.host, startedAt: String(data.startedAt) };
  } catch {
    return null;
  }
}

/** Lebt der Halter noch? Unlesbare, zu alte oder verwaiste Sperren zählen nicht. */
function isHeld(holder: Holder | null): holder is Holder {
  if (!holder) return false;
  const age = Date.now() - Date.parse(holder.startedAt);
  if (!(age < MAX_AGE_MS)) return false;
  if (holder.host !== hostname()) return true;
  return isAlive(holder.pid);
}

/** Legt `path` als Hardlink auf `tmp` an; `false`, wenn `path` schon existiert. */
async function tryLink(tmp: string, path: string): Promise<boolean> {
  try {
    await link(tmp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Sperrt `path` exklusiv für diesen Prozess, damit nie zwei Imports gleichzeitig
 * `index.next.sqlite` schreiben (z. B. UPDATE_CRON und `docker exec … update`).
 * Liefert eine Funktion, die die Sperre wieder freigibt.
 */
export async function acquireLock(path: string): Promise<() => Promise<void>> {
  const holder: Holder = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
  };
  // Erst vollständig schreiben, dann atomar per link() anlegen: Wer die Sperre
  // sieht, sieht sie immer mit Inhalt.
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(holder)}\n`);
  try {
    if (!(await tryLink(tmp, path))) {
      const current = await readHolder(path);
      if (isHeld(current)) {
        throw new LockError(
          `Es läuft bereits ein Import (PID ${String(current.pid)} auf ${current.host}, ` +
            `seit ${current.startedAt}). Falls nicht, ${path} löschen.`,
        );
      }
      // Verwaiste Sperre ersetzen. Kommt ein anderer Prozess zuvor, gewinnt er.
      await rm(path, { force: true });
      if (!(await tryLink(tmp, path))) {
        throw new LockError(`Ein anderer Import hat die Sperre ${path} gerade übernommen`);
      }
    }
  } finally {
    await rm(tmp, { force: true });
  }
  return async () => {
    const current = await readHolder(path);
    if (current?.pid === holder.pid && current.host === holder.host) {
      await rm(path, { force: true });
    }
  };
}
