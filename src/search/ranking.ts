/**
 * Ranking der Suchtreffer. Reine Funktionen, damit sich die Formel ohne Index testen lässt.
 *
 *   text      = 0.5 · bm25 relativ zum besten Treffer + 0.5 · Namensübereinstimmung
 *   ohne Ort: score = 0.6 · text + 0.4 · importance
 *   mit Ort:  score = 0.45 · text + 0.3 · importance + 0.25 · Nähe
 *
 * Alle Teilwerte liegen zwischen 0 und 1, der Score also auch.
 */

import { distanceKm } from './geo.js';

export interface Candidate {
  /** `bm25()` aus FTS5: negativ, je kleiner desto relevanter. */
  bm25: number;
  /** Wichtigkeit des Typs (0–1), siehe `importanceFor`. */
  importance: number;
  /** Normalisierte Namen (Wörter durch Leerzeichen getrennt); bei Adressen "straße nummer". */
  names: readonly string[];
  /** Entfernung zum Standort der Anfrage; nur gesetzt, wenn lat/lon mitgegeben wurden. */
  distanceKm?: number;
}

export interface ScoreContext {
  /** Normalisierte Wörter der Anfrage, das letzte ist ein Präfix. */
  queryTokens: readonly string[];
  /** Kleinster (bester) bm25-Wert aller Kandidaten. */
  bestBm25: number;
}

/** Ab dieser Entfernung ist die Nähe nur noch halb so viel wert. */
export const LOCATION_BIAS_SCALE_KM = 5;
/** Faktor für Namen, die nicht mit dem ersten Wort der Anfrage beginnen. */
const NOT_AT_START = 0.7;
/** Faktor, wenn das letzte Wort nur als Präfix passt ("Königsallee 1" → "… 11"). */
const PREFIX_ONLY = 0.9;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function matchOne(query: readonly string[], name: string): number {
  const nameTokens = name.split(' ').filter(Boolean);
  const nameChars = nameTokens.reduce((sum, t) => sum + t.length, 0);
  if (nameChars === 0 || query.length === 0) return 0;

  const used = new Set<number>();
  let matchedChars = 0;
  let matchedQuery = 0;
  let allExact = true;
  for (const [i, q] of query.entries()) {
    const isLast = i === query.length - 1;
    const exact = nameTokens.findIndex((t, j) => !used.has(j) && t === q);
    const prefix = isLast ? nameTokens.findIndex((t, j) => !used.has(j) && t.startsWith(q)) : -1;
    const hit = exact >= 0 ? exact : prefix;
    if (hit < 0) continue;
    used.add(hit);
    matchedQuery++;
    if (exact < 0) allExact = false;
    matchedChars += exact >= 0 ? (nameTokens[hit]?.length ?? 0) : q.length;
  }
  if (matchedQuery === 0) return 0;

  // Wurzel, damit kurze Namen ("Düssel") nicht zu stark vor langen ("Düsseldorf") liegen.
  const nameCoverage = Math.sqrt(matchedChars / nameChars);
  const queryCoverage = matchedQuery / query.length;
  const first = query[0] ?? '';
  const startsWith =
    nameTokens[0] === first || (query.length === 1 && nameTokens[0]?.startsWith(first));
  return clamp01(
    nameCoverage * queryCoverage * (startsWith ? 1 : NOT_AT_START) * (allExact ? 1 : PREFIX_ONLY),
  );
}

/**
 * Wie gut passt die Anfrage zu einem der Namen? 1 = exakt gleich; weniger, wenn
 * der Name länger ist als die Anfrage, nur einen Teil der Anfrage enthält oder
 * nicht mit ihr beginnt.
 */
export function nameMatch(queryTokens: readonly string[], names: readonly string[]): number {
  let best = 0;
  for (const name of names) best = Math.max(best, matchOne(queryTokens, name));
  return best;
}

/** Nähe zum Standort: 1 direkt am Punkt, 0,5 bei `LOCATION_BIAS_SCALE_KM`. */
export function proximity(distanceKm: number): number {
  return LOCATION_BIAS_SCALE_KM / (LOCATION_BIAS_SCALE_KM + Math.max(0, distanceKm));
}

export function scoreCandidate(candidate: Candidate, ctx: ScoreContext): number {
  const relevance = ctx.bestBm25 < 0 ? clamp01(candidate.bm25 / ctx.bestBm25) : 1;
  const text = 0.5 * relevance + 0.5 * nameMatch(ctx.queryTokens, candidate.names);
  const importance = clamp01(candidate.importance);
  if (candidate.distanceKm === undefined) {
    return 0.6 * text + 0.4 * importance;
  }
  return 0.45 * text + 0.3 * importance + 0.25 * proximity(candidate.distanceKm);
}

/** Sortiert die Kandidaten absteigend nach Score (stabil, ohne die Eingabe zu ändern). */
export function rank<T extends Candidate>(
  candidates: readonly T[],
  queryTokens: readonly string[],
): T[] {
  const bestBm25 = candidates.reduce((best, c) => Math.min(best, c.bm25), 0);
  const ctx = { queryTokens, bestBm25 };
  return candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, ctx) }))
    .sort((a, b) => b.score - a.score)
    .map((s) => s.candidate);
}

/**
 * Entfernt Einträge, die einem früheren mit gleichem Schlüssel im Umkreis von
 * `radiusKm` entsprechen (z. B. die vielen Abschnitte einer Straße in OSM).
 * Reihenfolge bleibt erhalten, der erste (bestgerankte) Eintrag gewinnt.
 */
export function dedupeNearby<T extends { lat: number; lon: number }>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  radiusKm: number,
): T[] {
  const kept: T[] = [];
  const byKey = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const same = byKey.get(key) ?? [];
    if (same.some((k) => distanceKm(k.lat, k.lon, row.lat, row.lon) <= radiusKm)) continue;
    same.push(row);
    byKey.set(key, same);
    kept.push(row);
  }
  return kept;
}
