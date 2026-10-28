import { describe, expect, it } from 'vitest';
import { CronError, nextRun, parseCron } from '../../src/import/cron.js';

/** Lokale Zeit, wie sie der Zeitplan verwendet (Monat 1-basiert). */
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
  ])('akzeptiert "%s"', (expr) => {
    expect(() => parseCron(expr)).not.toThrow();
  });

  it.each([
    ['', 'leer'],
    ['0 3 * *', 'vier Felder'],
    ['0 3 * * * *', 'sechs Felder'],
    ['60 3 * * *', 'Minute zu groß'],
    ['0 24 * * *', 'Stunde zu groß'],
    ['0 3 0 * *', 'Tag 0'],
    ['0 3 * 13 *', 'Monat 13'],
    ['0 3 * * 8', 'Wochentag 8'],
    ['0 3 * * mon', 'Namen'],
    ['*/0 * * * *', 'Schritt 0'],
    ['5-1 * * * *', 'umgekehrter Bereich'],
    ['0 3 * * * ;rm', 'Müll'],
  ])('lehnt "%s" ab (%s)', (expr) => {
    expect(() => parseCron(expr)).toThrow(CronError);
  });
});

describe('nextRun', () => {
  it('findet den nächsten Lauf am selben Tag', () => {
    expect(next('0 3 * * *', at(2026, 10, 28, 1, 30))).toEqual(at(2026, 10, 28, 3, 0));
  });

  it('springt auf den nächsten Tag, wenn der Zeitpunkt vorbei ist', () => {
    expect(next('0 3 * * *', at(2026, 10, 28, 3, 0))).toEqual(at(2026, 10, 29, 3, 0));
    expect(next('0 3 * * *', at(2026, 10, 28, 12, 0))).toEqual(at(2026, 10, 29, 3, 0));
  });

  it('liegt immer nach dem Startzeitpunkt, auch mitten in einer Minute', () => {
    const after = new Date(at(2026, 10, 28, 3, 0).getTime() + 30_000);
    expect(next('* * * * *', after)).toEqual(at(2026, 10, 28, 3, 1));
  });

  it('beachtet Schritte und Listen', () => {
    expect(next('*/15 * * * *', at(2026, 10, 28, 10, 16))).toEqual(at(2026, 10, 28, 10, 30));
    expect(next('0 3 1,15 * *', at(2026, 10, 2))).toEqual(at(2026, 10, 15, 3, 0));
  });

  it('springt über Monats- und Jahresgrenzen', () => {
    expect(next('0 0 1 1 *', at(2026, 10, 28))).toEqual(at(2027, 1, 1));
    expect(next('0 0 31 * *', at(2026, 11, 1))).toEqual(at(2026, 12, 31));
  });

  it('beachtet Wochentage (0 und 7 = Sonntag)', () => {
    // 28.10.2026 ist ein Mittwoch.
    expect(next('0 4 * * 0', at(2026, 10, 28))).toEqual(at(2026, 11, 1, 4, 0));
    expect(next('0 4 * * 7', at(2026, 10, 28))).toEqual(at(2026, 11, 1, 4, 0));
    expect(next('0 4 * * 1-5', at(2026, 10, 30, 5, 0))).toEqual(at(2026, 11, 2, 4, 0));
  });

  it('verknüpft Tag und Wochentag mit ODER, wenn beide gesetzt sind (wie cron)', () => {
    // Am 13. oder an einem Freitag: Freitag, 30.10., kommt vor dem 13.11.
    expect(next('0 0 13 * 5', at(2026, 10, 28))).toEqual(at(2026, 10, 30));
  });

  it('wirft bei einem Zeitplan, der nie zutrifft', () => {
    expect(() => next('0 0 31 2 *', at(2026, 1, 1))).toThrow(CronError);
  });
});
