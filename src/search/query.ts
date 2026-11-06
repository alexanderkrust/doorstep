/** Translation of normalized words (see `normalizeTokens`) into FTS5 queries. Pure functions. */

import type { Phrase } from './bm25.js';
import { kindToken, RESULT_TYPES, type ResultType } from './result-type.js';
import type { TermDocs } from './term-stats.js';

/** The typo tolerance never trims the last token below this length. */
const MIN_TRIMMED_LENGTH = 3;
/** At most this many characters are cut off the end of the last token. */
const MAX_TRIM = 2;

const quote = (token: string) => `"${token.replaceAll('"', '""')}"`;

/** Looks like a house number ("12", "60d"). */
const HOUSENUMBER = /^\d+[a-z]?$/;
/** From this many digits on, a partial token can also be a postcode. */
const MIN_POSTCODE_PREFIX = 4;

/**
 * A partial house number ("4") must not match as a prefix of the postcode (40213),
 * otherwise it hits every address in that postcode area.
 */
function isHousenumberPrefix(token: string): boolean {
  return HOUSENUMBER.test(token) && token.replace(/\D/g, '').length < MIN_POSTCODE_PREFIX;
}

/** Columns with text from OSM; the `cell` column (grid cell) is not one of them. */
const TEXT_COLUMNS = '{name street housenumber postcode city}';

/**
 * Restricts a query to the text columns so search words never hit grid cells or result
 * types. With `types`, the hit must also have one of these result types (column `kind`).
 */
export function inTextColumns(match: string, types?: readonly ResultType[]): string {
  return `${TEXT_COLUMNS} : (${match})${kindFilter(types)}`;
}

/** Like `inTextColumns`; in addition, the hit must lie in one of the grid cells. */
export function withinCells(
  match: string,
  cells: readonly string[],
  types?: readonly ResultType[],
): string {
  return `${inTextColumns(match, types)} AND cell : (${cells.map(quote).join(' OR ')})`;
}

/** ` AND kind : (…)`; empty without types or with all of them. */
function kindFilter(types: readonly ResultType[] | undefined): string {
  if (!types || RESULT_TYPES.every((t) => types.includes(t))) return '';
  return ` AND kind : (${types.map((t) => quote(kindToken(t))).join(' OR ')})`;
}

/** Earlier words shorter than this stay exact: `"a"*` would read millions of documents. */
const MIN_LOOKAHEAD_LENGTH = 3;

/** A search word and how it is matched. */
export interface QueryWord {
  token: string;
  /** Also matches words that start with it. */
  prefix: boolean;
  /** A partial house number: not in the postcode (see `isHousenumberPrefix`). */
  notInPostcode: boolean;
}

/**
 * How the words are matched. The last word is always a prefix (the user is typing it). With
 * `lookahead`, so is every earlier word with letters and at least 3 characters ("gneis 62
 * düss"); numbers before the end stay exact: "62" followed by another word is complete, and
 * "62"* would also hit 620 and postcodes.
 */
export function queryWords(tokens: readonly string[], lookahead: boolean): QueryWord[] {
  return tokens.map((token, i) => {
    if (i === tokens.length - 1) {
      return { token, prefix: true, notInPostcode: isHousenumberPrefix(token) };
    }
    const prefix =
      lookahead && !/^\d/.test(token) && Array.from(token).length >= MIN_LOOKAHEAD_LENGTH;
    return { token, prefix, notInPostcode: false };
  });
}

/**
 * FTS5 query in which all words must occur. `parts[i]` replaces a word with an OR group: the
 * expansion of a prefix (see `expandPrefix`) or the corrections of a typo.
 */
export function buildWordsQuery(
  words: readonly QueryWord[],
  parts: readonly (readonly string[] | null | undefined)[] = [],
): string | null {
  if (words.length === 0) return null;
  const terms = words.map((word, i) => {
    const filter = word.notInPostcode ? '- {postcode} : ' : '';
    const expanded = parts[i];
    if (expanded && expanded.length > 0)
      return { text: `${filter}(${expanded.join(' OR ')})`, group: true };
    return { text: `${filter}${quote(word.token)}${word.prefix ? '*' : ''}`, group: false };
  });
  // FTS5 requires an explicit AND next to a parenthesis.
  const separator = terms.some((t) => t.group) ? ' AND ' : ' ';
  return terms.map((t) => t.text).join(separator);
}

