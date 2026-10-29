/**
 * Ranking of search hits. Pure functions, so the formula can be tested without an index.
 *
 *   text          = 0.5 · bm25 relative to the best hit + 0.5 · name match
 *   no location:   score = 0.6 · text + 0.4 · importance
 *   with location: score = 0.45 · text + 0.3 · importance + 0.25 · proximity
 *
 * All parts are between 0 and 1, and so is the score.
 */

import { distanceKm } from './geo.js';

export interface Candidate {
  /** `bm25()` from FTS5: negative, the smaller the more relevant. */
  bm25: number;
  /** Importance of the type (0–1), see `importanceFor`. */
  importance: number;
  /** Normalized names (words separated by spaces); for addresses "street number". */
  names: readonly string[];
  /** Distance to the request's location; only set if lat/lon were given. */
  distanceKm?: number;
  /** A house number without a name: what an address query is looking for. */
  plainAddress?: boolean;
  /** The object's own names (without "street number"), if it has any. */
  ownNames?: readonly string[];
}

export interface ScoreContext {
  /** Normalized words of the query; the last one is a prefix. */
  queryTokens: readonly string[];
  /** Smallest (best) bm25 value of all candidates. */
  bestBm25: number;
}

/** At this distance, proximity is only worth half as much. */
export const LOCATION_BIAS_SCALE_KM = 5;
/** Factor for names that do not start with the query's first word. */
const NOT_AT_START = 0.7;
/**
 * Adjustment for queries with a house number: the plain address goes up, a named object that
 * only shares the address (a shop at "Marienplatz 8") goes down.
 */
const ADDRESS_QUERY_BONUS = 0.05;
const HOUSENUMBER = /^\d+[a-z]?$/;
/** Factor when the last word only matches as a prefix ("Königsallee 1" → "… 11"). */
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

  // Square root, so short names ("Düssel") do not rank too far ahead of long ones ("Düsseldorf").
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
 * How well does the query match one of the names? 1 = exactly equal; less if the name
 * is longer than the query, contains only part of the query, or does not start with it.
 */
export function nameMatch(queryTokens: readonly string[], names: readonly string[]): number {
  let best = 0;
  for (const name of names) best = Math.max(best, matchOne(queryTokens, name));
  return best;
}

/** Proximity to the location: 1 right at the point, 0.5 at `LOCATION_BIAS_SCALE_KM`. */
export function proximity(distanceKm: number): number {
  return LOCATION_BIAS_SCALE_KM / (LOCATION_BIAS_SCALE_KM + Math.max(0, distanceKm));
}

export function scoreCandidate(candidate: Candidate, ctx: ScoreContext): number {
  const relevance = ctx.bestBm25 < 0 ? clamp01(candidate.bm25 / ctx.bestBm25) : 1;
  const text = 0.5 * relevance + 0.5 * nameMatch(ctx.queryTokens, candidate.names);
  const importance = clamp01(candidate.importance);
  const base =
    candidate.distanceKm === undefined
      ? 0.6 * text + 0.4 * importance
      : 0.45 * text + 0.3 * importance + 0.25 * proximity(candidate.distanceKm);
  return clamp01(base + addressQueryAdjustment(candidate, ctx.queryTokens));
}

function addressQueryAdjustment(candidate: Candidate, queryTokens: readonly string[]): number {
  if (!queryTokens.some((t) => HOUSENUMBER.test(t))) return 0;
  if (candidate.plainAddress) return ADDRESS_QUERY_BONUS;
  const own = candidate.ownNames;
  if (own && own.length > 0 && nameMatch(queryTokens, own) === 0) return -ADDRESS_QUERY_BONUS;
  return 0;
}

/** Sorts the candidates by descending score (stable, without changing the input). */
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
 * Removes entries that match an earlier one with the same key within `radiusKm`
 * (e.g. the many segments of a street in OSM). The order is kept; the first
 * (best-ranked) entry wins.
 */
export function dedupeNearby<T extends { lat: number; lon: number }>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  radiusKm: number | ((row: T) => number),
): T[] {
  const radiusOf = typeof radiusKm === 'number' ? () => radiusKm : radiusKm;
  const kept: T[] = [];
  const byKey = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const same = byKey.get(key) ?? [];
    const radius = radiusOf(row);
    if (same.some((k) => distanceKm(k.lat, k.lon, row.lat, row.lon) <= radius)) continue;
    same.push(row);
    byKey.set(key, same);
    kept.push(row);
  }
  return kept;
}
