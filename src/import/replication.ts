/**
 * Diff updates: instead of downloading the whole extract again, apply the daily change files
 * (osmChange) that Geofabrik publishes for every extract under `<region>-updates/`. The
 * extract's PBF header names where they are and which sequence number it was built from.
 */
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import {
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  fetchText,
  fetchWithTimeout,
  HttpTimeoutError,
  idleTimeout,
} from './http.js';
import { OsmiumError } from './osmium.js';

/** State of a replication: sequence number and its timestamp. */
export interface ReplicationState {
  sequence: number;
  timestamp: string | null;
}

/** Replication state of an extract and where its diffs are. */
export interface ReplicationHeader extends ReplicationState {
  baseUrl: string;
}

/** Record of the last full download, next to the extract (`extract.state.json`). */
export interface ExtractRecord {
  regionUrl: string;
  fullDownloadAt: string;
}

/** At most this many diffs are applied; with more missing, the full download is faster. */
export const MAX_DIFFS = 30;
/**
 * After this many days since the last full download, download the whole extract again:
 * applied diffs can drift slightly from a fresh extract, mostly at the region's border.
 */
export const FULL_DOWNLOAD_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 4321 → "000/004/321", the path of a diff below the replication URL. */
export function sequencePath(sequence: number): string {
  const digits = String(sequence).padStart(9, '0');
  return `${digits.slice(0, 3)}/${digits.slice(3, 6)}/${digits.slice(6, 9)}`;
}

/** Reads a `state.txt` (`sequenceNumber=…`, `timestamp=…` with escaped colons). */
export function parseState(text: string): ReplicationState | null {
  const value = (key: string) =>
    new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1]?.trim().replaceAll('\\:', ':') ?? null;
  const raw = value('sequenceNumber');
  const sequence = raw === null || !/^\d+$/.test(raw) ? NaN : Number(raw);
  if (!Number.isInteger(sequence)) return null;
  return { sequence, timestamp: value('timestamp') };
}

/** Replication URL and sequence number from the PBF header; `null` without them. */
export async function readReplicationHeader(pbf: string): Promise<ReplicationHeader | null> {
  const json = await osmiumOutput(['fileinfo', '-j', pbf]);
  const option = (JSON.parse(json) as { header?: { option?: Record<string, string> } }).header
    ?.option;
  const baseUrl = option?.['osmosis_replication_base_url'];
  const sequence = Number(option?.['osmosis_replication_sequence_number']);
  if (!baseUrl || !Number.isInteger(sequence)) return null;
  return { baseUrl, sequence, timestamp: option['osmosis_replication_timestamp'] ?? null };
}

export type RefreshPlan =
  { kind: 'diff'; baseUrl: string; sequence: number } | { kind: 'full'; reason: string };

/** Diffs or the full download? Pure decision, see `refreshExtract` in pipeline.ts. */
export function planRefresh(input: {
  diffUpdates: boolean;
  regionUrl: string;
  record: ExtractRecord | null;
  header: ReplicationHeader | null;
  now: number;
}): RefreshPlan {
  const { diffUpdates, regionUrl, record, header, now } = input;
  if (!diffUpdates) return { kind: 'full', reason: 'DIFF_UPDATES is off' };
  if (!header && !record) return { kind: 'full', reason: 'there is no extract yet' };
  if (!header) return { kind: 'full', reason: 'the extract has no replication header' };
  if (!record) return { kind: 'full', reason: 'the last full download is not recorded' };
  if (record.regionUrl !== regionUrl) return { kind: 'full', reason: 'REGION_URL changed' };
  const age = now - Date.parse(record.fullDownloadAt);
  if (!(age <= FULL_DOWNLOAD_DAYS * DAY_MS)) {
    return {
      kind: 'full',
      reason: `the last full download is older than ${String(FULL_DOWNLOAD_DAYS)} days`,
    };
  }
  return { kind: 'diff', baseUrl: header.baseUrl, sequence: header.sequence };
}

