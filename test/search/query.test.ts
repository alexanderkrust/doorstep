import { describe, expect, it } from 'vitest';
import {
  buildFtsQuery,
  buildWordsQuery,
  deletions,
  maxEdits,
  osaDistance,
  editVariants,
  isFuzzyCandidate,
  expandPrefix,
  inTextColumns,
  phrasesFor,
  phrasesForWords,
  queryWords,
  queryVariants,
  tokenVariants,
  withinCells,
  withoutHousenumbers,
  withoutSingleLetters,
} from '../../src/search/query.js';

describe('inTextColumns', () => {
  it('restricts the query to the text columns (not the grid cell)', () => {
    expect(inTextColumns('"g5"*')).toBe('{name street housenumber postcode city} : ("g5"*)');
  });
});

describe('withinCells', () => {
  it('additionally requires one of the grid cells', () => {
    expect(withinCells('"ha"*', ['g570x773', 'g570x774'])).toBe(
      '{name street housenumber postcode city} : ("ha"*) AND cell : ("g570x773" OR "g570x774")',
    );
  });
});

describe('buildFtsQuery', () => {
  it('searches the last token as a prefix, the others exactly', () => {
    expect(buildFtsQuery(['Königsallee', 'Düss'])).toBe('"Königsallee" "Düss"*');
    expect(buildFtsQuery(['Königsall'])).toBe('"Königsall"*');
  });

  it('quotes operators as literals', () => {
    expect(buildFtsQuery(['foo', 'OR', 'bar'])).toBe('"foo" "OR" "bar"*');
  });

  it('escapes quotes', () => {
    expect(buildFtsQuery(['a"b'])).toBe('"a""b"*');
  });

  it('returns null without tokens', () => {
    expect(buildFtsQuery([])).toBeNull();
  });

  it('does not search a partial house number in the postcode', () => {
    // "4"* would otherwise match every address with postcode 4xxxx.
    expect(buildFtsQuery(['koenigsallee', '4'])).toBe('"koenigsallee" - {postcode} : "4"*');
    expect(buildFtsQuery(['koenigsallee', '60d'])).toBe('"koenigsallee" - {postcode} : "60d"*');
  });

  it('allows the postcode from four digits on', () => {
    expect(buildFtsQuery(['4021'])).toBe('"4021"*');
    expect(buildFtsQuery(['40212'])).toBe('"40212"*');
  });

  it('restricts only the last token', () => {
    expect(buildFtsQuery(['4', 'koenigsallee'])).toBe('"4" "koenigsallee"*');
  });
});

describe('buildFtsQuery with an expanded prefix', () => {
  it('replaces the prefix with the parts, joined with AND', () => {
    expect(buildFtsQuery(['breite', 'strasse'], ['"strasse"', '"strassen"*'])).toBe(
      '"breite" AND ("strasse" OR "strassen"*)',
    );
    expect(buildFtsQuery(['strasse'], ['"strasse"', '"strassen"*'])).toBe(
      '("strasse" OR "strassen"*)',
    );
  });

  it('keeps the postcode exception for house numbers', () => {
    expect(buildFtsQuery(['weg', '12a'], ['"12a"', '"12ab"*'])).toBe(
      '"weg" AND - {postcode} : ("12a" OR "12ab"*)',
    );
  });
});

describe('expandPrefix', () => {
  const terms = [
    { term: 'strasse', docs: 1000 },
    { term: 'strassen', docs: 5 },
    { term: 'strassenbahn', docs: 2 },
    { term: 'strasser', docs: 3 },
    { term: 'strassburg', docs: 40 },
    { term: 'strasbourg', docs: 20 },
  ];
  const completions = (prefix: string) => terms.filter((t) => t.term.startsWith(prefix));

  it('leaves prefixes without a frequent word unchanged', () => {
    expect(expandPrefix('strassen', completions('strassen'), 100)).toBeNull();
    expect(expandPrefix('xyz', [], 100)).toBeNull();
  });

  it('searches the frequent word exactly and the rest via longer prefixes', () => {
    expect(expandPrefix('strasse', completions('strasse'), 100)).toEqual([
      '"strasse"',
      '"strassen"*',
      '"strasser"',
    ]);
  });

  it('expands step by step down to the frequent word', () => {
    expect(expandPrefix('stras', completions('stras'), 100)).toEqual([
      '"strasb"*',
      '"strassb"*',
      '"strasse"',
      '"strassen"*',
      '"strasser"',
    ]);
  });

  it('covers exactly the words of the prefix', () => {
    const parts = expandPrefix('stras', completions('stras'), 10) ?? [];
    const covers = (part: string, term: string) =>
      part.endsWith('*') ? term.startsWith(part.slice(1, -2)) : term === part.slice(1, -1);
    for (const t of completions('stras')) {
      expect(parts.filter((p) => covers(p, t.term))).toHaveLength(1);
    }
  });

  it('escapes quotes', () => {
    const quoted = [
      { term: 'a"', docs: 10 },
      { term: 'a"b', docs: 1 },
    ];
    expect(expandPrefix('a"', quoted, 5)).toEqual(['"a"""', '"a""b"']);
  });
});

