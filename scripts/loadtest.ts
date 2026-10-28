/**
 * Lasttest gegen eine laufende API über HTTP (mit autocannon).
 *
 *   npm run loadtest -- [--url http://127.0.0.1:2322] [--duration 20] [--connections 50]
 *                       [--api-key <key>] [--location]
 *
 * Anfragen: jedes Tipp-Präfix (ab 2 Zeichen) typischer Eingaben, reihum, wie
 * beim Autosuggest in einem Formular. Mit `--location` zusätzlich mit Standort.
 * Rate-Limiting begrenzt den Test sonst auf RATE_LIMIT pro Minute: dafür am Server
 * RATE_LIMIT_ENABLED=false setzen oder einen API-Key mit hohem Limit mitgeben.
 * Endet mit Exit-Code 1, wenn Anfragen fehlschlagen (Status ≠ 2xx oder Fehler).
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
  `Lasttest ${values.url}: ${values.connections} Verbindungen, ${values.duration} s, ` +
    `${String(paths.length)} verschiedene Anfragen`,
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
Anfragen gesamt   ${String(result.requests.total)}
Anfragen/s        ${result.requests.average.toFixed(0)} (Mittel), ${String(result.requests.max)} (Max)
Latenz p50        ${ms(result.latency.p50)}
Latenz p90        ${ms(result.latency.p90)}
Latenz p99        ${ms(result.latency.p99)}
Latenz max        ${ms(result.latency.max)}
Status ≠ 2xx      ${String(result.non2xx)}
Fehler/Timeouts   ${String(result.errors)} / ${String(result.timeouts)}`);

if (failed > 0) {
  console.error(`\n${String(failed)} Anfragen fehlgeschlagen`);
  process.exit(1);
}
