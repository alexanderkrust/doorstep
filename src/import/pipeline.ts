import { createReadStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { downloadExtract, type DownloadProgress } from './download.js';
import { IndexWriter } from './index-writer.js';
import { acquireLock } from './lock.js';
import { readLines } from './lines.js';
import { BoundaryIndex } from './boundaries.js';
import {
  exportBoundaryGeoJsonSeq,
  exportGeoJsonSeq,
  exportRelationsOpl,
  filterBoundaries,
  filterExtract,
} from './osmium.js';
import { featureToPlace, parseGeoJsonSeqLine } from './place.js';

export const EXTRACT_FILE = 'extract.osm.pbf';
export const INDEX_FILE = 'index.sqlite';
export const NEXT_INDEX_FILE = 'index.next.sqlite';
/** Sperrt `dataDir`, solange ein Import oder Update läuft (siehe `acquireLock`). */
export const LOCK_FILE = 'import.lock.sqlite';
/**
 * Sperrdatei älterer Versionen (JSON mit PID und Host). Sie blieb liegen, wenn der
 * Container mitten im Import endete, und blockierte dann jeden neuen Container.
 */
export const LEGACY_LOCK_FILE = 'import.lock';

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
  boundaries?: BoundaryIndex,
): Promise<ImportResult> {
  await mkdir(dirname(output), { recursive: true });
  const tmp = nextPath(output);
  await rm(tmp, { force: true });

  const writer = new IndexWriter(
    tmp,
    boundaries ? { locate: (lat, lon) => boundaries.locate(lat, lon) } : {},
  );
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
    const places = writer.finish(boundaries ? { ...meta, ...boundaryMeta(boundaries) } : meta);
    await rename(tmp, output);
    return { features, places, skipped };
  } catch (err) {
    writer.abort();
    await rm(tmp, { force: true });
    throw err;
  }
}

function boundaryMeta(boundaries: BoundaryIndex): Record<string, string> {
  const { countries, states } = boundaries.summary;
  return { boundary_countries: countries.join(','), boundary_states: String(states) };
}

export interface GeoJsonSeqImportOptions {
  /** Grenzen für Land und Bundesland; ohne gelten `addr:country`/`addr:state`. */
  boundaries?: BoundaryIndex;
}

/** Importiert eine fertige GeoJSON-Sequenz (Ausgabe von `osmium export`). */
export async function importFromGeoJsonSeq(
  input: string,
  output: string,
  options: GeoJsonSeqImportOptions = {},
): Promise<ImportResult> {
  const openLines = () => readLines(createReadStream(input));
  return writeIndex(openLines, output, { source: input }, options.boundaries);
}

/**
 * Lädt Grenzen aus fertigen osmium-Ausgaben: GeoJSON-Sequenz (Flächen und Linien) und
 * OPL der Relationen. Für Tests und Fixtures ohne osmium.
 */
export async function loadBoundaryFiles(geojsonseq: string, opl: string): Promise<BoundaryIndex> {
  return BoundaryIndex.load(
    () => readLines(createReadStream(geojsonseq)),
    readLines(createReadStream(opl)),
    parseGeoJsonSeqLine,
  );
}

/** Filtert die Verwaltungsgrenzen aus einer PBF-Datei und lädt sie. */
export async function loadBoundariesFromPbf(
  input: string,
  workDir: string,
): Promise<BoundaryIndex> {
  const filtered = join(workDir, 'boundaries.osm.pbf');
  try {
    await filterBoundaries(input, filtered);
    return await BoundaryIndex.load(
      () => exportBoundaryGeoJsonSeq(filtered),
      exportRelationsOpl(filtered),
      parseGeoJsonSeqLine,
    );
  } finally {
    await rm(filtered, { force: true });
  }
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
    log('Lade Verwaltungsgrenzen (admin_level 2 und 4)');
    const boundaries = await loadBoundariesFromPbf(input, workDir);
    const { countries, states, borderSegments } = boundaries.summary;
    log(
      `Grenzen: Länder ${countries.join(', ') || 'keine'}, ${String(states)} Bundesländer, ` +
        `${String(borderSegments)} Abschnitte zu Nachbarländern`,
    );
    log(`Filtere ${input} mit osmium tags-filter`);
    await filterExtract(input, filtered);
    log('Exportiere und importiere Features');
    const result = await writeIndex(
      () => exportGeoJsonSeq(filtered),
      output,
      { source: options.source ?? input },
      boundaries,
    );
    const { inside, border, unknown } = boundaries.stats;
    log(
      `Land per Grenze: ${String(inside)} innerhalb, ${String(border)} über Nachbargrenze, ` +
        `${String(unknown)} ohne (addr:country bleibt)`,
    );
    return result;
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

/**
 * Kompletter Import: Download (falls nötig), Filter, Export, Index unter `dataDir`.
 * Wirft `LockError`, wenn dort bereits ein Import läuft.
 */
export async function runImport(options: RunImportOptions): Promise<ImportResult> {
  await mkdir(options.dataDir, { recursive: true });
  const release = await acquireLock(join(options.dataDir, LOCK_FILE));
  try {
    await rm(join(options.dataDir, LEGACY_LOCK_FILE), { force: true });
    return await runLockedImport(options);
  } finally {
    await release();
  }
}

async function runLockedImport(options: RunImportOptions): Promise<ImportResult> {
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
