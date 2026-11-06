/**
 * HTTP helpers with timeouts for downloads. A large extract may take an hour, so there is no
 * limit on the whole download; instead it is aborted when the server sends no response or no
 * data for a while (DOWNLOAD_TIMEOUT_MS). Without that, a hanging connection would keep the
 * import lock forever.
 */
import { Transform } from 'node:stream';

export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;

export class HttpTimeoutError extends Error {
  override name = 'HttpTimeoutError';
}

const seconds = (ms: number) => String(ms / 1000);

/**
 * `fetch` that gives up when the response headers do not arrive within `timeoutMs`. The body
 * is not limited: stream it through `idleTimeout`, or use `fetchText` for small files.
 */
export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new HttpTimeoutError(`${url}: no response within ${seconds(timeoutMs)} s`));
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) throw controller.signal.reason as Error;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** A small text file (checksum, replication state), completely within `timeoutMs`. */
export async function fetchText(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; text: string }> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(url, { signal });
    return { ok: res.ok, status: res.status, text: res.ok ? await res.text() : '' };
  } catch (err) {
    if (signal.aborted) {
      throw new HttpTimeoutError(`${url}: no complete answer within ${seconds(timeoutMs)} s`);
    }
    throw err;
  }
}

/**
 * Passes data through unchanged and fails with `HttpTimeoutError` when no chunk arrives for
 * `timeoutMs`. Put it right after the response body in a `pipeline`.
 */
export function idleTimeout(timeoutMs: number, url: string): Transform {
  let timer: NodeJS.Timeout | undefined;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      arm();
      callback(null, chunk);
    },
    flush(callback) {
      clearTimeout(timer);
      callback();
    },
    destroy(err, callback) {
      clearTimeout(timer);
      callback(err);
    },
  });
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stream.destroy(new HttpTimeoutError(`${url}: no data for ${seconds(timeoutMs)} s`));
    }, timeoutMs);
  };
  arm();
  return stream;
}
