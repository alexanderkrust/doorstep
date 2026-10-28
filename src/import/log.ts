import { hostname } from 'node:os';
import type { Config } from '../config/index.js';

/** Pino-Levels, damit Import- und Server-Logs im selben Format im Container-Log landen. */
const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;

export type LogLevel = keyof typeof LEVELS;

export interface CliLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/**
 * Logger für die Kommandos `import` und `update`: eine JSON-Zeile pro Meldung
 * (`level`, `time`, `pid`, `hostname`, `component`, `msg`), wie Fastify/pino.
 */
export function createCliLogger(
  component: string,
  level: Config['logLevel'],
  write: (line: string) => void = (line) => process.stdout.write(line),
): CliLogger {
  const threshold = level === 'silent' ? Infinity : LEVELS[level];
  const base = { pid: process.pid, hostname: hostname(), component };
  const log = (lvl: LogLevel, msg: string, fields: Record<string, unknown> = {}) => {
    if (LEVELS[lvl] < threshold) return;
    write(`${JSON.stringify({ level: LEVELS[lvl], time: Date.now(), ...base, ...fields, msg })}\n`);
  };
  return {
    info: (msg, fields) => {
      log('info', msg, fields);
    },
    error: (msg, fields) => {
      log('error', msg, fields);
    },
  };
}
