/**
 * bm25 like `bm25()` in FTS5, but in JS. Pure functions.
 *
 * For `bm25()`, FTS5 counts all documents of every search word on every query; on the
 * Germany index that costs up to 250 ms. Here the document count comes from the word
 * statistics precomputed during the import (see `TermStats`), and the hits in the
 * document from its columns, which are generated exactly as during the import.
 */

import { housenumberText, indexText } from './normalize.js';

/** A search word as FTS5 searches it (see `phrasesFor`). */
export interface Phrase {
  token: string;
  /** Matches every word that starts with `token`. */
  prefix: boolean;
  /** Does not count in the `postcode` column (partial house number). */
  notInPostcode: boolean;
}

/** Words per text column of the full-text index. */
export interface FtsColumns {
  name: readonly string[];
  street: readonly string[];
  housenumber: readonly string[];
  postcode: readonly string[];
  city: readonly string[];
}

/** Column weights as formerly in `bm25(places_fts, 4, 2, 1, 1, 1, 0)`; `cell` does not count. */
const WEIGHTS: Readonly<Record<keyof FtsColumns, number>> = {
  name: 4,
  street: 2,
  housenumber: 1,
  postcode: 1,
  city: 1,
};
const COLUMN_NAMES = Object.keys(WEIGHTS) as (keyof FtsColumns)[];
/** The `cell` column always has exactly one word; it counts toward the document length. */
const CELL_TOKENS = 1;
/** Parameters as in FTS5. */
const K1 = 1.2;
const B = 0.75;

const words = (text: string) => text.split(' ').filter(Boolean);

/** How the unicode61 tokenizer splits the raw postcode. */
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

/** Column content as during the import (`IndexWriter.buildSearchIndexes`). */
export function ftsColumns(row: FtsSource): FtsColumns {
  return {
    name: words(indexText([row.name, row.name_de, row.name_en])),
    street: words(indexText([row.street])),
    housenumber: words(housenumberText(row.housenumber)),
    postcode: row.postcode ? postcodeWords(row.postcode) : [],
    city: words(indexText([row.city, row.district])),
  };
}

/** Inverse document frequency as in FTS5 (never 0 or negative). */
export function idf(rows: number, hits: number): number {
  const value = Math.log((rows - hits + 0.5) / (hits + 0.5));
  return value > 0 ? value : 1e-6;
}

/** bm25 of a row; negative, the smaller the more relevant (like FTS5). */
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