/**
 * Last token as a prefix, all others exact; all must occur.
 * `lastParts` replaces the prefix with its expansion (see `expandPrefix`).
 */
export function buildFtsQuery(
  tokens: readonly string[],
  lastParts?: readonly string[] | null,
): string | null {
  const parts = tokens.map((_, i) => (i === tokens.length - 1 ? lastParts : null));
  return buildWordsQuery(queryWords(tokens, false), parts);
}

/** Search words for bm25, with the prefix flags of the words. */
export function phrasesForWords(words: readonly QueryWord[]): Phrase[] {
  return words.map(({ token, prefix, notInPostcode }) => ({ token, prefix, notInPostcode }));
}

/** Search words for bm25: the last one as a prefix, a partial house number not in the postcode. */
export function phrasesFor(tokens: readonly string[]): Phrase[] {
  return phrasesForWords(queryWords(tokens, false));
}

const sumDocs = (terms: readonly TermDocs[]) => terms.reduce((sum, t) => sum + t.docs, 0);

/**
 * Expands a prefix whose words include a very frequent one ("strasse"* with
 * 5 million documents). For prefixes without a prefix index (over 4 characters), FTS5
 * merges the hit lists of all matching words up front; exact words in an OR group,
 * on the other hand, are read only as far as needed.
 *
 * Subtrees with at most `maxDocs` documents stay one (longer) prefix; the rest are
 * split further character by character down to the frequent word, which is searched
 * exactly. Together, the parts cover exactly the words of `prefix`.
 * `null` if there is nothing to expand.
 */
export function expandPrefix(
  prefix: string,
  completions: readonly TermDocs[],
  maxDocs: number,
): string[] | null {
  if (sumDocs(completions) <= maxDocs) return null;
  const sorted = [...completions].sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
  return expandSorted(prefix, sorted, maxDocs);
}

function expandSorted(prefix: string, terms: readonly TermDocs[], maxDocs: number): string[] {
  if (terms.length === 1 && terms[0]?.term === prefix) return [quote(prefix)];
  if (terms.length === 1 || sumDocs(terms) <= maxDocs) return [`${quote(prefix)}*`];
  const parts: string[] = [];
  const children = new Map<string, TermDocs[]>();
  for (const t of terms) {
    if (t.term === prefix) {
      parts.push(quote(prefix));
      continue;
    }
    const child = prefix + (Array.from(t.term.slice(prefix.length))[0] ?? '');
    const group = children.get(child);
    if (group) group.push(t);
    else children.set(child, [t]);
  }
  for (const [child, group] of children) parts.push(...expandSorted(child, group, maxDocs));
  return parts;
}

/**
 * The query's words plus variants with a trimmed last token, so that a typo at the
 * end of a word ("Königsalleh") still finds Königsallee.
 */
export function tokenVariants(tokens: readonly string[]): string[][] {
  if (tokens.length === 0) return [];
  const variants = [[...tokens]];
  const head = tokens.slice(0, -1);
  const last = tokens[tokens.length - 1] ?? '';
  // Numbers are not trimmed: "1234" → "123"* would not be a typo but a different number.
  if (/^\d/.test(last)) return variants;
  const chars = Array.from(last);
  for (let trim = 1; trim <= MAX_TRIM && chars.length - trim >= MIN_TRIMMED_LENGTH; trim++) {
    variants.push([...head, chars.slice(0, -trim).join('')]);
  }
  return variants;
}

/** `tokenVariants` as FTS5 queries (without expanding the prefix). */
export function queryVariants(tokens: readonly string[]): string[] {
  return tokenVariants(tokens).flatMap((variant) => buildFtsQuery(variant) ?? []);
}

/**
 * For the street-level fallback: the words without house numbers; `null` if there
 * was no house number or nothing else is left.
 */
export function withoutHousenumbers(tokens: readonly string[]): string[] | null {
  const rest = tokens.filter((t) => !HOUSENUMBER.test(t));
  return rest.length === tokens.length || rest.length === 0 ? null : rest;
}

