/** Übersetzung normalisierter Wörter (siehe `normalizeTokens`) in FTS5-Queries. Reine Funktionen. */

/** Kürzer wird das letzte Token bei der Tippfehler-Toleranz nicht. */
const MIN_TRIMMED_LENGTH = 3;
/** So viele Zeichen werden am Ende des letzten Tokens höchstens abgeschnitten. */
const MAX_TRIM = 2;

const quote = (token: string) => `"${token.replaceAll('"', '""')}"`;

/** Letztes Token als Präfix, alle anderen exakt; alle müssen vorkommen. */
export function buildFtsQuery(tokens: readonly string[]): string | null {
  if (tokens.length === 0) return null;
  const head = tokens.slice(0, -1).map(quote);
  const last = tokens[tokens.length - 1] ?? '';
  return [...head, `${quote(last)}*`].join(' ');
}

/**
 * Die eigentliche Query plus Varianten mit gekürztem letztem Token, damit ein
 * Tippfehler am Wortende ("Königsalleh") noch die Königsallee findet.
 */
export function queryVariants(tokens: readonly string[]): string[] {
  const first = buildFtsQuery(tokens);
  if (first === null) return [];
  const variants = [first];
  const head = tokens.slice(0, -1);
  const chars = Array.from(tokens[tokens.length - 1] ?? '');
  for (let trim = 1; trim <= MAX_TRIM && chars.length - trim >= MIN_TRIMMED_LENGTH; trim++) {
    const variant = buildFtsQuery([...head, chars.slice(0, -trim).join('')]);
    if (variant !== null) variants.push(variant);
  }
  return variants;
}

/** Sieht aus wie eine Hausnummer ("12", "60d", "7-9"). */
const HOUSENUMBER = /^\d+[a-z]?$/;

/**
 * Für den Fallback auf Straßenebene: die Wörter ohne Hausnummern; `null`, wenn
 * es keine Hausnummer gab oder sonst nichts übrig bleibt.
 */
export function withoutHousenumbers(tokens: readonly string[]): string[] | null {
  const rest = tokens.filter((t) => !HOUSENUMBER.test(t));
  return rest.length === tokens.length || rest.length === 0 ? null : rest;
}