export async function readExtractRecord(path: string): Promise<ExtractRecord | null> {
  try {
    const record = JSON.parse(await readFile(path, 'utf8')) as Partial<ExtractRecord>;
    return typeof record.regionUrl === 'string' && typeof record.fullDownloadAt === 'string'
      ? { regionUrl: record.regionUrl, fullDownloadAt: record.fullDownloadAt }
      : null;
  } catch {
    return null;
  }
}

export async function writeExtractRecord(path: string, record: ExtractRecord): Promise<void> {
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
}

export class ReplicationError extends Error {
  override name = 'ReplicationError';
}

export interface ReplicationFetchOptions {
  /** Abort after this long without a response or data (DOWNLOAD_TIMEOUT_MS). */
  timeoutMs?: number;
}

/** Timeouts become a `ReplicationError` with the same message. */
async function withReplicationError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpTimeoutError) throw new ReplicationError(err.message);
    throw err;
  }
}

/** The current state of the replication (`<base>/state.txt`). */
export async function fetchState(
  baseUrl: string,
  options: ReplicationFetchOptions = {},
): Promise<ReplicationState> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const res = await withReplicationError(() => fetchText(`${baseUrl}/state.txt`, timeoutMs));
  if (!res.ok) throw new ReplicationError(`${baseUrl}/state.txt: HTTP ${String(res.status)}`);
  const state = parseState(res.text);
  if (!state) throw new ReplicationError(`${baseUrl}/state.txt has no sequence number`);
  return state;
}

/**
 * Downloads the diff `sequence` to `dest` and checks that it decompresses completely (an
 * interrupted download or an error page does not). Returns the number of bytes.
 */
export async function downloadDiff(
  baseUrl: string,
  sequence: number,
  dest: string,
  options: ReplicationFetchOptions = {},
): Promise<number> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const url = `${baseUrl}/${sequencePath(sequence)}.osc.gz`;
  const res = await withReplicationError(() => fetchWithTimeout(url, timeoutMs));
  if (!res.ok || !res.body) throw new ReplicationError(`${url}: HTTP ${String(res.status)}`);
  await mkdir(dirname(dest), { recursive: true });
  const body = res.body;
  await withReplicationError(() =>
    pipeline(Readable.fromWeb(body), idleTimeout(timeoutMs, url), createWriteStream(dest)),
  );
  // Decompress once completely, without keeping anything.
  const discard = new Writable({
    write(_chunk: Buffer, _encoding, callback) {
      callback();
    },
  });
  try {
    await pipeline(createReadStream(dest), createGunzip(), discard);
  } catch (err) {
    throw new ReplicationError(`${url} is not a valid gzip file: ${String(err)}`);
  }
  return (await stat(dest)).size;
}

/**
 * Applies the diffs to `extract` and writes the result with the new replication state in
 * its header to `output`.
 */
export async function applyDiffs(
  extract: string,
  diffs: readonly string[],
  output: string,
  state: ReplicationHeader,
): Promise<void> {
  await rm(output, { force: true });
  await osmiumOutput([
    'apply-changes',
    extract,
    ...diffs,
    '-o',
    output,
    '--overwrite',
    `--output-header=osmosis_replication_base_url=${state.baseUrl}`,
    `--output-header=osmosis_replication_sequence_number=${String(state.sequence)}`,
    ...(state.timestamp
      ? [
          `--output-header=osmosis_replication_timestamp=${state.timestamp}`,
          `--output-header=timestamp=${state.timestamp}`,
        ]
      : []),
  ]);
}

/** Runs osmium and returns its stdout; throws `OsmiumError` on exit code ≠ 0. */
function osmiumOutput(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('osmium', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout);
      else {
        reject(
          new OsmiumError(
            `osmium ${args[0] ?? ''} failed (code ${String(code)}): ${stderr.trim()}`,
          ),
        );
      }
    });
  });
}
