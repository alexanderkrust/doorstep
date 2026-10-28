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

function fold(word: string, umlaut: (char: string) => string): string {
  return word
    .normalize('NFC')
    .toLowerCase()
    .replace(/[äöüß]/g, umlaut)
    .normalize('NFD')
    .replace(COMBINING, '')
    .replace(/[łđøæœı]/g, (c) => SPECIAL[c] ?? c)
    .replace(STR_SUFFIX, 'strasse');
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

const HOUSENUMBER = /^\d+$/;
const SUFFIX = /^[a-z]$/;

/**
 * Zerlegt eine Suchanfrage in normalisierte Wörter. Eine abgetrennte
 * Hausnummer-Ergänzung ("60 d") wird angehängt ("60d"), wie sie in OSM steht.
 */
export function normalizeTokens(query: string): string[] {
  const tokens = words(query).map(normalizeWord);
  const result: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    const next = tokens[i + 1];
    if (HOUSENUMBER.test(token) && next !== undefined && SUFFIX.test(next)) {
      result.push(token + next);
      i++;
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
      out.add(normalizeWord(word));
      out.add(foldWithoutUmlautE(word));
    }
  }
  return [...out].join(' ');
}

/** Normalisierte Formen eines Namens für den Namensvergleich im Ranking. */
export function nameForms(value: string | null | undefined): string[] {
  if (!value) return [];
  const parts = words(value);
  const forms = new Set([
    parts.map(normalizeWord).join(' '),
    parts.map(foldWithoutUmlautE).join(' '),
  ]);
  forms.delete('');
  return [...forms];
}
