/**
 * Normalization for index and search. Both sides use the same functions so that
 * "Königsallee", "koenigsallee" and "KÖNIGSALLEE" are treated the same.
 * Pure functions.
 */

const UMLAUTS: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

/** Combining diacritical marks after NFD decomposition. */
const COMBINING = /\p{M}/gu;
/** Letters without an NFD decomposition that would otherwise remain. */
const SPECIAL: Record<string, string> = { ł: 'l', đ: 'd', ø: 'o', æ: 'ae', œ: 'oe', ı: 'i' };

/** "…str" at the end of a word is the usual abbreviation for "…straße". */
const STR_SUFFIX = /str$/;
/**
 * Three s in a row ("Schloßstraße" → "schlossstrasse") become two, so that the common
 * spelling "Schlosstr." gives the same form.
 */
const TRIPLE_S = /s{3,}/g;

/** Like `fold`, but without collapsing "sss": there the word boundary is still visible. */
function foldKeepingS(word: string, umlaut: (char: string) => string): string {
  return word
    .normalize('NFC')
    .toLowerCase()
    .replace(/[äöüß]/g, umlaut)
    .normalize('NFD')
    .replace(COMBINING, '')
    .replace(/[łđøæœı]/g, (c) => SPECIAL[c] ?? c)
    .replace(STR_SUFFIX, 'strasse');
}

function fold(word: string, umlaut: (char: string) => string): string {
  return foldKeepingS(word, umlaut).replace(TRIPLE_S, 'ss');
}

/** "St." as a separate word in place and street names is the abbreviation for "Sankt". */
const SANKT_SHORT = 'st';
const SANKT = 'sankt';

/** Like `normalizeWord`, plus "st" → "sankt". Only for complete words (index, names). */
function canonicalWord(word: string, fold: (word: string) => string): string {
  const folded = fold(word);
  return folded === SANKT_SHORT ? SANKT : folded;
}

const withUmlautE = (c: string) => UMLAUTS[c] ?? c;
const withoutUmlautE = (c: string) => (c === 'ß' ? 'ss' : c);

/** Lowercase, ä → ae, ß → ss, other accents removed, "…str" → "…strasse". */
export function normalizeWord(word: string): string {
  return fold(word, withUmlautE);
}

/** One spelling for index and names: with umlaut e ("duesseldorf") or without ("dusseldorf"). */
interface Folding {
  word: (word: string) => string;
  keepingS: (word: string) => string;
}

const FOLDINGS: readonly Folding[] = [
  { word: normalizeWord, keepingS: (w) => foldKeepingS(w, withUmlautE) },
  { word: (w) => fold(w, withoutUmlautE), keepingS: (w) => foldKeepingS(w, withoutUmlautE) },
];

/** Words of letters and digits; everything else separates (FTS5 syntax too). */
function words(text: string): string[] {
  return text.normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * A house number attached without a space ("Hauptstraße12a") is split off.
 * Only from three letters on, so names like "A7" or "B1" stay together.
 */
const GLUED_HOUSENUMBER = /^(\p{L}{3,})(\d+\p{L}?)$/u;

function splitGluedHousenumber(word: string): string[] {
  const match = GLUED_HOUSENUMBER.exec(word);
  return match?.[1] && match[2] ? [match[1], match[2]] : [word];
}

const HOUSENUMBER = /^\d+$/;
const SUFFIX = /^[a-z]$/;

/**
 * Splits a search query into normalized words. A separate house number suffix
 * ("60 d") is attached ("60d"), as it appears in OSM; an attached house number
 * ("Hauptstraße12") is split off. "St." before another word becomes "sankt"; as the
 * last word, "st" stays a partial word ("Stuttgart").
 */
export function normalizeTokens(query: string): string[] {
  const tokens = words(query).flatMap(splitGluedHousenumber).map(normalizeWord);
  const result: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    const next = tokens[i + 1];
    if (HOUSENUMBER.test(token) && next !== undefined && SUFFIX.test(next)) {
      result.push(token + next);
      i++;
    } else if (token === SANKT_SHORT && next !== undefined) {
      result.push(SANKT);
    } else {
      result.push(token);
    }
  }
  return result;
}

/**
 * Stores a function's results per text. Street and city repeat constantly among a
 * query's candidates and during the import. Cleared when full.
 */
