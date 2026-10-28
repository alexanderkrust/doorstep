/**
 * bm25 wie `bm25()` in FTS5, aber in JS. Reine Funktionen.
 *
 * FTS5 zählt für `bm25()` bei jeder Anfrage alle Dokumente jedes Suchworts; auf
 * dem Deutschland-Index kostet das bis zu 250 ms. Hier kommt die Dokumentzahl aus
 * der beim Import vorberechneten Wortstatistik (siehe `TermStats`), die Treffer im
 * Dokument aus dessen Spalten, die genauso wie beim Import erzeugt werden.
 */

import { housenumberText, indexText } from './normalize.js';

/** Ein Suchwort, wie FTS5 es sucht (siehe `phrasesFor`). */
export interface Phrase {
  token: string;
  /** Passt auf jedes Wort, das mit `token` beginnt. */
  prefix: boolean;
  /** Zählt nicht in der Spalte `postcode` (angefangene Hausnummer). */
  notInPostcode: boolean;
}

/** Wörter je Textspalte des Volltextindex. */
export interface FtsColumns {
  name: readonly string[];
  street: readonly string[];
  housenumber: readonly string[];
  postcode: readonly string[];
  city: readonly string[];
}

/** Spaltengewichte wie früher in `bm25(places_fts, 4, 2, 1, 1, 1, 0)`; `cell` zählt nicht. */
const WEIGHTS: Readonly<Record<keyof FtsColumns, number>> = {
  name: 4,
  street: 2,
  housenumber: 1,
  postcode: 1,
  city: 1,
};
const COLUMN_NAMES = Object.keys(WEIGHTS) as (keyof FtsColumns)[];
/** Die Spalte `cell` hat immer genau ein Wort; es zählt für die Dokumentlänge mit. */
const CELL_TOKENS = 1;
/** Parameter wie in FTS5. */
const K1 = 1.2;
const B = 0.75;

const words = (text: string) => text.split(' ').filter(Boolean);

/** Wie der unicode61-Tokenizer die rohe Postleitzahl zerlegt. */
const postcodeWords = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];

export interface FtsSource {
  name: string | null;
  name_de: string | null;
  name_en: string | null;
  street: string | null;
  housenumber: string | null;
  postcode: string | null;
  city: string | null;
  district: string | null;
}

/** Spalteninhalt wie beim Import (`IndexWriter.buildSearchIndexes`). */
export function ftsColumns(row: FtsSource): FtsColumns {
  return {
    name: words(indexText([row.name, row.name_de, row.name_en])),
    street: words(indexText([row.street])),
    housenumber: words(housenumberText(row.housenumber)),
    postcode: row.postcode ? postcodeWords(row.postcode) : [],
    city: words(indexText([row.city, row.district])),
  };
}

/** Inverse Dokumenthäufigkeit wie in FTS5 (nie 0 oder negativ). */
export function idf(rows: number, hits: number): number {
  const value = Math.log((rows - hits + 0.5) / (hits + 0.5));
  return value > 0 ? value : 1e-6;
}

/** bm25 einer Zeile; negativ, je kleiner desto relevanter (wie FTS5). */
export function bm25(
  phrases: readonly Phrase[],
  idfs: readonly number[],
  columns: FtsColumns,
  avgTokens: number,
): number {
  let length = CELL_TOKENS;
  for (const column of COLUMN_NAMES) length += columns[column].length;
  const norm = K1 * (1 - B + (B * length) / avgTokens);

  let score = 0;
  for (const [i, phrase] of phrases.entries()) {
    let freq = 0;
    for (const column of COLUMN_NAMES) {
      if (phrase.notInPostcode && column === 'postcode') continue;
      for (const word of columns[column]) {
        if (phrase.prefix ? word.startsWith(phrase.token) : word === phrase.token) {
          freq += WEIGHTS[column];
        }
      }
    }
    if (freq > 0) score += ((idfs[i] ?? 0) * (freq * (K1 + 1))) / (freq + norm);
  }
  return score === 0 ? 0 : -score;
}
