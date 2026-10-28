import { spawn, type StdioOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config/index.js';
import { INDEX_FILE } from './pipeline.js';

/** Ein Import, der als eigener Prozess neben der API läuft. */
export interface BackgroundImport {
  readonly running: boolean;
  /** `true`, wenn der Prozess mit Exit-Code 0 endet. */
  readonly done: Promise<boolean>;
  stop(): void;
}

/** `serve` soll importieren: AUTO_IMPORT ist an und es gibt noch keinen Index. */
export function needsAutoImport(config: Config): boolean {
  return config.autoImport && !existsSync(join(config.dataDir, INDEX_FILE));
}

/**
 * Startet den Import als Kindprozess. Er läuft getrennt von der API, damit die
 * synchronen SQLite-Schreibzugriffe die Event-Loop des Servers nicht blockieren.
 */
export function startBackgroundImport(
  command: string,
  args: string[],
  stdio: StdioOptions = 'inherit',
): BackgroundImport {
  let running = true;
  const child = spawn(command, args, { stdio });
  const done = new Promise<boolean>((resolve) => {
    child.once('error', () => {
      running = false;
      resolve(false);
    });
    child.once('exit', (code) => {
      running = false;
      resolve(code === 0);
    });
  });
  return {
    get running() {
      return running;
    },
    done,
    stop() {
      if (running) child.kill('SIGTERM');
    },
  };
}
