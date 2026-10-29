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
  it('runs the task at the next point in time and schedules the following one', async () => {
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

  it('keeps running after the task fails', async () => {
    const onError = vi.fn();
    const task = vi.fn(() => Promise.reject(new Error('broken')));
    const job = scheduleCron('*/1 * * * *', task, onError);

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
    job.stop();
  });

  it('starts no new run while the previous one is still running', async () => {
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

  it('bridges waits longer than a setTimeout', async () => {
    const task = vi.fn(() => Promise.resolve());
    // Next January 1: a good two months, longer than 2^31-1 ms (~24.8 days).
    const job = scheduleCron('0 0 1 1 *', task);
    await vi.advanceTimersByTimeAsync(60 * 24 * 3600 * 1000);
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 24 * 3600 * 1000);
    expect(task).toHaveBeenCalledTimes(1);
    job.stop();
  });

  it('runs nothing after stop()', async () => {
    const task = vi.fn(() => Promise.resolve());
    const job = scheduleCron('* * * * *', task);
    job.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(task).not.toHaveBeenCalled();
    expect(job.next()).toBeNull();
  });
});
