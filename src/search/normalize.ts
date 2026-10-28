/**
 * Normalisierung für Index und Suche. Beide Seiten nutzen dieselben Funktionen,
 * damit "Königsallee", "koenigsallee" und "KÖNIGSALLEE" gleich behandelt werden.
 * Reine Funktionen.
 */

const UMLAUTS: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

/** Kombinierende diakritische Zeichen nach NFD-Zerlegung. */
const COMBINING = /\p{M}/gu;
/** Buchstaben ohne NFD-Zerlegung, die sonst übrig blieben. */
const SPECIAL: Record<string, string> = { ł: 'l', đ: 'd', ø: 'o', æ: 'ae', œ: 'oe', ı: 'i' };

/** "…str" am Wortende ist die übliche Abkürzung für "…straße". */
const STR_SUFFIX = /str$/;
/**
 * Drei s hintereinander ("Schloßstraße" → "schlossstrasse") werden zu zwei, damit
 * die verbreitete Schreibweise "Schlosstr." dieselbe Form ergibt.
 */
const TRIPLE_S = /s{3,}/g;

function fold(word: string, umlaut: (char: string) => string): string {
  return word
    .normalize('NFC')
    .toLowerCase()
    .replace(/[äöüß]/g, umlaut)
    .normalize('NFD')
    .replace(COMBINING, '')
    .replace(/[łđøæœı]/g, (c) => SPECIAL[c] ?? c)
    .replace(STR_SUFFIX, 'strasse')
    .replace(TRIPLE_S, 'ss');
}

/** "St." als eigenes Wort ist in Orts- und Straßennamen die Abkürzung für "Sankt". */
const SANKT_SHORT = 'st';
const SANKT = 'sankt';

/** Wie `normalizeWord`, dazu "st" → "sankt". Nur für vollständige Wörter (Index, Namen). */
function canonicalWord(word: string, fold: (word: string) => string): string {
  const folded = fold(word);
  return folded === SANKT_SHORT ? SANKT : folded;
}

/** Kleinschreibung, ä → ae, ß → ss, andere Akzente entfernt, "…str" → "…strasse". */
export function normalizeWord(word: string): string {
  return fold(word, (c) => UMLAUTS[c] ?? c);
}

/** Wie `normalizeWord`, aber ä → a (Schreibweise ohne Umlaut, z. B. "Dusseldorf"). */
function foldWithoutUmlautE(word: string): string {
  return fold(word, (c) => (c === 'ß' ? 'ss' : c));
}

/** Wörter aus Buchstaben und Ziffern; alles andere trennt (auch FTS5-Syntax). */
function words(text: string): string[] {
  return text.normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Eine ohne Leerzeichen angehängte Hausnummer ("Hauptstraße12a") wird abgetrennt.
 * Erst ab drei Buchstaben, damit Bezeichnungen wie "A7" oder "B1" zusammenbleiben.
 */
const GLUED_HOUSENUMBER = /^(\p{L}{3,})(\d+\p{L}?)$/u;

function splitGluedHousenumber(word: string): string[] {
  const match = GLUED_HOUSENUMBER.exec(word);
  return match?.[1] && match[2] ? [match[1], match[2]] : [word];
}

const HOUSENUMBER = /^\d+$/;
const SUFFIX = /^[a-z]$/;

/**
 * Zerlegt eine Suchanfrage in normalisierte Wörter. Eine abgetrennte
 * Hausnummer-Ergänzung ("60 d") wird angehängt ("60d"), wie sie in OSM steht; eine
 * angehängte Hausnummer ("Hauptstraße12") wird abgetrennt. "St." vor einem weiteren
 * Wort wird zu "sankt"; als letztes Wort bleibt "st" ein angefangenes Wort ("Stuttgart").
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
 * Text für eine Spalte des Volltextindex: alle Werte normalisiert, dazu die
 * Schreibweise ohne Umlaut-e ("dusseldorf"), damit auch sie gefunden wird.
 */
export function indexText(values: readonly (string | null | undefined)[]): string {
  const out = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const word of words(value)) {
      out.add(canonicalWord(word, normalizeWord));
      out.add(canonicalWord(word, foldWithoutUmlautE));
    }
  }
  return [...out].join(' ');
}

/** Ziffern mit einzelnem Buchstaben, auch mit Leerzeichen dazwischen ("12 a"). */
const NUMBER_WITH_SUFFIX = /(\d+)\s*([a-z])(?![a-z])/g;

/**
 * Text für die Hausnummer-Spalte: wie `indexText`, dazu die zusammengeschriebene
 * Form ("12 a" → auch "12a"), weil die Suche eine Ergänzung immer anhängt.
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

/** Normalisierte Formen eines Namens für den Namensvergleich im Ranking. */
export function nameForms(value: string | null | undefined): string[] {
  if (!value) return [];
  const parts = words(value);
  const forms = new Set([
    parts.map((p) => canonicalWord(p, normalizeWord)).join(' '),
    parts.map((p) => canonicalWord(p, foldWithoutUmlautE)).join(' '),
  ]);
  forms.delete('');
  return [...forms];
}
