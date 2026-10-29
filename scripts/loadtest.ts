/**
 * Load test against a running API over HTTP (with autocannon).
 *
 *   npm run loadtest -- [--url http://127.0.0.1:2322] [--duration 20] [--connections 50]
 *                       [--api-key <key>] [--location]
 *
 * Queries: every typing prefix (from 2 characters) of typical inputs, in turn, as with
 * autosuggest in a form. With `--location` also with a location.
 * Otherwise rate limiting caps the test at RATE_LIMIT per minute: set
 * RATE_LIMIT_ENABLED=false on the server or pass an API key with a high limit.
 * Exits with code 1 if requests fail (status ≠ 2xx or errors).
 */
import { parseArgs } from 'node:util';
import autocannon from 'autocannon';

const TYPED = [
  'Hauptstraße 12',
  'Bahnhofstraße',
  'Königsallee 60d',
  'Düsseldorf',
  'Schadowstr. 11',
  'Kirchweg',
  'Am Markt 1',
  'Berliner Allee',
  'Friedrichstraße 3',
  'Gartenstraße',
];
const LOCATION = '&lat=51.2254&lon=6.7763';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:2322' },
    duration: { type: 'string', default: '20' },
    connections: { type: 'string', default: '50' },
    'api-key': { type: 'string' },
    location: { type: 'boolean', default: false },
  },
});

const paths: string[] = [];
for (const text of TYPED) {
  for (let n = 2; n <= text.length; n++) {
    const q = text.slice(0, n);
    if (q.trim().length < 2) continue;
    paths.push(`/api?q=${encodeURIComponent(q)}&limit=5`);
    if (values.location) paths.push(`/api?q=${encodeURIComponent(q)}&limit=5${LOCATION}`);
  }
}

const headers: Record<string, string> = {};
if (values['api-key']) headers['x-api-key'] = values['api-key'];

console.log(
  `Load test ${values.url}: ${values.connections} connections, ${values.duration} s, ` +
    `${String(paths.length)} different requests`,
);

const result = await autocannon({
  url: values.url,
  connections: Number(values.connections),
  duration: Number(values.duration),
  headers,
  requests: paths.map((path) => ({ method: 'GET', path })),
});

const failed = result.non2xx + result.errors + result.timeouts;
const ms = (v: number) => `${v.toFixed(1)} ms`;
console.log(`
Requests total    ${String(result.requests.total)}
Requests/s        ${result.requests.average.toFixed(0)} (mean), ${String(result.requests.max)} (max)
Latency p50       ${ms(result.latency.p50)}
Latency p90       ${ms(result.latency.p90)}
Latency p99       ${ms(result.latency.p99)}
Latency max       ${ms(result.latency.max)}
Status ≠ 2xx      ${String(result.non2xx)}
Errors/timeouts   ${String(result.errors)} / ${String(result.timeouts)}`);

if (failed > 0) {
  console.error(`\n${String(failed)} requests failed`);
  process.exit(1);
}
