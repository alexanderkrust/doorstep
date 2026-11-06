import { statfs } from 'node:fs/promises';

/** SQLite's result code when it cannot grow a file (`database or disk is full`). */
const SQLITE_FULL = 13;

/**
 * Free space the import needs next to the extract, as a multiple of the extract's size: the
 * filtered extract, the staging file, SQLite's sort files and the new index. Estimate: Germany
 * (4.9 GB extract) ends with a 10.1 GB index; the peak during the build was not measured.
 */
export const REQUIRED_SPACE_FACTOR = 4;

const GB = 1024 ** 3;

function formatGb(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`;
}

/** Space that the process can still write in `dir`, in bytes. */
export async function freeBytes(dir: string): Promise<number> {
  const stats = await statfs(dir);
  return stats.bavail * stats.bsize;
}

/** `true` for SQLite's `database or disk is full` and for `ENOSPC` from the file system. */
export function isDiskFull(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const { errcode, code } = err as { errcode?: unknown; code?: unknown };
  return errcode === SQLITE_FULL || code === 'ENOSPC';
}

/** The disk ran full while the index was built. */
export class DiskFullError extends Error {
  constructor(dir: string, free: number, cause: unknown) {
    super(
      `disk full while building the index in ${dir} (${formatGb(free)} free). The import needs ` +
        `about ${String(REQUIRED_SPACE_FACTOR)} times the extract's size free next to the ` +
        'extract (Germany: about 20 GB, at least 30 GB on the volume in total); with Docker ' +
        'Desktop, check its disk limit. See "System requirements" in the README',
      { cause },
    );
    this.name = 'DiskFullError';
  }
}

/** A warning before the import when less space is free than it probably needs, else `null`. */
export function diskSpaceWarning(dir: string, free: number, extractBytes: number): string | null {
  const needed = REQUIRED_SPACE_FACTOR * extractBytes;
  if (free >= needed) return null;
  return (
    `Warning: only ${formatGb(free)} free in ${dir}, the import probably needs about ` +
    `${formatGb(needed)} for this extract and may fail with "disk full" ` +
    '(see "System requirements" in the README)'
  );
}
