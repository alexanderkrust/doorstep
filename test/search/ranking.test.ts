import { describe, expect, it } from 'vitest';
import {
  dedupeNearby,
  nameMatch,
  rank,
  scoreCandidate,
  type Candidate,
} from '../../src/search/ranking.js';

/** `names` sind bereits normalisierte Namen (Wörter durch Leerzeichen getrennt). */
const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  bm25: -5,
  importance: 0.4,
  names: ['koenigsallee'],
  ...overrides,
});

describe('nameMatch', () => {
  it('ist 1 bei exakt gleichem Namen', () => {
    expect(nameMatch(['duesseldorf'], ['duesseldorf'])).toBe(1);
    expect(nameMatch(['koenigsallee', '60d'], ['koenigsallee 60d'])).toBe(1);
  });

  it('wächst mit dem Anteil des Namens, den die Anfrage abdeckt', () => {
    const short = nameMatch(['koenigs'], ['koenigsallee']);
    const long = nameMatch(['koenigsall'], ['koenigsallee']);
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThan(1);
  });

  it('bevorzugt kurze Namen, die fast vollständig getroffen werden', () => {
    expect(nameMatch(['essen'], ['essen'])).toBeGreaterThan(
      nameMatch(['essen'], ['essener strasse']),
    );
  });

  it('wertet Namen ab, die nur einen Teil der Anfrage enthalten', () => {
    // "Düsseldorf Königsallee": die Straße heißt nur "Königsallee"
    const partial = nameMatch(['duesseldorf', 'koenigsallee'], ['koenigsallee']);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(nameMatch(['koenigsallee'], ['koenigsallee']));
  });

  it('wertet Namen ab, die nicht mit der Anfrage beginnen', () => {
    expect(nameMatch(['allee'], ['koenigs allee'])).toBeLessThan(
      nameMatch(['koenigs'], ['koenigs allee']),
    );
  });

  it('bewertet exakt getroffene Wörter höher als Präfixe gleicher Länge', () => {
    // "Königsallee 1": Hausnummer 1 vor 11
    expect(nameMatch(['koenigsallee', '1'], ['koenigsallee 1'])).toBeGreaterThan(
      nameMatch(['koenigsallee', '1'], ['koenigsallee 11']),
    );
  });

  it('nimmt den besten von mehreren Namen (z. B. name:en)', () => {
    expect(nameMatch(['dusseldorf'], ['duesseldorf', 'dusseldorf'])).toBe(1);
  });

  it('ist 0 ohne Namen oder ohne Anfrage', () => {
    expect(nameMatch(['koenigsallee'], [])).toBe(0);
    expect(nameMatch([], ['koenigsallee'])).toBe(0);
  });
});

describe('scoreCandidate', () => {
  const ctx = { queryTokens: ['koenigsallee'], bestBm25: -10 };

  it('wächst mit FTS-Relevanz', () => {
    expect(scoreCandidate(candidate({ bm25: -10 }), ctx)).toBeGreaterThan(
      scoreCandidate(candidate({ bm25: -2 }), ctx),
    );
  });

  it('wächst mit importance', () => {
    expect(scoreCandidate(candidate({ importance: 0.9 }), ctx)).toBeGreaterThan(
      scoreCandidate(candidate({ importance: 0.3 }), ctx),
    );
  });

  it('hebt nahe Treffer an, wenn ein Standort gesetzt ist', () => {
    const near = scoreCandidate(candidate({ distanceKm: 0.5 }), ctx);
    const far = scoreCandidate(candidate({ distanceKm: 50 }), ctx);
    expect(near).toBeGreaterThan(far);
  });

  it('liefert Werte zwischen 0 und 1', () => {
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

  it('kommt mit bm25 = 0 bei allen Kandidaten zurecht', () => {
    expect(Number.isFinite(scoreCandidate(candidate({ bm25: 0 }), { ...ctx, bestBm25: 0 }))).toBe(
      true,
    );
  });
});

describe('rank', () => {
  it('sortiert Stadt vor Straße vor Hausnummer bei gleicher Relevanz', () => {
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

  it('rankt einen Ort mit passendem Namen vor einer Straße, die nur mit ihm beginnt', () => {
    const ranked = rank(
      [
        candidate({ importance: 0.4, names: ['essener strasse'], bm25: -9 }),
        candidate({ importance: 0.8, names: ['essen'], bm25: -8 }),
      ],
      ['essen'],
    );
    expect(ranked[0]?.names).toEqual(['essen']);
  });

  it('rankt die genaue Adresse vor der Straße, wenn eine Hausnummer gesucht wird', () => {
    const ranked = rank(
      [
        candidate({ importance: 0.4, names: ['koenigsallee'] }),
        candidate({ importance: 0.3, names: ['koenigsallee 60d'] }),
      ],
      ['koenigsallee', '60d'],
    );
    expect(ranked[0]?.names).toEqual(['koenigsallee 60d']);
  });

  it('bevorzugt bei gleichem Typ den näheren Treffer', () => {
    const ranked = rank(
      [candidate({ distanceKm: 12 }), candidate({ distanceKm: 0.3 }), candidate({ distanceKm: 4 })],
      ['koenigsallee'],
    );
    expect(ranked.map((c) => c.distanceKm)).toEqual([0.3, 4, 12]);
  });

  it('lässt Nähe einen exakt passenden Ort nicht verdrängen, entscheidet aber bei gleichem Namen', () => {
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

  it('verändert die Eingabe nicht und ist stabil bei Gleichstand', () => {
    const input = [candidate({ names: ['a'] }), candidate({ names: ['b'] })];
    const copy = structuredClone(input);
    const ranked = rank(input, ['x']);
    expect(input).toEqual(copy);
    expect(ranked.map((c) => c.names[0])).toEqual(['a', 'b']);
  });

  it('kommt mit einer leeren Liste zurecht', () => {
    expect(rank([], ['x'])).toEqual([]);
  });
});

describe('dedupeNearby', () => {
  const row = (key: string, lat: number, lon = 6.78) => ({ key, lat, lon });
  const keyOf = (r: { key: string }) => r.key;

  it('fasst gleiche Treffer in der Nähe zusammen und behält den ersten', () => {
    const rows = [row('kö', 51.22), row('kö', 51.225), row('kö', 51.218)];
    expect(dedupeNearby(rows, keyOf, 2)).toEqual([rows[0]]);
  });

  it('behält gleiche Namen, die weit auseinander liegen', () => {
    const rows = [row('altstadt', 51.22), row('altstadt', 51.43)];
    expect(dedupeNearby(rows, keyOf, 2)).toEqual(rows);
  });

  it('behält verschiedene Treffer in der Nähe und die Reihenfolge', () => {
    const rows = [row('b', 51.22), row('a', 51.22), row('b', 51.221), row('c', 51.22)];
    expect(dedupeNearby(rows, keyOf, 2).map((r) => r.key)).toEqual(['b', 'a', 'c']);
  });
});
