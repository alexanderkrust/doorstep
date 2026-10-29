import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class DownloadError extends Error {
  override name = 'DownloadError';
}

export interface DownloadProgress {
  received: number;
  /** Total size in bytes, if the server reports it. */
  total: number | null;
}

export interface DownloadOptions {
  onProgress?: (progress: DownloadProgress) => void;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  md5Verified: boolean;
  /** `true` if an existing file was confirmed via MD5 and not downloaded again. */
  skipped: boolean;
}

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function md5OfFile(path: string): Promise<string> {
  const hash = createHash('md5');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** Geofabrik puts `<file>.md5` next to each extract, in the format `<hash>  <name>`. */
async function fetchExpectedMd5(url: string): Promise<string | null> {
  try {
    const res = await fetch(`${url}.md5`);
    if (!res.ok) return null;
    const match = /^([0-9a-f]{32})\b/i.exec((await res.text()).trim());
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/**
 * Downloads `url` to `dest`. Interrupted downloads are kept as `<dest>.part` and resumed
 * with a range request. If the server provides an `.md5`, the file is verified; an
 * existing file that matches is not downloaded again.
 */
export async function downloadExtract(
  url: string,
  dest: string,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  await mkdir(dirname(dest), { recursive: true });
  const expectedMd5 = await fetchExpectedMd5(url);

  const existing = await fileSize(dest);
  if (existing !== null && expectedMd5 && (await md5OfFile(dest)) === expectedMd5) {
    return { path: dest, bytes: existing, md5Verified: true, skipped: true };
  }

  const part = `${dest}.part`;
  const offset = (await fileSize(part)) ?? 0;
  const headers: Record<string, string> = offset > 0 ? { range: `bytes=${String(offset)}-` } : {};

  const res = await fetch(url, { headers });
  if (!res.ok || !res.body) {
    throw new DownloadError(`Download of ${url} failed: HTTP ${String(res.status)}`);
  }

  // 206 = resumed; with 200 the server sends the whole file, so start over.
  const resumed = res.status === 206 && offset > 0;
  let received = resumed ? offset : 0;
  const length = Number(res.headers.get('content-length'));
  const total = Number.isFinite(length) && length > 0 ? length + received : null;

  const progress = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      options.onProgress?.({ received, total });
      callback(null, chunk);
    },
  });

  await pipeline(
    Readable.fromWeb(res.body),
    progress,
    createWriteStream(part, { flags: resumed ? 'a' : 'w' }),
  );

  if (total !== null && received !== total) {
    throw new DownloadError(
      `Download of ${url} incomplete: ${String(received)} of ${String(total)} bytes`,
    );
  }

  if (expectedMd5) {
    const actual = await md5OfFile(part);
    if (actual !== expectedMd5) {
      await rm(part, { force: true });
      await rm(dest, { force: true });
      throw new DownloadError(
        `Checksum of ${url} does not match: expected ${expectedMd5}, got ${actual}`,
      );
    }
  }

  await rename(part, dest);
  return { path: dest, bytes: received, md5Verified: expectedMd5 !== null, skipped: false };
}
