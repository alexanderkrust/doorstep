/**
 * Kennzahlen im Prometheus-Textformat (Version 0.0.4). Bewusst ohne `prom-client`:
 * Es gibt nur wenige feste Reihen, und der Server ist ein einzelner Prozess.
 */

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Bucket-Grenzen der Antwortzeit in Sekunden (Ziel: deutlich unter 50 ms). */
const DURATION_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];

interface Histogram {
  /** Anzahl je Bucket (nicht kumuliert), letzter Eintrag = über der größten Grenze. */
  counts: number[];
  sum: number;
  count: number;
}

export interface IndexState {
  available: boolean;
  meta: Readonly<Record<string, string>> | null;
}

export type UpdateResult = 'success' | 'failure' | 'skipped';

const escapeLabel = (value: string) =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

const labels = (entries: Record<string, string>) =>
  `{${Object.entries(entries)
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
    .join(',')}}`;

export class Metrics {
  private readonly requests = new Map<string, number>();
  private readonly durations = new Map<string, Histogram>();
  private readonly updates = new Map<UpdateResult, number>();
  cacheHits = 0;
  cacheMisses = 0;
  rateLimited = 0;
  indexReloads = 0;
  indexReloadErrors = 0;

  /** Eine beantwortete Anfrage; `route` ist das Routenmuster, nie die konkrete URL. */
  observeRequest(method: string, route: string, status: number, seconds: number): void {
    const key = labels({ method, route, status: String(status) });
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    if (status === 429) this.rateLimited++;

    let histogram = this.durations.get(route);
    if (!histogram) {
      histogram = {
        counts: new Array<number>(DURATION_BUCKETS.length + 1).fill(0),
        sum: 0,
        count: 0,
      };
      this.durations.set(route, histogram);
    }
    const bucket = DURATION_BUCKETS.findIndex((le) => seconds <= le);
    const slot = bucket === -1 ? DURATION_BUCKETS.length : bucket;
    histogram.counts[slot] = (histogram.counts[slot] ?? 0) + 1;
    histogram.sum += seconds;
    histogram.count++;
  }

  observeUpdate(result: UpdateResult): void {
    this.updates.set(result, (this.updates.get(result) ?? 0) + 1);
  }

  render(index: IndexState): string {
    const out: string[] = [];
    const metric = (name: string, type: string, help: string, samples: [string, number][]) => {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [suffix, value] of samples) out.push(`${name}${suffix} ${String(value)}`);
    };

    metric(
      'doorstep_http_requests_total',
      'counter',
      'Beantwortete HTTP-Anfragen nach Methode, Route und Status.',
      [...this.requests],
    );

    const histogramSamples: [string, number][] = [];
    for (const [route, h] of this.durations) {
      let cumulative = 0;
      DURATION_BUCKETS.forEach((le, i) => {
        cumulative += h.counts[i] ?? 0;
        histogramSamples.push([`_bucket${labels({ route, le: String(le) })}`, cumulative]);
      });
      histogramSamples.push([`_bucket${labels({ route, le: '+Inf' })}`, h.count]);
      histogramSamples.push([`_sum${labels({ route })}`, h.sum]);
      histogramSamples.push([`_count${labels({ route })}`, h.count]);
    }
    metric(
      'doorstep_http_request_duration_seconds',
      'histogram',
      'Antwortzeit der HTTP-Anfragen in Sekunden.',
      histogramSamples,
    );

    metric('doorstep_search_cache_hits_total', 'counter', 'Suchanfragen aus dem LRU-Cache.', [
      ['', this.cacheHits],
    ]);
    metric(
      'doorstep_search_cache_misses_total',
      'counter',
      'Cachebare Suchanfragen, die nicht im Cache lagen.',
      [['', this.cacheMisses]],
    );
    metric(
      'doorstep_rate_limited_total',
      'counter',
      'Wegen Rate-Limit abgewiesene Anfragen (429).',
      [['', this.rateLimited]],
    );

    metric('doorstep_index_available', 'gauge', '1, wenn ein nutzbarer Index geladen ist.', [
      ['', index.available ? 1 : 0],
    ]);
    const places = Number(index.meta?.['places']);
    if (Number.isFinite(places)) {
      metric('doorstep_index_places', 'gauge', 'Einträge im geladenen Index.', [['', places]]);
    }
    const importedAt = Date.parse(index.meta?.['imported_at'] ?? '');
    if (Number.isFinite(importedAt)) {
      metric(
        'doorstep_index_imported_timestamp_seconds',
        'gauge',
        'Zeitpunkt, zu dem der geladene Index gebaut wurde (Unix-Zeit).',
        [['', importedAt / 1000]],
      );
    }
    metric(
      'doorstep_index_reloads_total',
      'counter',
      'Wechsel auf eine neue Indexdatei ohne Neustart.',
      [['', this.indexReloads]],
    );
    metric(
      'doorstep_index_reload_errors_total',
      'counter',
      'Neue Indexdateien, die nicht geladen werden konnten.',
      [['', this.indexReloadErrors]],
    );
    metric(
      'doorstep_updates_total',
      'counter',
      'Geplante Updates (UPDATE_CRON) nach Ergebnis.',
      (['success', 'failure', 'skipped'] as const).map((result) => [
        labels({ result }),
        this.updates.get(result) ?? 0,
      ]),
    );

    const memory = process.memoryUsage();
    metric('process_resident_memory_bytes', 'gauge', 'Resident Set Size des Prozesses.', [
      ['', memory.rss],
    ]);
    metric('nodejs_heap_used_bytes', 'gauge', 'Belegter V8-Heap.', [['', memory.heapUsed]]);
    metric('process_start_time_seconds', 'gauge', 'Startzeit des Prozesses (Unix-Zeit).', [
      ['', Math.round(Date.now() / 1000 - process.uptime())],
    ]);

    return `${out.join('\n')}\n`;
  }
}