/** A single letter, not a digit. */
const SINGLE_LETTER = /^\p{L}$/u;

/**
 * For abbreviations like "Frankfurt a.M." or "Mülheim a.d. Ruhr": the words without
 * single letters; `null` if none is dropped or nothing else is left.
 */
export function withoutSingleLetters(tokens: readonly string[]): string[] | null {
  const rest = tokens.filter((t) => !SINGLE_LETTER.test(t));
  return rest.length === tokens.length || rest.length === 0 ? null : rest;
}

/** OR group of a word's corrections for `buildWordsQuery`. */
export function correctionGroup(tokens: readonly string[], prefix: boolean): string[] {
  return tokens.map((token) => `${quote(token)}${prefix ? '*' : ''}`);
}

/** Words shorter than this are not corrected: too many other words are one edit away. */
const MIN_FUZZY_LENGTH = 5;
/** Characters of normalized words (see `normalizeWord`): no umlauts, no ß. */
const FUZZY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A word that the typo tolerance may correct: letters only, at least 5 characters. */
export function isFuzzyCandidate(token: string): boolean {
  return /^\p{L}+$/u.test(token) && Array.from(token).length >= MIN_FUZZY_LENGTH;
}

/**
 * All words one edit away (Damerau-Levenshtein distance 1): a letter missing, an extra one, a
 * wrong one, or two neighbors swapped. Without the word itself and without duplicates; the
 * swaps and missing letters, the most common typos, come first.
 */
export function editVariants(token: string): string[] {
  const chars = Array.from(token);
  const out = new Set<string>();
  const join = (parts: readonly string[]) => parts.join('');
  for (let i = 0; i < chars.length - 1; i++) {
    const swapped = [...chars];
    [swapped[i], swapped[i + 1]] = [chars[i + 1] ?? '', chars[i] ?? ''];
    out.add(join(swapped));
  }
  for (let i = 0; i < chars.length; i++) out.add(join(chars.toSpliced(i, 1)));
  for (let i = 0; i < chars.length; i++) {
    for (const c of FUZZY_ALPHABET) out.add(join(chars.toSpliced(i, 1, c)));
  }
  for (let i = 0; i <= chars.length; i++) {
    for (const c of FUZZY_ALPHABET) out.add(join(chars.toSpliced(i, 0, c)));
  }
  out.delete(token);
  return [...out];
}

/** Edits the typo tolerance allows: none below 4 letters, 1 for 4–6, 2 from 7 on. */
export function maxEdits(length: number): number {
  if (length < 4) return 0;
  return length <= 6 ? 1 : 2;
}

/**
 * The word and every form with up to `d` letters removed, without duplicates (the keys of
 * SymSpell, see `fuzzyPrefixesOf`).
 */
export function deletions(word: string, d: number): string[] {
  const out = new Set([word]);
  let frontier = [word];
  for (let step = 0; step < d; step++) {
    const next: string[] = [];
    for (const form of frontier) {
      const chars = Array.from(form);
      for (let i = 0; i < chars.length; i++) {
        const shorter = chars.toSpliced(i, 1).join('');
        if (!out.has(shorter)) {
          out.add(shorter);
          next.push(shorter);
        }
      }
    }
    frontier = next;
  }
  return [...out];
}

/**
 * Edit distance with neighbor swaps (optimal string alignment): missing, extra and wrong
 * letters and two swapped neighbors count 1 each. Stops early once the distance is above `max`
 * and then returns `max + 1`.
 */
export function osaDistance(a: string, b: string, max: number): number {
  const s = Array.from(a);
  const t = Array.from(b);
  if (Math.abs(s.length - t.length) > max) return max + 1;
  let before: number[] = [];
  let previous = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let value = Math.min(
        (previous[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        value = Math.min(value, (before[j - 2] ?? 0) + 1);
      }
      row.push(value);
      best = Math.min(best, value);
    }
    if (best > max) return max + 1;
    before = previous;
    previous = row;
  }
  return Math.min(previous[t.length] ?? max + 1, max + 1);
}