describe('tokenVariants', () => {
  it('returns the words of the query and of the typo variants', () => {
    expect(tokenVariants(['koe', 'abcd'])).toEqual([
      ['koe', 'abcd'],
      ['koe', 'abc'],
    ]);
    expect(tokenVariants([])).toEqual([]);
  });
});

describe('phrasesFor', () => {
  it('searches the last word as a prefix', () => {
    expect(phrasesFor(['breite', 'str'])).toEqual([
      { token: 'breite', prefix: false, notInPostcode: false },
      { token: 'str', prefix: true, notInPostcode: false },
    ]);
  });

  it('does not search a partial house number in the postcode', () => {
    expect(phrasesFor(['weg', '4'])[1]).toEqual({ token: '4', prefix: true, notInPostcode: true });
  });
});

describe('queryVariants', () => {
  it('trims the last token step by step for typos', () => {
    expect(queryVariants(['Königsalleh'])).toEqual([
      '"Königsalleh"*',
      '"Königsalle"*',
      '"Königsall"*',
    ]);
  });

  it('does not trim below three characters', () => {
    expect(queryVariants(['Kö', 'abcd'])).toEqual(['"Kö" "abcd"*', '"Kö" "abc"*']);
    expect(queryVariants(['abc'])).toEqual(['"abc"*']);
  });

  it('does not trim numbers (typo tolerance applies only to words)', () => {
    expect(queryVariants(['hauptstrasse', '1234'])).toEqual(['"hauptstrasse" "1234"*']);
  });

  it('returns no variants without tokens', () => {
    expect(queryVariants([])).toEqual([]);
  });
});

describe('withoutHousenumbers', () => {
  it('removes house numbers', () => {
    expect(withoutHousenumbers(['koenigsallee', '999'])).toEqual(['koenigsallee']);
    expect(withoutHousenumbers(['koenigsallee', '60d', 'duesseldorf'])).toEqual([
      'koenigsallee',
      'duesseldorf',
    ]);
  });

  it('returns null without a house number or when nothing is left', () => {
    expect(withoutHousenumbers(['koenigsallee'])).toBeNull();
    expect(withoutHousenumbers(['12'])).toBeNull();
  });
});

describe('withoutSingleLetters', () => {
  it('drops single letters from abbreviations ("Frankfurt a.M.")', () => {
    expect(withoutSingleLetters(['zeil', '106', 'frankfurt', 'a', 'm'])).toEqual([
      'zeil',
      '106',
      'frankfurt',
    ]);
  });

  it('keeps single-digit house numbers', () => {
    expect(withoutSingleLetters(['hauptstrasse', '1', 'a'])).toEqual(['hauptstrasse', '1']);
  });

  it('returns null when nothing is dropped or nothing is left', () => {
    expect(withoutSingleLetters(['hauptstrasse', '1'])).toBeNull();
    expect(withoutSingleLetters(['a', 'b'])).toBeNull();
  });
});

