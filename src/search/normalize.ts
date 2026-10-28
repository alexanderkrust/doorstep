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

/** Wie `fold`, aber ohne das Kürzen von "sss": Dort ist die Wortgrenze noch zu sehen. */
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

/** "St." als eigenes Wort ist in Orts- und Straßennamen die Abkürzung für "Sankt". */
const SANKT_SHORT = 'st';
const SANKT = 'sankt';

/** Wie `normalizeWord`, dazu "st" → "sankt". Nur für vollständige Wörter (Index, Namen). */
function canonicalWord(word: string, fold: (word: string) => string): string {
  const folded = fold(word);
  return folded === SANKT_SHORT ? SANKT : folded;
}

const withUmlautE = (c: string) => UMLAUTS[c] ?? c;
const withoutUmlautE = (c: string) => (c === 'ß' ? 'ss' : c);

/** Kleinschreibung, ä → ae, ß → ss, andere Akzente entfernt, "…str" → "…strasse". */
export function normalizeWord(word: string): string {
  return fold(word, withUmlautE);
}

/** Eine Schreibweise für Index und Namen: mit Umlaut-e ("duesseldorf") oder ohne ("dusseldorf"). */
interface Folding {
  word: (word: string) => string;
  keepingS: (word: string) => string;
}

const FOLDINGS: readonly Folding[] = [
  { word: normalizeWord, keepingS: (w) => foldKeepingS(w, withUmlautE) },
  { word: (w) => fold(w, withoutUmlautE), keepingS: (w) => foldKeepingS(w, withoutUmlautE) },
];

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
 * Speichert die Ergebnisse einer Funktion je Text. Straße und Ort wiederholen sich
 * unter den Kandidaten einer Anfrage und beim Import ständig. Wird geleert, wenn er voll ist.
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

/** Wörter eines Werts für den Volltextindex, in beiden Schreibweisen und mit Varianten. */
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
 * Text für eine Spalte des Volltextindex: alle Werte normalisiert, dazu die
 * Schreibweise ohne Umlaut-e ("dusseldorf"), damit auch sie gefunden wird.
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
 * Grundwörter, die in Straßennamen mal angehängt ("Friedrichstraße"), mal
 * getrennt ("Friedrich Straße", "Konrad-Adenauer-Straße") stehen.
 */
const STREET_SUFFIXES = ['strasse', 'allee', 'platz', 'gasse', 'damm', 'ring', 'weg'];
/**
 * So lang muss der Wortanfang mindestens sein: beim Abtrennen ("Ostring" bleibt)
 * und beim Anhängen ("Am Ring" wird nicht zu "amring").
 */
const MIN_STEM_LENGTH = 4;

/**
 * Andere Schreibweisen eines Namens: mit abgetrenntem Grundwort
 * ("friedrichstrasse" → "friedrich strasse") und mit angehängtem
 * ("adenauer strasse" → "adenauerstrasse"). Leer, wenn es keine gibt.
 * `parts` sind die Wörter vor, `folded` nach der Normalisierung.
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
    // Vor dem Kürzen von "sss" trennen: "schlossstrasse" → "schloss", aber "rathausstrasse" → "rathaus".
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
