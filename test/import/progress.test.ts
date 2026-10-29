import { describe, expect, it } from 'vitest';
import { formatCount, formatDuration, Progress, Steps } from '../../src/import/progress.js';

/** A clock that only moves when the test says so. */
function fakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('formatCount and formatDuration', () => {
  it('writes numbers with thousands separators', () => {
    expect(formatCount(25_568_099)).toBe('25,568,099');
    expect(formatCount(999)).toBe('999');
  });

  it('writes durations in hours, minutes and seconds', () => {
    expect(formatDuration(4_200)).toBe('4 s');
    expect(formatDuration(192_000)).toBe('3 min 12 s');
    expect(formatDuration(3_725_000)).toBe('1 h 2 min');
  });
});

describe('Progress', () => {
  it('reports at most once per interval, with percent and remaining time', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const progress = new Progress((m) => lines.push(m), 'Search index', {
      total: 1000,
      intervalMs: 15_000,
      now: clock.now,
    });

    progress.update(100);
    expect(lines).toEqual([]);

    clock.advance(15_000);
    progress.update(250);
    // 250 in 15 s → the remaining 750 need another 45 s
    expect(lines).toEqual(['Search index: 250 / 1,000 (25 %), about 45 s left']);

    clock.advance(5_000);
    progress.update(400);
    expect(lines).toHaveLength(1);
  });

  it('reports count and rate without a known total', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const progress = new Progress((m) => lines.push(m), 'Features', {
      intervalMs: 10_000,
      now: clock.now,
    });
    clock.advance(10_000);
    progress.update(420_000, 'ways');
    expect(lines).toEqual(['Features: 420,000 (42,000/s), currently ways']);
  });

  it('reports count and duration at the end', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const progress = new Progress((m) => lines.push(m), 'Search index', {
      total: 1000,
      now: clock.now,
    });
    clock.advance(192_000);
    progress.finish(1000);
    expect(lines).toEqual(['Search index done: 1,000 in 3 min 12 s']);
  });
});

describe('Steps', () => {
  it('numbers the steps and reports the duration of the previous one', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const steps = new Steps((m) => lines.push(m), 3, { now: clock.now });

    steps.start('Loading boundaries');
    clock.advance(34_000);
    steps.start('Filtering');
    clock.advance(90_000);
    steps.done();

    expect(lines).toEqual([
      'Step 1/3: Loading boundaries',
      'Step 1/3 done in 34 s',
      'Step 2/3: Filtering',
      'Step 2/3 done in 1 min 30 s',
    ]);
  });

  it('starts at an offset when a step ran before (download)', () => {
    const lines: string[] = [];
    const steps = new Steps((m) => lines.push(m), 5, { first: 2 });
    steps.start('Loading boundaries');
    expect(lines).toEqual(['Step 2/5: Loading boundaries']);
  });
});

describe('progress during the import', () => {
  it('reports every phase of building the index up to 100 %', async () => {
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
        has(/^Reading features: [\d,]+ \([\d,]+\/s\), currently (nodes|ways|relations)$/),
      ).toBe(true);
      expect(has(/^Reading features done: [\d,]+ in /)).toBe(true);
      expect(has(/^Sorting entries$/)).toBe(true);
      expect(has(/^Assigning streets: [\d,]+ \/ [\d,]+ \(100 %\)/)).toBe(true);
      expect(has(/^Building search index: [\d,]+ \/ [\d,]+ \(100 %\)/)).toBe(true);
      expect(has(/^Word statistics and optimization$/)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
