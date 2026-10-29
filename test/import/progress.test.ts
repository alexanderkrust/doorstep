import { describe, expect, it } from 'vitest';
import { formatCount, formatDuration, Progress, Steps } from '../../src/import/progress.js';

/** Uhr, die nur weiterläuft, wenn der Test es sagt. */
function fakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('formatCount und formatDuration', () => {
  it('schreibt Zahlen mit Tausenderpunkten', () => {
    expect(formatCount(25_568_099)).toBe('25.568.099');
    expect(formatCount(999)).toBe('999');
  });

  it('schreibt Dauern in Stunden, Minuten und Sekunden', () => {
    expect(formatDuration(4_200)).toBe('4 s');
    expect(formatDuration(192_000)).toBe('3 min 12 s');
    expect(formatDuration(3_725_000)).toBe('1 h 2 min');
  });
});

describe('Progress', () => {
  it('meldet höchstens einmal je Intervall, mit Prozent und Restzeit', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const progress = new Progress((m) => lines.push(m), 'Suchindex', {
      total: 1000,
      intervalMs: 15_000,
      now: clock.now,
    });

    progress.update(100);
    expect(lines).toEqual([]);

    clock.advance(15_000);
    progress.update(250);
    // 250 in 15 s → 750 übrige brauchen noch 45 s
    expect(lines).toEqual(['Suchindex: 250 / 1.000 (25 %), noch ca. 45 s']);

    clock.advance(5_000);
    progress.update(400);
    expect(lines).toHaveLength(1);
  });

  it('meldet ohne bekannte Gesamtzahl Anzahl und Rate', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const progress = new Progress((m) => lines.push(m), 'Features', {
      intervalMs: 10_000,
      now: clock.now,
    });
    clock.advance(10_000);
    progress.update(420_000, 'Wege');
    expect(lines).toEqual(['Features: 420.000 (42.000/s), gerade Wege']);
  });

  it('meldet am Ende Anzahl und Dauer', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const progress = new Progress((m) => lines.push(m), 'Suchindex', {
      total: 1000,
      now: clock.now,
    });
    clock.advance(192_000);
    progress.finish(1000);
    expect(lines).toEqual(['Suchindex fertig: 1.000 in 3 min 12 s']);
  });
});

describe('Steps', () => {
  it('nummeriert die Schritte und meldet die Dauer des vorigen', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const steps = new Steps((m) => lines.push(m), 3, { now: clock.now });

    steps.start('Grenzen laden');
    clock.advance(34_000);
    steps.start('Filtern');
    clock.advance(90_000);
    steps.done();

    expect(lines).toEqual([
      'Schritt 1/3: Grenzen laden',
      'Schritt 1/3 fertig in 34 s',
      'Schritt 2/3: Filtern',
      'Schritt 2/3 fertig in 1 min 30 s',
    ]);
  });

  it('beginnt bei einem Versatz, wenn ein Schritt vorher lief (Download)', () => {
    const lines: string[] = [];
    const steps = new Steps((m) => lines.push(m), 5, { first: 2 });
    steps.start('Grenzen laden');
    expect(lines).toEqual(['Schritt 2/5: Grenzen laden']);
  });
});

describe('Fortschritt beim Import', () => {
  it('meldet jede Phase des Indexaufbaus bis 100 %', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { importFromGeoJsonSeq } = await import('../../src/import/pipeline.js');
    const dir = await mkdtemp(join(tmpdir(), 'doorstep-progress-'));
    try {
      const lines: string[] = [];
      await importFromGeoJsonSeq(
        join(import.meta.dirname, '..', 'fixtures', 'koenigsallee.geojsonseq'),
        join(dir, 'index.sqlite'),
        { log: (m) => lines.push(m), progressIntervalMs: 0 },
      );
      const has = (pattern: RegExp) => lines.some((l) => pattern.test(l));
      expect(
        has(/^Features einlesen: [\d.]+ \([\d.]+\/s\), gerade (Knoten|Wege|Relationen)$/),
      ).toBe(true);
      expect(has(/^Features einlesen fertig: [\d.]+ in /)).toBe(true);
      expect(has(/^Einträge sortieren$/)).toBe(true);
      expect(has(/^Straßen zuordnen: [\d.]+ \/ [\d.]+ \(100 %\)/)).toBe(true);
      expect(has(/^Suchindex aufbauen: [\d.]+ \/ [\d.]+ \(100 %\)/)).toBe(true);
      expect(has(/^Wortstatistik und Optimierung$/)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