describe('queryWords', () => {
  it('searches only the last word as a prefix without lookahead', () => {
    expect(queryWords(['gneis', '62', 'duess'], false).map((w) => w.prefix)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('searches every word with letters as a prefix with lookahead', () => {
    expect(queryWords(['gneis', '62', 'duess'], true)).toEqual([
      { token: 'gneis', prefix: true, notInPostcode: false },
      { token: '62', prefix: false, notInPostcode: false },
      { token: 'duess', prefix: true, notInPostcode: false },
    ]);
  });

  it('keeps words under 3 characters and numbers before the end exact', () => {
    expect(queryWords(['am', '5', 'duess'], true).map((w) => w.prefix)).toEqual([
      false,
      false,
      true,
    ]);
    expect(queryWords(['40212', 'koenigs'], true)[0]?.prefix).toBe(false);
  });

  it('keeps a partial house number at the end out of the postcode', () => {
    expect(queryWords(['gneis', '6'], true)[1]).toEqual({
      token: '6',
      prefix: true,
      notInPostcode: true,
    });
  });
});

describe('buildWordsQuery', () => {
  it('writes every prefix word with *', () => {
    expect(buildWordsQuery(queryWords(['gneis', '62', 'duess'], true))).toBe(
      '"gneis"* "62" "duess"*',
    );
  });

  it('puts an expanded word in the middle into an AND group', () => {
    expect(
      buildWordsQuery(queryWords(['haupt', '5', 'koeln'], true), [
        ['"hauptstrasse"', '"haupts"*'],
        null,
        null,
      ]),
    ).toBe('("hauptstrasse" OR "haupts"*) AND "5" AND "koeln"*');
  });

  it('gives the same query as buildFtsQuery without lookahead', () => {
    const tokens = ['koenigsallee', '4'];
    expect(buildWordsQuery(queryWords(tokens, false))).toBe(buildFtsQuery(tokens));
  });

  it('is null without words', () => {
    expect(buildWordsQuery([])).toBeNull();
  });
});

describe('phrasesForWords', () => {
  it('takes the prefix flags of the words for bm25', () => {
    expect(phrasesForWords(queryWords(['gneis', 'duess'], true))).toEqual([
      { token: 'gneis', prefix: true, notInPostcode: false },
      { token: 'duess', prefix: true, notInPostcode: false },
    ]);
  });
});

describe('editVariants', () => {
  const variants = editVariants('gnies');

  it('contains every kind of single edit', () => {
    expect(variants).toContain('gneis'); // swapped letters
    expect(variants).toContain('gnes'); // missing letter
    expect(variants).toContain('gnixes'); // extra letter
    expect(variants).toContain('gnits'); // wrong letter
  });

  it('does not contain the word itself or duplicates', () => {
    expect(variants).not.toContain('gnies');
    expect(new Set(variants).size).toBe(variants.length);
  });
});

describe('isFuzzyCandidate', () => {
  it('corrects only words of letters with at least 5 characters', () => {
    expect(isFuzzyCandidate('gnies')).toBe(true);
    expect(isFuzzyCandidate('gnie')).toBe(false);
    expect(isFuzzyCandidate('40212')).toBe(false);
    expect(isFuzzyCandidate('60d')).toBe(false);
  });
});

describe('buildWordsQuery with alternatives', () => {
  it('puts the corrections of a word into an OR group', () => {
    const words = queryWords(['gnies', '62', 'dues'], true);
    expect(buildWordsQuery(words, [['"gneis"*', '"gnies"*'], null, null])).toBe(
      '("gneis"* OR "gnies"*) AND "62" AND "dues"*',
    );
  });
});

describe('osaDistance', () => {
  it('counts a swap of neighbors as one edit', () => {
    expect(osaDistance('gnies', 'gneis', 2)).toBe(1);
    expect(osaDistance('zeli', 'zeil', 2)).toBe(1);
  });

  it('counts missing, extra and wrong letters', () => {
    expect(osaDistance('gneisenaustrase', 'gneisenaustrasse', 2)).toBe(1);
    expect(osaDistance('gxexsenau', 'gneisenau', 2)).toBe(2);
    expect(osaDistance('', 'abc', 5)).toBe(3);
  });

  it('stops at max and returns max + 1', () => {
    expect(osaDistance('gxexsxnau', 'gneisenau', 2)).toBe(3);
    expect(osaDistance('abcdefgh', 'zyxwvuts', 1)).toBe(2);
  });
});

describe('deletions', () => {
  it('contains the word and every form with up to d letters removed', () => {
    expect(deletions('zeil', 1).sort()).toEqual(['eil', 'zeil', 'zel', 'zei', 'zil'].sort());
    const two = deletions('gneisen', 2);
    expect(two).toContain('gneisen');
    expect(two).toContain('neisen');
    expect(two).toContain('gnisn');
    expect(new Set(two).size).toBe(two.length);
  });
});

describe('maxEdits', () => {
  it('allows no edit below 4 letters, 1 up to 6 and 2 from 7', () => {
    expect([3, 4, 6, 7, 12].map(maxEdits)).toEqual([0, 1, 1, 2, 2]);
  });
});
