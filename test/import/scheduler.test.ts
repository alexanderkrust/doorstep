import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleCron } from '../../src/import/scheduler.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 28, 2, 59, 30));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduleCron', () => {
  it('führt die Aufgabe zum nächsten Zeitpunkt aus und plant den folgenden', async () => {
    const task = vi.fn(() => Promise.resolve());
    const job = scheduleCron('0 3 * * *', task);
    expect(job.next()).toEqual(new Date(2026, 9, 28, 3, 0));

    await vi.advanceTimersByTimeAsync(29_000);
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(task).toHaveBeenCalledTimes(1);
    expect(job.next()).toEqual(new Date(2026, 9, 29, 3, 0));

    await vi.advanceTimersByTimeAsync(24 * 3600 * 1000);
    expect(task).toHaveBeenCalledTimes(2);
    job.stop();
  });

  it('läuft nach einem Fehler der Aufgabe weiter', async () => {
    const onError = vi.fn();
    const task = vi.fn(() => Promise.reject(new Error('kaputt')));
    const job = scheduleCron('*/1 * * * *', task, onError);

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
    job.stop();
  });

  it('startet keinen neuen Lauf, solange der vorige noch läuft', async () => {
    let finish: () => void = () => undefined;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const job = scheduleCron('* * * * *', task);

    await vi.advanceTimersByTimeAsync(30_000 + 3 * 60_000);
    expect(task).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task).toHaveBeenCalledTimes(2);
    job.stop();
  });

  it('überbrückt Wartezeiten, die länger als ein setTimeout sind', async () => {
    const task = vi.fn(() => Promise.resolve());
    // Nächster 1. Januar: gut zwei Monate, länger als 2^31-1 ms (~24,8 Tage).
    const job = scheduleCron('0 0 1 1 *', task);
    await vi.advanceTimersByTimeAsync(60 * 24 * 3600 * 1000);
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 24 * 3600 * 1000);
    expect(task).toHaveBeenCalledTimes(1);
    job.stop();
  });

  it('führt nach stop() nichts mehr aus', async () => {
    const task = vi.fn(() => Promise.resolve());
    const job = scheduleCron('* * * * *', task);
    job.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(task).not.toHaveBeenCalled();
    expect(job.next()).toBeNull();
  });
});
