/**
 * Typo tolerance after SymSpell, for word starts. The import stores, for every word start of 4 to
 * 7 letters, its forms with letters removed (table `fuzzy_deletes`). A query word with a typo
 * then only needs the forms of its own start: two words within `d` edits share such a form.
 * Instead of generating all variants of a word (hundreds of thousands for 2 edits), the search
 * looks up a few dozen keys.
 */
import { deletions, maxEdits, osaDistance } from './query.js';
import type { TermDocs } from './term-stats.js';

/** Word starts up to this length are stored; longer words are compared beyond it. */
export const FUZZY_PREFIX_LENGTH = 7;
const MIN_FUZZY_PREFIX = 4;
const LETTERS = /^\p{L}+$/u;

/** Rows `[deletion, word start]` of `fuzzy_deletes` for a word of the index. */
export function fuzzyPrefixesOf(term: string): [string, string][] {
  if (!LETTERS.test(term)) return [];
  const chars = Array.from(term);
  const rows: [string, string][] = [];
  const max = Math.min(chars.length, FUZZY_PREFIX_LENGTH);
  for (let n = MIN_FUZZY_PREFIX; n <= max; n++) {
    const prefix = chars.slice(0, n).join('');
    for (const del of deletions(prefix, maxEdits(n))) rows.push([del, prefix]);
  }
  return rows;
}

/**
 * All rows of `fuzzy_deletes` for the words of the index, each word start only once (many
 * words share their start).
 */
export function* fuzzyRows(terms: Iterable<string>): Generator<[string, string]> {
  const seen = new Set<string>();
  for (const term of terms) {
    if (!LETTERS.test(term)) continue;
    const chars = Array.from(term);
    const max = Math.min(chars.length, FUZZY_PREFIX_LENGTH);
    for (let n = MIN_FUZZY_PREFIX; n <= max; n++) {
      const prefix = chars.slice(0, n).join('');
      if (seen.has(prefix)) continue;
      seen.add(prefix);
      for (const del of deletions(prefix, maxEdits(n))) yield [del, prefix];
    }
  }
}

/** Access to the word statistics; `TermStats` in the search, a word list in tests. */
export interface FuzzySource {
  /** Word starts in `fuzzy_deletes` that have one of these deletions. */
  prefixes(keys: readonly string[]): string[];
  /** Words starting with `prefix`. */
  completions(prefix: string): TermDocs[];
  /** Documents with exactly this word. */
  docs(term: string): number;
  /** Documents with a word starting with `prefix`. */
  prefixDocs(prefix: string): number;
}

interface Correction {
  token: string;
  distance: number;
  docs: number;
}

/**
 * Words of the index within `maxEdits` of `token`: with `prefix`, word starts (the user is
 * still typing), otherwise whole words. Fewest edits first, then the most documents; at most
 * `limit`.
 */
export function fuzzyCorrections(
  token: string,
  prefix: boolean,
  source: FuzzySource,
  limit = 12,
): string[] {
  return fuzzyCandidates(token, prefix, source, limit).map((c) => c.token);
}

/** A correction and its number of edits. */
export interface FuzzyCandidate {
  token: string;
  distance: number;
}

/** Like `fuzzyCorrections`, with the number of edits of each correction. */
export function fuzzyCandidates(
  token: string,
  prefix: boolean,
  source: FuzzySource,
  limit = 12,
): FuzzyCandidate[] {
  const chars = Array.from(token);
  const length = chars.length;
  const d = maxEdits(length);
  if (d === 0 || !LETTERS.test(token)) return [];
  const key = chars.slice(0, FUZZY_PREFIX_LENGTH).join('');
  const found = new Map<string, Correction>();
  const add = (correction: string, distance: number, docs: number) => {
    const known = found.get(correction);
    if (!known || distance < known.distance)
      found.set(correction, { token: correction, distance, docs });
    else if (distance === known.distance) known.docs = Math.max(known.docs, docs);
  };

  for (const start of source.prefixes(deletions(key, d))) {
    if (prefix && length <= FUZZY_PREFIX_LENGTH) {
      // The whole query word fits into the stored word starts.
      const distance = osaDistance(token, start, d);
      if (distance <= d) add(start, distance, source.prefixDocs(start));
      continue;
    }
    if (osaDistance(key, start, d) > d) continue;
    // Words longer than the stored start: compare them as a whole (or their start).
    const words =
      Array.from(start).length === FUZZY_PREFIX_LENGTH
        ? source.completions(start)
        : [{ term: start, docs: source.docs(start) }].filter((t) => t.docs > 0);
    for (const { term, docs } of words) {
      if (!prefix) {
        const distance = osaDistance(token, term, d);
        if (distance <= d) add(term, distance, docs);
        continue;
      }
      const termChars = Array.from(term);
      let best: { start: string; distance: number } | null = null;
      for (let k = Math.max(1, length - d); k <= Math.min(termChars.length, length + d); k++) {
        const candidate = termChars.slice(0, k).join('');
        const distance = osaDistance(token, candidate, d);
        if (distance <= d && (!best || distance < best.distance))
          best = { start: candidate, distance };
      }
      if (best) add(best.start, best.distance, docs);
    }
  }
  return [...found.values()]
    .sort((a, b) => a.distance - b.distance || b.docs - a.docs)
    .slice(0, limit)
    .map(({ token: correction, distance }) => ({ token: correction, distance }));
}
