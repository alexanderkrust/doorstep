import { describe, expect, it } from 'vitest';
import {
  dedupeNearby,
  nameMatch,
  rank,
  scoreCandidate,
  type Candidate,
} from '../../src/search/ranking.js';

/** `names` are already normalized names (words separated by spaces). */
const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  bm25: -5,
  importance: 0.4,
  names: ['koenigsallee'],
  ...overrides,
});

describe('nameMatch', () => {
  it('is 1 for exactly the same name', () => {
    expect(nameMatch(['duesseldorf'], ['duesseldorf'])).toBe(1);
    expect(nameMatch(['koenigsallee', '60d'], ['koenigsallee 60d'])).toBe(1);
  });

  it('grows with the share of the name the query covers', () => {
    const short = nameMatch(['koenigs'], ['koenigsallee']);
    const long = nameMatch(['koenigsall'], ['koenigsallee']);
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThan(1);
  });

  it('prefers short names that are matched almost completely', () => {
    expect(nameMatch(['essen'], ['essen'])).toBeGreaterThan(
      nameMatch(['essen'], ['essener strasse']),
    );
  });

  it('downgrades names that contain only part of the query', () => {
    // "Düsseldorf Königsallee": the street is only called "Königsallee"
    const partial = nameMatch(['duesseldorf', 'koenigsallee'], ['koenigsallee']);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(nameMatch(['koenigsallee'], ['koenigsallee']));
  });

  it('downgrades names that do not start with the query', () => {
    expect(nameMatch(['allee'], ['koenigs allee'])).toBeLessThan(
      nameMatch(['koenigs'], ['koenigs allee']),
    );
  });

  it('scores exactly matched words higher than prefixes of the same length', () => {
    // "Königsallee 1": house number 1 before 11
    expect(nameMatch(['koenigsallee', '1'], ['koenigsallee 1'])).toBeGreaterThan(
      nameMatch(['koenigsallee', '1'], ['koenigsallee 11']),
    );
  });

  it('takes the best of several names (e.g. name:en)', () => {
    expect(nameMatch(['dusseldorf'], ['duesseldorf', 'dusseldorf'])).toBe(1);
  });

  it('is 0 without names or without a query', () => {
    expect(nameMatch(['koenigsallee'], [])).toBe(0);
    expect(nameMatch([], ['koenigsallee'])).toBe(0);
  });
});

describe('scoreCandidate', () => {
  const ctx = { queryTokens: ['koenigsallee'], bestBm25: -10 };

  it('grows with FTS relevance', () => {
    expect(scoreCandidate(candidate({ bm25: -10 }), ctx)).toBeGreaterThan(
      scoreCandidate(candidate({ bm25: -2 }), ctx),
    );
  });

  it('grows with importance', () => {
    expect(scoreCandidate(candidate({ importance: 0.9 }), ctx)).toBeGreaterThan(
      scoreCandidate(candidate({ importance: 0.3 }), ctx),
    );
  });

  it('boosts nearby hits when a location is set', () => {
    const near = scoreCandidate(candidate({ distanceKm: 0.5 }), ctx);
    const far = scoreCandidate(candidate({ distanceKm: 50 }), ctx);
    expect(near).toBeGreaterThan(far);
  });

  it('returns values between 0 and 1', () => {
    for (const c of [
      candidate({ bm25: 0, importance: 0, names: [] }),
      candidate({ bm25: -10, importance: 1 }),
      candidate({ bm25: -10, importance: 1, distanceKm: 0 }),
      candidate({ bm25: -10, importance: 0, distanceKm: 20_000 }),
    ]) {
      const score = scoreCandidate(c, ctx);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('copes with bm25 = 0 for all candidates', () => {
    expect(Number.isFinite(scoreCandidate(candidate({ bm25: 0 }), { ...ctx, bestBm25: 0 }))).toBe(
      true,
    );
  });
});

describe('rank', () => {
  it('sorts city before street before house number at equal relevance', () => {
    const ranked = rank(
      [
        candidate({ importance: 0.3, names: ['koenigsallee 12'] }),
        candidate({ importance: 0.9 }),
        candidate({ importance: 0.4 }),
      ],
      ['koenigsallee'],
    );
    expect(ranked.map((c) => c.importance)).toEqual([0.9, 0.4, 0.3]);
  });

  it('ranks a city with a matching name before a street that only starts with it', () => {
    const ranked = rank(
      [
        candidate({ importance: 0.4, names: ['essener strasse'], bm25: -9 }),
        candidate({ importance: 0.8, names: ['essen'], bm25: -8 }),
      ],
      ['essen'],
    );
    expect(ranked[0]?.names).toEqual(['essen']);
  });

  it('ranks the exact address before the street when a house number is searched', () => {
    const ranked = rank(
      [
        candidate({ importance: 0.4, names: ['koenigsallee'] }),
        candidate({ importance: 0.3, names: ['koenigsallee 60d'] }),
      ],
      ['koenigsallee', '60d'],
    );
    expect(ranked[0]?.names).toEqual(['koenigsallee 60d']);
  });

  it('prefers the nearer hit for the same type', () => {
    const ranked = rank(
      [candidate({ distanceKm: 12 }), candidate({ distanceKm: 0.3 }), candidate({ distanceKm: 4 })],
      ['koenigsallee'],
    );
    expect(ranked.map((c) => c.distanceKm)).toEqual([0.3, 4, 12]);
  });

  it('does not let proximity push out an exactly matching city, but decides for equal names', () => {
    const ranked = rank(
      [
        candidate({ importance: 0.8, names: ['neuss'], distanceKm: 60 }),
        candidate({ importance: 0.4, names: ['neusser strasse'], distanceKm: 0.2 }),
      ],
      ['neuss'],
    );
    expect(ranked[0]?.names).toEqual(['neuss']);

    const same = rank(
      [
        candidate({ importance: 0.4, names: ['kirchweg'], distanceKm: 80 }),
        candidate({ importance: 0.4, names: ['kirchweg'], distanceKm: 1 }),
      ],
      ['kirchweg'],
    );
    expect(same[0]?.distanceKm).toBe(1);
  });

  it('does not change the input and is stable on ties', () => {
    const input = [candidate({ names: ['a'] }), candidate({ names: ['b'] })];
    const copy = structuredClone(input);
    const ranked = rank(input, ['x']);
    expect(input).toEqual(copy);
    expect(ranked.map((c) => c.names[0])).toEqual(['a', 'b']);
  });

  it('copes with an empty list', () => {
    expect(rank([], ['x'])).toEqual([]);
  });
});

describe('dedupeNearby', () => {
  const row = (key: string, lat: number, lon = 6.78) => ({ key, lat, lon });
  const keyOf = (r: { key: string }) => r.key;

  it('merges equal hits nearby and keeps the first', () => {
    const rows = [row('kö', 51.22), row('kö', 51.225), row('kö', 51.218)];
    expect(dedupeNearby(rows, keyOf, 2)).toEqual([rows[0]]);
  });

  it('keeps equal names that are far apart', () => {
    const rows = [row('altstadt', 51.22), row('altstadt', 51.43)];
    expect(dedupeNearby(rows, keyOf, 2)).toEqual(rows);
  });

  it('keeps different hits nearby and the order', () => {
    const rows = [row('b', 51.22), row('a', 51.22), row('b', 51.221), row('c', 51.22)];
    expect(dedupeNearby(rows, keyOf, 2).map((r) => r.key)).toEqual(['b', 'a', 'c']);
  });
});
