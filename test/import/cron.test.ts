import { describe, expect, it } from 'vitest';
import { CronError, nextRun, parseCron } from '../../src/import/cron.js';

/** Local time, as the schedule uses it (month 1-based). */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const next = (expr: string, after: Date) => nextRun(parseCron(expr), after);

describe('parseCron', () => {
  it.each([
    '* * * * *',
    '0 3 * * *',
    '*/15 * * * *',
    '0 3 * * 1-5',
    '0 3 1,15 * *',
    '30 2 * 1-12/3 0',
    '0 4 * * 7',
  ])('accepts "%s"', (expr) => {
    expect(() => parseCron(expr)).not.toThrow();
  });

  it.each([
    ['', 'empty'],
    ['0 3 * *', 'four fields'],
    ['0 3 * * * *', 'six fields'],
    ['60 3 * * *', 'minute too large'],
    ['0 24 * * *', 'hour too large'],
    ['0 3 0 * *', 'day 0'],
    ['0 3 * 13 *', 'month 13'],
    ['0 3 * * 8', 'weekday 8'],
    ['0 3 * * mon', 'names'],
    ['*/0 * * * *', 'step 0'],
    ['5-1 * * * *', 'reversed range'],
    ['0 3 * * * ;rm', 'garbage'],
  ])('rejects "%s" (%s)', (expr) => {
    expect(() => parseCron(expr)).toThrow(CronError);
  });
});

describe('nextRun', () => {
  it('finds the next run on the same day', () => {
    expect(next('0 3 * * *', at(2026, 10, 28, 1, 30))).toEqual(at(2026, 10, 28, 3, 0));
  });

  it('moves to the next day when the time has passed', () => {
    expect(next('0 3 * * *', at(2026, 10, 28, 3, 0))).toEqual(at(2026, 10, 29, 3, 0));
    expect(next('0 3 * * *', at(2026, 10, 28, 12, 0))).toEqual(at(2026, 10, 29, 3, 0));
  });

  it('is always after the start time, even in the middle of a minute', () => {
    const after = new Date(at(2026, 10, 28, 3, 0).getTime() + 30_000);
    expect(next('* * * * *', after)).toEqual(at(2026, 10, 28, 3, 1));
  });

  it('respects steps and lists', () => {
    expect(next('*/15 * * * *', at(2026, 10, 28, 10, 16))).toEqual(at(2026, 10, 28, 10, 30));
    expect(next('0 3 1,15 * *', at(2026, 10, 2))).toEqual(at(2026, 10, 15, 3, 0));
  });

  it('crosses month and year boundaries', () => {
    expect(next('0 0 1 1 *', at(2026, 10, 28))).toEqual(at(2027, 1, 1));
    expect(next('0 0 31 * *', at(2026, 11, 1))).toEqual(at(2026, 12, 31));
  });

  it('respects weekdays (0 and 7 = Sunday)', () => {
    // 2026-10-28 is a Wednesday.
    expect(next('0 4 * * 0', at(2026, 10, 28))).toEqual(at(2026, 11, 1, 4, 0));
    expect(next('0 4 * * 7', at(2026, 10, 28))).toEqual(at(2026, 11, 1, 4, 0));
    expect(next('0 4 * * 1-5', at(2026, 10, 30, 5, 0))).toEqual(at(2026, 11, 2, 4, 0));
  });

  it('combines day and weekday with OR when both are set (like cron)', () => {
    // On the 13th or on a Friday: Friday, Oct 30, comes before Nov 13.
    expect(next('0 0 13 * 5', at(2026, 10, 28))).toEqual(at(2026, 10, 30));
  });

  it('throws for a schedule that never matches', () => {
    expect(() => next('0 0 31 2 *', at(2026, 1, 1))).toThrow(CronError);
  });
});
