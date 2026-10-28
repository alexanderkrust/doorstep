/** Übersetzung normalisierter Wörter (siehe `normalizeTokens`) in FTS5-Queries. Reine Funktionen. */

import type { Phrase } from './bm25.js';
import type { TermDocs } from './term-stats.js';

/** Kürzer wird das letzte Token bei der Tippfehler-Toleranz nicht. */
const MIN_TRIMMED_LENGTH = 3;
/** So viele Zeichen werden am Ende des letzten Tokens höchstens abgeschnitten. */
const MAX_TRIM = 2;

const quote = (token: string) => `"${token.replaceAll('"', '""')}"`;

/** Sieht aus wie eine Hausnummer ("12", "60d"). */
const HOUSENUMBER = /^\d+[a-z]?$/;
/** Ab so vielen Ziffern kann ein angefangenes Token auch eine Postleitzahl sein. */
const MIN_POSTCODE_PREFIX = 4;

/**
 * Eine angefangene Hausnummer ("4") soll nicht als Präfix der Postleitzahl
 * passen (40213), sonst trifft sie jede Adresse im PLZ-Gebiet.
 */
function isHousenumberPrefix(token: string): boolean {
  return HOUSENUMBER.test(token) && token.replace(/\D/g, '').length < MIN_POSTCODE_PREFIX;
}

/** Spalten mit Text aus OSM; die Spalte `cell` (Rasterzelle) gehört nicht dazu. */
const TEXT_COLUMNS = '{name street housenumber postcode city}';

/** Beschränkt eine Anfrage auf die Textspalten, damit Suchwörter nie Rasterzellen treffen. */
export function inTextColumns(match: string): string {
  return `${TEXT_COLUMNS} : (${match})`;
}

/** Wie `inTextColumns`, zusätzlich muss der Treffer in einer der Rasterzellen liegen. */
export function withinCells(match: string, cells: readonly string[]): string {
  return `${inTextColumns(match)} AND cell : (${cells.map(quote).join(' OR ')})`;
}

/**
 * Letztes Token als Präfix, alle anderen exakt; alle müssen vorkommen.
 * `lastParts` ersetzt das Präfix durch seine Zerlegung (siehe `expandPrefix`).
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
    // Vor einer Klammer verlangt FTS5 ein ausdrückliches AND.
    const group = `${filter}(${lastParts.join(' OR ')})`;
    return head.length > 0 ? `${head.join(' ')} AND ${group}` : group;
  }
  return [...head, `${filter}${quote(last)}*`].join(' ');
}

/** Suchwörter für bm25: das letzte als Präfix, eine angefangene Hausnummer nicht in der PLZ. */
export function phrasesFor(tokens: readonly string[]): Phrase[] {
  return tokens.map((token, i) => {
    const isLast = i === tokens.length - 1;
    return { token, prefix: isLast, notInPostcode: isLast && isHousenumberPrefix(token) };
  });
}

const sumDocs = (terms: readonly TermDocs[]) => terms.reduce((sum, t) => sum + t.docs, 0);

/**
 * Zerlegt ein Präfix, unter dessen Wörtern ein sehr häufiges ist ("strasse"* mit
 * 5 Mio. Dokumenten). FTS5 führt für Präfixe ohne Präfixindex (über 4 Zeichen)
 * die Trefferlisten aller passenden Wörter vorab vollständig zusammen; exakte
 * Wörter in einer ODER-Verknüpfung liest es dagegen nur so weit wie nötig.
 *
 * Teilbäume mit höchstens `maxDocs` Dokumenten bleiben ein (längeres) Präfix, die
 * übrigen werden zeichenweise weiter zerlegt bis zum häufigen Wort, das exakt
 * gesucht wird. Die Teile decken zusammen genau die Wörter von `prefix` ab.
 * `null`, wenn nichts zu zerlegen ist.
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
 * Die Wörter der Anfrage plus Varianten mit gekürztem letztem Token, damit ein
 * Tippfehler am Wortende ("Königsalleh") noch die Königsallee findet.
 */
export function tokenVariants(tokens: readonly string[]): string[][] {
  if (tokens.length === 0) return [];
  const variants = [[...tokens]];
  const head = tokens.slice(0, -1);
  const last = tokens[tokens.length - 1] ?? '';
  // Zahlen werden nicht gekürzt: "1234" → "123"* wäre kein Tippfehler, sondern eine andere Nummer.
  if (/^\d/.test(last)) return variants;
  const chars = Array.from(last);
  for (let trim = 1; trim <= MAX_TRIM && chars.length - trim >= MIN_TRIMMED_LENGTH; trim++) {
    variants.push([...head, chars.slice(0, -trim).join('')]);
  }
  return variants;
}

/** `tokenVariants` als FTS5-Queries (ohne Zerlegung des Präfixes). */
export function queryVariants(tokens: readonly string[]): string[] {
  return tokenVariants(tokens).flatMap((variant) => buildFtsQuery(variant) ?? []);
}

/**
 * Für den Fallback auf Straßenebene: die Wörter ohne Hausnummern; `null`, wenn
 * es keine Hausnummer gab oder sonst nichts übrig bleibt.
 */
export function withoutHousenumbers(tokens: readonly string[]): string[] | null {
  const rest = tokens.filter((t) => !HOUSENUMBER.test(t));
  return rest.length === tokens.length || rest.length === 0 ? null : rest;
}

/** Ein einzelner Buchstabe, keine Ziffer. */
const SINGLE_LETTER = /^\p{L}$/u;

/**
 * Für Abkürzungen wie "Frankfurt a.M." oder "Mülheim a.d. Ruhr": die Wörter ohne
 * einzelne Buchstaben; `null`, wenn keiner wegfällt oder sonst nichts übrig bleibt.
 */
export function withoutSingleLetters(tokens: readonly string[]): string[] | null {
  const rest = tokens.filter((t) => !SINGLE_LETTER.test(t));
  return rest.length === tokens.length || rest.length === 0 ? null : rest;
}
