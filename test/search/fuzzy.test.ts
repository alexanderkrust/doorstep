import { describe, expect, it } from 'vitest';
import { fuzzyCorrections, fuzzyPrefixesOf, type FuzzySource } from '../../src/search/fuzzy.js';
import { deletions } from '../../src/search/query.js';
import type { TermDocs } from '../../src/search/term-stats.js';

/** A word list with the deletion table the import builds from it. */
function source(words: Record<string, number>): FuzzySource {
  const terms: TermDocs[] = Object.entries(words)
    .map(([term, docs]) => ({ term, docs }))
    .sort((a, b) => (a.term < b.term ? -1 : 1));
  const table = new Map<string, Set<string>>();
  for (const { term } of terms) {
    for (const [del, prefix] of fuzzyPrefixesOf(term)) {
      const set = table.get(del) ?? new Set<string>();
      set.add(prefix);
      table.set(del, set);
    }
  }
  const completions = (prefix: string) => terms.filter((t) => t.term.startsWith(prefix));
  return {
    prefixes: (keys) => [...new Set(keys.flatMap((k) => [...(table.get(k) ?? [])]))],
    completions,
    docs: (term) => terms.find((t) => t.term === term)?.docs ?? 0,
    prefixDocs: (prefix) => completions(prefix).reduce((sum, t) => sum + t.docs, 0),
  };
}

const words = source({
  gneisenaustrasse: 40,
  gneisenau: 5,
  gneist: 1,
  zeil: 3,
  duesseldorf: 900,
  dusseldorf: 900,
  koenigsallee: 30,
  berlin: 500,
});

describe('fuzzyPrefixesOf', () => {
  it('stores the deletions of the word starts with 4 to 7 letters', () => {
    const rows = fuzzyPrefixesOf('gneisenau');
    const prefixes = new Set(rows.map(([, prefix]) => prefix));
    expect([...prefixes].sort()).toEqual(['gnei', 'gneis', 'gneise', 'gneisen']);
    expect(rows).toContainEqual(['gnisen', 'gneisen']);
    expect(rows).toContainEqual(['nisen', 'gneisen']);
    // 4 to 6 letters: only one deletion
    expect(rows).not.toContainEqual(['ges', 'gneis']);
    const all = rows.map(([del]) => del);
    expect(all).toEqual(expect.arrayContaining(deletions('gneis', 1)));
  });

  it('ignores words with digits and words under 4 letters', () => {
    expect(fuzzyPrefixesOf('60d')).toEqual([]);
    expect(fuzzyPrefixesOf('weg')).toEqual([]);
  });
});

describe('fuzzyCorrections', () => {
  it('corrects a word start with a swap', () => {
    expect(fuzzyCorrections('gnies', true, words)).toContain('gneis');
  });

  it('corrects two typos in a long word start', () => {
    expect(fuzzyCorrections('gxexsenau', true, words)[0]).toBe('gneisenau');
  });

  it('corrects a typo after the 7th letter', () => {
    expect(fuzzyCorrections('gneisenaustrsae', true, words)[0]).toMatch(/^gneisenaustr/);
  });

  it('corrects 4-letter words with one edit', () => {
    expect(fuzzyCorrections('zeli', false, words)).toEqual(['zeil']);
  });

  it('returns only whole words for exact words', () => {
    expect(fuzzyCorrections('berlim', false, words)).toEqual(['berlin']);
    expect(fuzzyCorrections('gneisenu', false, words)).toEqual(['gneisenau']);
  });

  it('finds nothing with more edits than allowed', () => {
    expect(fuzzyCorrections('gxexsxnau', true, words)).toEqual([]);
    expect(fuzzyCorrections('zxlx', false, words)).toEqual([]);
    expect(fuzzyCorrections('zel', false, words)).toEqual([]);
  });

  it('puts fewer edits first, then more documents', () => {
    const corrections = fuzzyCorrections('dusseldorg', false, words);
    expect(corrections[0]).toBe('dusseldorf');
    expect(corrections).toContain('duesseldorf');
  });
});
