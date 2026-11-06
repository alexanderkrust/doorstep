/**
 * Metrics in the Prometheus text format (version 0.0.4). Deliberately without `prom-client`:
 * there are only a few fixed series, and the server is a single process.
 */

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Bucket bounds of the response time in seconds (target: well below 50 ms). */
const DURATION_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];

interface Histogram {
  /** Count per bucket (not cumulative); the last entry is above the largest bound. */
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
  /** Searches answered with 503 because the workers were too slow or too busy. */
  readonly searchRejected = { timeout: 0, overloaded: 0 };

  /** One answered request; `route` is the route pattern, never the concrete URL. */
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
      'Answered HTTP requests by method, route and status.',
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
      'Response time of HTTP requests in seconds.',
      histogramSamples,
    );

    metric(
      'doorstep_search_cache_hits_total',
      'counter',
      'Search requests served from the LRU cache.',
      [['', this.cacheHits]],
    );
    metric(
      'doorstep_search_cache_misses_total',
      'counter',
      'Cacheable search requests that were not in the cache.',
      [['', this.cacheMisses]],
    );
    metric('doorstep_rate_limited_total', 'counter', 'Requests rejected by the rate limit (429).', [
      ['', this.rateLimited],
    ]);

    metric(
      'doorstep_search_rejected_total',
      'counter',
      'Searches answered with 503 by reason (timeout: SEARCH_TIMEOUT_MS, overloaded: SEARCH_QUEUE_LIMIT).',
      (['timeout', 'overloaded'] as const).map((reason) => [
        labels({ reason }),
        this.searchRejected[reason],
      ]),
    );

    metric('doorstep_index_available', 'gauge', '1 if a usable index is loaded.', [
      ['', index.available ? 1 : 0],
    ]);
    const places = Number(index.meta?.['places']);
    if (Number.isFinite(places)) {
      metric('doorstep_index_places', 'gauge', 'Entries in the loaded index.', [['', places]]);
    }
    const importedAt = Date.parse(index.meta?.['imported_at'] ?? '');
    if (Number.isFinite(importedAt)) {
      metric(
        'doorstep_index_imported_timestamp_seconds',
        'gauge',
        'Time the loaded index was built (Unix time).',
        [['', importedAt / 1000]],
      );
    }
    metric(
      'doorstep_index_reloads_total',
      'counter',
      'Switches to a new index file without a restart.',
      [['', this.indexReloads]],
    );
    metric(
      'doorstep_index_reload_errors_total',
      'counter',
      'New index files that could not be loaded.',
      [['', this.indexReloadErrors]],
    );
    metric(
      'doorstep_updates_total',
      'counter',
      'Scheduled updates (UPDATE_CRON) by result.',
      (['success', 'failure', 'skipped'] as const).map((result) => [
        labels({ result }),
        this.updates.get(result) ?? 0,
      ]),
    );

    const memory = process.memoryUsage();
    metric('process_resident_memory_bytes', 'gauge', 'Resident set size of the process.', [
      ['', memory.rss],
    ]);
    metric('nodejs_heap_used_bytes', 'gauge', 'Used V8 heap.', [['', memory.heapUsed]]);
    metric('process_start_time_seconds', 'gauge', 'Start time of the process (Unix time).', [
      ['', Math.round(Date.now() / 1000 - process.uptime())],
    ]);

    return `${out.join('\n')}\n`;
  }
}
