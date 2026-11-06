/**
 * Measures the search response time directly on an index (without HTTP).
 *
 *   npm run bench -- --index /data/index.sqlite [--rounds 5]
 *
 * Queries: the golden queries plus every typing prefix (from 2 characters) of typical
 * inputs, with and without a location. Target from the roadmap: p95 below 50 ms.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { SearchIndex, type SearchOptions } from '../src/search/search-index.js';

const TARGET_MS = 50;

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
/** Lookahead: every word only typed in part ("gneis 62 düss" for Gneisenaustraße 62). */
const LOOKAHEAD = [
  'gneis 62 düss',
  'haupt 5 kref',
  'königs 1 düss',
  'schad 11 düss',
  'berl all düss',
  'fried 3 ess',
  'bahnh 1 dui',
  'kirchw 2 mön',
  'garten 10 wupp',
  'am mark 1 sol',
];
/** One typo in any word ("gnies 62 düs" for Gneisenaustraße 62). */
const TYPOS = [
  'gnies 62 düs',
  'gneis 62 dsseldorf',
  'schadwostr 11 düss',
  'bahnhofstrase 1 duisburg',
  'königsalee 1 düs',
  'dorothenstr 1 düs',
  'berliner alle düs',
  'hauptsrasse 5 krefeld',
  'mönchengladbch',
  'frierichstr 3 essen',
];
/** Düsseldorf; location bias enlarges the candidate set. */
const LOCATION = { lat: 51.2254, lon: 6.7763 };

const { values } = parseArgs({
  options: {
    index: { type: 'string' },
    rounds: { type: 'string', default: '5' },
  },
});
if (!values.index) {
  console.error('Usage: npm run bench -- --index <index.sqlite> [--rounds 5]');
  process.exit(1);
}

interface Golden {
  queries: { q: string; lat?: number; lon?: number }[];
}
const golden = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'test', 'golden', 'duesseldorf.json'), 'utf8'),
) as Golden;

const queries: SearchOptions[] = [];
for (const g of golden.queries) {
  queries.push({
    q: g.q,
    limit: 10,
    ...(g.lat !== undefined && g.lon !== undefined ? { lat: g.lat, lon: g.lon } : {}),
  });
}
for (const text of TYPED) {
  for (let n = 2; n <= text.length; n++) {
    const q = text.slice(0, n);
    if (q.trim().length < 2) continue;
    queries.push({ q, limit: 10 }, { q, limit: 10, ...LOCATION });
  }
}

for (const q of [...LOOKAHEAD, ...TYPOS]) {
  queries.push({ q, limit: 10 }, { q, limit: 10, ...LOCATION });
}

const index = new SearchIndex(values.index);
if (!index.open()) {
  console.error(`No index at ${values.index}`);
  process.exit(1);
}

// Warm-up (page cache, prepared statements)
for (const q of queries) index.search(q);

const rounds = Number(values.rounds);
const times: { ms: number; q: SearchOptions }[] = [];
for (let r = 0; r < rounds; r++) {
  for (const q of queries) {
    const start = performance.now();
    index.search(q);
    times.push({ ms: performance.now() - start, q });
  }
}
index.close();

times.sort((a, b) => a.ms - b.ms);
const pct = (p: number) =>
  times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))]?.ms ?? 0;
const fmt = (ms: number) => `${ms.toFixed(2)} ms`;
const p95 = pct(95);

console.log(`Index:     ${values.index}`);
console.log(
  `Queries:   ${String(queries.length)} × ${String(rounds)} rounds = ${String(times.length)}`,
);
console.log(`p50:       ${fmt(pct(50))}`);
console.log(`p95:       ${fmt(p95)}`);
console.log(`p99:       ${fmt(pct(99))}`);
console.log(`max:       ${fmt(times.at(-1)?.ms ?? 0)}`);
const special = new Set<string>([...LOOKAHEAD, ...TYPOS]);
for (const [label, keep] of [
  ['Typed', (q: string) => !special.has(q)],
  ['Lookahead', (q: string) => LOOKAHEAD.includes(q)],
  ['Typos', (q: string) => TYPOS.includes(q)],
] as const) {
  const ms = times.filter((t) => keep(t.q.q)).map((t) => t.ms);
  const p95Of = ms[Math.min(ms.length - 1, Math.floor(0.95 * ms.length))] ?? 0;
  console.log(`${label.padEnd(10)} p95 ${fmt(p95Of)} over ${String(ms.length)} queries`);
}
console.log('Slowest queries:');
const seen = new Set<string>();
for (const t of [...times].reverse()) {
  const key = `${t.q.q}${t.q.lat !== undefined ? ' (with location)' : ''}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`  ${fmt(t.ms).padStart(10)}  ${key}`);
  if (seen.size >= 10) break;
}
console.log(
  p95 <= TARGET_MS
    ? `OK: p95 ≤ ${String(TARGET_MS)} ms`
    : `TOO SLOW: p95 > ${String(TARGET_MS)} ms`,
);
process.exitCode = p95 <= TARGET_MS ? 0 : 2;
