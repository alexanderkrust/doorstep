import { describe, expect, it } from 'vitest';
import { createCliLogger } from '../../src/import/log.js';

function capture(level: Parameters<typeof createCliLogger>[1]) {
  const lines: string[] = [];
  const log = createCliLogger('import', level, (line) => lines.push(line));
  return { log, lines, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe('createCliLogger', () => {
  it('schreibt eine JSON-Zeile im pino-Format', () => {
    const { log, lines, parsed } = capture('info');
    log.info('Download fertig', { bytes: 42 });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(parsed()[0]).toMatchObject({
      level: 30,
      component: 'import',
      msg: 'Download fertig',
      bytes: 42,
      pid: process.pid,
    });
    expect(typeof parsed()[0]?.['time']).toBe('number');
  });

  it('beachtet LOG_LEVEL', () => {
    const { log, parsed } = capture('error');
    log.info('leise');
    log.error('laut');
    expect(parsed().map((l) => l['msg'])).toEqual(['laut']);
  });

  it('schreibt bei silent nichts', () => {
    const { log, lines } = capture('silent');
    log.error('nichts');
    expect(lines).toEqual([]);
  });
});
