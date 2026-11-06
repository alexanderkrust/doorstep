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

/**
 * Last token as a prefix, all others exact; all must occur.
 * `lastParts` replaces the prefix with its expansion (see `expandPrefix`).
 */
export function buildFtsQuery(
  tokens: readonly string[],
  lastParts?: readonly string[] | null,
): string | null {
  if (tokens.length === 0) return null;
  const head = tokens.slice(0, -1).map(quote);
  const last = tokens[tokens.length - 1] ?? '';
  const filter = isHousenumberPrefix(last) ? '- {postcode} : ' : '';
  if (lastParts && lastParts.length > 0) {
    // FTS5 requires an explicit AND before a parenthesis.
    const group = `${filter}(${lastParts.join(' OR ')})`;
    return head.length > 0 ? `${head.join(' ')} AND ${group}` : group;
  }
  return [...head, `${filter}${quote(last)}*`].join(' ');
}

/** Search words for bm25: the last one as a prefix, a partial house number not in the postcode. */
export function phrasesFor(tokens: readonly string[]): Phrase[] {
  return tokens.map((token, i) => {
    const isLast = i === tokens.length - 1;
    return { token, prefix: isLast, notInPostcode: isLast && isHousenumberPrefix(token) };
  });
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
