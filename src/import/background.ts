import { spawn, type StdioOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config/index.js';
import { INDEX_FILE } from './pipeline.js';

/** An import running as a separate process next to the API. */
export interface BackgroundImport {
  readonly running: boolean;
  /** `true` if the process exits with code 0. */
  readonly done: Promise<boolean>;
  stop(): void;
}

/** `serve` should import: AUTO_IMPORT is on and there is no index yet. */
export function needsAutoImport(config: Config): boolean {
  return config.autoImport && !existsSync(join(config.dataDir, INDEX_FILE));
}

/**
 * Starts the import as a child process. It runs separately from the API so that the
 * synchronous SQLite writes do not block the server's event loop.
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