function memoize<T>(fn: (value: string) => T, maxSize = 10_000): (value: string) => T {
  const results = new Map<string, T>();
  return (value) => {
    let result = results.get(value);
    if (result === undefined) {
      if (results.size >= maxSize) results.clear();
      result = fn(value);
      results.set(value, result);
    }
    return result;
  };
}

/** Words of a value for the full-text index, in both spellings and with variants. */
const indexWords = memoize((value: string): readonly string[] => {
  const out = new Set<string>();
  const parts = words(value);
  for (const folding of FOLDINGS) {
    const folded = parts.map((p) => canonicalWord(p, folding.word));
    for (const word of folded) out.add(word);
    for (const form of compoundVariants(parts, folded, folding)) {
      for (const word of form) out.add(word);
    }
  }
  return [...out];
});

/**
 * Text for a column of the full-text index: all values normalized, plus the spelling
 * without umlaut e ("dusseldorf"), so that it is found as well.
 */
export function indexText(values: readonly (string | null | undefined)[]): string {
  const out = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const word of indexWords(value)) out.add(word);
  }
  return [...out].join(' ');
}

/**
 * Base words that are sometimes attached in street names ("Friedrichstraße") and
 * sometimes separate ("Friedrich Straße", "Konrad-Adenauer-Straße").
 */
const STREET_SUFFIXES = ['strasse', 'allee', 'platz', 'gasse', 'damm', 'ring', 'weg'];
/**
 * Minimum length of the word stem, both when splitting ("Ostring" stays) and when
 * joining ("Am Ring" does not become "amring").
 */
const MIN_STEM_LENGTH = 4;

/**
 * Other spellings of a name: with the base word split off
 * ("friedrichstrasse" → "friedrich strasse") and with it attached
 * ("adenauer strasse" → "adenauerstrasse"). Empty if there are none.
 * `parts` are the words before normalization, `folded` the words after.
 */
function compoundVariants(
  parts: readonly string[],
  folded: readonly string[],
  folding: Folding,
): string[][] {
  const split: string[] = [];
  const joined: string[] = [];
  let changedSplit = false;
  let changedJoin = false;
  for (const [i, word] of folded.entries()) {
    // Split before collapsing "sss": "schlossstrasse" → "schloss", but "rathausstrasse" → "rathaus".
    const long = folding.keepingS(parts[i] ?? '');
    const suffix = STREET_SUFFIXES.find(
      (s) => long.endsWith(s) && long.length - s.length >= MIN_STEM_LENGTH,
    );
    if (suffix) {
      split.push(long.slice(0, -suffix.length).replace(TRIPLE_S, 'ss'), suffix);
      changedSplit = true;
    } else {
      split.push(word);
    }
    const previous = folded[i - 1];
    if (
      STREET_SUFFIXES.includes(word) &&
      previous !== undefined &&
      previous.length >= MIN_STEM_LENGTH &&
      /\p{L}$/u.test(previous)
    ) {
      joined[joined.length - 1] = (previous + word).replace(TRIPLE_S, 'ss');
      changedJoin = true;
    } else {
      joined.push(word);
    }
  }
  return [...(changedSplit ? [split] : []), ...(changedJoin ? [joined] : [])];
}

/** Digits with a single letter, also with a space in between ("12 a"). */
const NUMBER_WITH_SUFFIX = /(\d+)\s*([a-z])(?![a-z])/g;

/**
 * Text for the house number column: like `indexText`, plus the joined form
 * ("12 a" → also "12a"), because the search always attaches a suffix.
 */
export function housenumberText(value: string | null | undefined): string {
  if (!value) return '';
  const out = new Set(indexText([value]).split(' '));
  for (const [, number, suffix] of value.toLowerCase().matchAll(NUMBER_WITH_SUFFIX)) {
    out.add(`${number ?? ''}${suffix ?? ''}`);
  }
  out.delete('');
  return [...out].join(' ');
}

/** Normalized forms of a name for the name comparison in the ranking. */
const nameFormsOf = memoize((value: string): readonly string[] => {
  const parts = words(value);
  const forms = new Set<string>();
  for (const folding of FOLDINGS) {
    const folded = parts.map((p) => canonicalWord(p, folding.word));
    forms.add(folded.join(' '));
    for (const variant of compoundVariants(parts, folded, folding)) forms.add(variant.join(' '));
  }
  forms.delete('');
  return [...forms];
});

export function nameForms(value: string | null | undefined): readonly string[] {
  return value ? nameFormsOf(value) : [];
}
