import { createReadStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { downloadExtract, type DownloadProgress } from './download.js';
import { IndexWriter } from './index-writer.js';
import { readLines } from './lines.js';
import { exportGeoJsonSeq, filterExtract } from './osmium.js';
import { featureToPlace, parseGeoJsonSeqLine } from './place.js';

export const EXTRACT_FILE = 'extract.osm.pbf';
export const INDEX_FILE = 'index.sqlite';
export const NEXT_INDEX_FILE = 'index.next.sqlite';

export interface ImportResult {
  /** Anzahl der gelesenen Features. */
  features: number;
  /** Anzahl der Zeilen im Index. */
  places: number;
  /** Features, die nicht in den Index gehören (z. B. unbenannte Straßen). */
  skipped: number;
}

export type Logger = (message: string) => void;

/** `/data/index.sqlite` → `/data/index.next.sqlite` */
function nextPath(output: string): string {
  return output.endsWith('.sqlite')
    ? `${output.slice(0, -'.sqlite'.length)}.next.sqlite`
    : `${output}.next`;
}

/**
 * Schreibt die Features in eine neue Datei neben `output` und ersetzt `output`
 * erst am Ende per atomarem rename. Bei Fehlern bleibt ein alter Index unberührt.
 */
async function writeIndex(
  openLines: () => AsyncIterable<string>,
  output: string,
  meta: Record<string, string>,
): Promise<ImportResult> {
  await mkdir(dirname(output), { recursive: true });
  const tmp = nextPath(output);
  await rm(tmp, { force: true });

  const writer = new IndexWriter(tmp);
  let features = 0;
  let skipped = 0;
  try {
    // Erst hier öffnen, damit keine Daten anlaufen, bevor jemand liest.
    for await (const line of openLines()) {
      const feature = parseGeoJsonSeqLine(line);
      if (!feature) continue;
      features++;
      const place = featureToPlace(feature);
      if (place) writer.add(place);
      else skipped++;
    }
    const places = writer.finish(meta);
    await rename(tmp, output);
    return { features, places, skipped };
  } catch (err) {
    writer.abort();
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Importiert eine fertige GeoJSON-Sequenz (Ausgabe von `osmium export`). */
export async function importFromGeoJsonSeq(input: string, output: string): Promise<ImportResult> {
  const openLines = () => readLines(createReadStream(input));
  return writeIndex(openLines, output, { source: input });
}

export interface PbfImportOptions {
  /** Verzeichnis für die gefilterte Zwischendatei (Default: neben `output`). */
  workDir?: string;
  source?: string;
  log?: Logger;
}

/** Filtert eine PBF-Datei mit osmium und importiert sie per Streaming. */
export async function importFromPbf(
  input: string,
  output: string,
  options: PbfImportOptions = {},
): Promise<ImportResult> {
  const log = options.log ?? (() => undefined);
  const workDir = options.workDir ?? dirname(output);
  await mkdir(workDir, { recursive: true });
  const filtered = join(workDir, 'filtered.osm.pbf');

  try {
    log(`Filtere ${input} mit osmium tags-filter`);
    await filterExtract(input, filtered);
    log('Exportiere und importiere Features');
    return await writeIndex(() => exportGeoJsonSeq(filtered), output, {
      source: options.source ?? input,
    });
  } finally {
    await rm(filtered, { force: true });
  }
}

export interface RunImportOptions {
  dataDir: string;
  regionUrl: string;
  /** Lokale PBF-Datei statt Download. */
  input?: string;
  log?: Logger;
}

function formatProgress({ received, total }: DownloadProgress): string {
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  return total
    ? `${mb(received)} / ${mb(total)} MB (${((received / total) * 100).toFixed(0)} %)`
    : `${mb(received)} MB`;
}

/** Kompletter Import: Download (falls nötig), Filter, Export, Index unter `dataDir`. */
export async function runImport(options: RunImportOptions): Promise<ImportResult> {
  const log = options.log ?? (() => undefined);
  let input = options.input;
  let source = input;

  if (!input) {
    input = join(options.dataDir, EXTRACT_FILE);
    source = options.regionUrl;
    log(`Lade ${options.regionUrl}`);
    let lastLog = 0;
    const download = await downloadExtract(options.regionUrl, input, {
      onProgress: (p) => {
        const now = Date.now();
        if (now - lastLog >= 5000) {
          lastLog = now;
          log(`Download: ${formatProgress(p)}`);
        }
      },
    });
    log(
      download.skipped
        ? 'Vorhandener Extrakt ist aktuell (MD5 passt), kein Download nötig'
        : `Download fertig${download.md5Verified ? ', MD5 geprüft' : ' (keine MD5 verfügbar)'}`,
    );
  }

  const output = join(options.dataDir, INDEX_FILE);
  const result = await importFromPbf(input, output, {
    workDir: options.dataDir,
    log,
    ...(source ? { source } : {}),
  });
  log(`Index ${output} mit ${String(result.places)} Einträgen erstellt`);
  return result;
}
