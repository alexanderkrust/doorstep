/** Übersetzung einer Suchanfrage in FTS5-Queries. Reine Funktionen. */

/** Kürzer wird das letzte Token bei der Tippfehler-Toleranz nicht. */
const MIN_TRIMMED_LENGTH = 3;
/** So viele Zeichen werden am Ende des letzten Tokens höchstens abgeschnitten. */
const MAX_TRIM = 2;

/**
 * Zerlegt die Anfrage in Wörter (Buchstaben und Ziffern). Alles andere trennt,
 * damit keine FTS5-Syntax (Anführungszeichen, `*`, Klammern) durchrutscht.
 */
export function tokenize(query: string): string[] {
  return query.normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? [];
}

const quote = (token: string) => `"${token}"`;

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
  // Tokens enthalten nur Buchstaben und Ziffern (NFC), Codepoints reichen also.
  const chars = Array.from(tokens[tokens.length - 1] ?? '');
  for (let trim = 1; trim <= MAX_TRIM && chars.length - trim >= MIN_TRIMMED_LENGTH; trim++) {
    const variant = buildFtsQuery([...head, chars.slice(0, -trim).join('')]);
    if (variant !== null) variants.push(variant);
  }
  return variants;
}
