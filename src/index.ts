import { Metrics } from './api/metrics.js';
import { buildServer, DEFAULT_RELOAD_INTERVAL_MS } from './api/server.js';
import { checkIndexAtStart, securityWarnings } from './api/startup.js';
import { ConfigError, loadConfig } from './config/index.js';
import { assertImportAllowed, ImportArgsError, parseImportArgs } from './import/args.js';
import {
  needsAutoImport,
  startBackgroundImport,
  type BackgroundImport,
} from './import/background.js';
import { LockError } from './import/lock.js';
import { createCliLogger } from './import/log.js';
import { runImport } from './import/pipeline.js';
import { scheduleCron, type ScheduledJob } from './import/scheduler.js';

const USAGE =
  'Usage: doorstep <serve|import|update> [--region <url>] [--input <file.osm.pbf>] [--force]';

/** Exit code when an import is already running (EX_TEMPFAIL). */
const EXIT_LOCKED = 75;

async function serve(): Promise<void> {
  const config = loadConfig();
  let job: BackgroundImport | undefined;
  let cron: ScheduledJob | undefined;
  const stopping = new AbortController();
  const metrics = new Metrics();
  const app = buildServer(config, {
    importing: () => job?.running ?? false,
    reloadIntervalMs: DEFAULT_RELOAD_INTERVAL_MS,
    metrics,
  });

  // Same entry point as this process, just with a different command.
  const script = process.argv[1] ?? '';
  const startJob = (command: 'import' | 'update') =>
    startBackgroundImport(process.execPath, [...process.execArgv, script, command]);

  const shutdown = (signal: string) => {
    app.log.info({ signal }, 'Shutting down');
    // Open requests get SHUTDOWN_TIMEOUT_MS; a hanging one must not keep the process (and an
    // orchestrator's rollout) waiting until it is killed.
    setTimeout(() => {
      app.log.error(
        { timeoutMs: config.shutdownTimeoutMs },
        'Shutdown took too long, ending the process',
      );
      process.exit(1);
    }, config.shutdownTimeoutMs).unref();
    stopping.abort();
    cron?.stop();
    job?.stop();
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error(err);
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  // Switch to a new index right away, without waiting for the next check.
  process.on('SIGHUP', () => {
    if (!app.reloadIndex()) app.log.info('SIGHUP: index unchanged');
  });

  for (const warning of securityWarnings(config)) app.log.warn(warning);

  const check = checkIndexAtStart(config);
  app.log[check.level]({ indexMode: config.indexMode, indexPath: config.indexPath }, check.message);
  if (check.exit) {
    await app.close();
    process.exit(1);
  }
  if (config.indexMode === 'mounted') {
    app.log.info(
      'INDEX_MODE=mounted: no download, import or scheduled update; a replaced index file is loaded automatically',
    );
  }

  await app.listen({ host: config.host, port: config.port });

  if (config.updateCron) {
    cron = scheduleCron(
      config.updateCron,
      async () => {
        if (job?.running) {
          metrics.observeUpdate('skipped');
          app.log.warn('Skipped scheduled update: an import is already running');
          return;
        }
        app.log.info({ region: config.regionUrl }, 'Starting scheduled update');
        job = startJob('update');
        const ok = await job.done;
        metrics.observeUpdate(ok ? 'success' : 'failure');
        if (ok) {
          app.reloadIndex();
          app.log.info({ next: cron?.next() }, 'Scheduled update finished');
        } else if (!stopping.signal.aborted) {
          app.log.error(
            { next: cron?.next() },
            'Scheduled update failed, keeping the current index',
          );
        }
      },
      (err: unknown) => {
        app.log.error({ err }, 'Scheduled update failed');
      },
    );
    app.log.info({ cron: config.updateCron, next: cron.next() }, 'Scheduled updates enabled');
  }

  if (needsAutoImport(config)) {
    app.log.info(
      { region: config.regionUrl },
      'No index available, starting import in the background (/api answers 503 until then)',
    );
    job = startJob('import');
    const ok = await job.done;
    if (ok) {
      app.log.info('Import finished, the index is active');
    } else if (!stopping.signal.aborted) {
      app.log.error('Import failed, stopping the server');
      cron?.stop();
      await app.close();
      process.exit(1);
    }
  }
}

async function importCommand(command: 'import' | 'update', argv: string[]): Promise<void> {
  const config = loadConfig();
  const log = createCliLogger(command, config.logLevel);
  const args = parseImportArgs(argv, config.regionUrl);
  assertImportAllowed(command, config.indexMode, args);
  const started = Date.now();
  const result = await runImport({
    dataDir: config.dataDir,
    indexPath: config.indexPath,
    indexTypes: config.indexTypes,
    regionUrl: args.regionUrl,
    ...(args.input ? { input: args.input } : {}),
    mode: command,
    diffUpdates: config.diffUpdates,
    downloadTimeoutMs: config.downloadTimeoutMs,
    log: (message) => {
      log.info(message);
    },
  });
  log.info('Done', {
    seconds: Math.round((Date.now() - started) / 100) / 10,
    extract: result.extract.kind,
    ...(result.extract.kind === 'diff' ? { diffs: result.extract.diffs } : {}),
    rebuilt: result.rebuilt,
    places: result.places,
    skipped: result.skipped,
    ...(command === 'update' && result.rebuilt
      ? { hint: 'A running API loads the new index automatically (within 5 s)' }
      : {}),
  });
}

async function main(argv: string[]): Promise<void> {
  const [command = 'serve', ...rest] = argv;
  switch (command) {
    case 'serve':
      await serve();
      return;
    case 'import':
    case 'update':
      // Both build index.next.sqlite and swap it in atomically; `update` downloads the
      // extract again only if the Geofabrik MD5 has changed.
      await importCommand(command, rest);
      return;
    default:
      console.error(`Unknown command: ${command}\n${USAGE}`);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else if (err instanceof ImportArgsError) {
    console.error(`${err.message}\n${USAGE}`);
  } else if (err instanceof LockError) {
    console.error(err.message);
    process.exit(EXIT_LOCKED);
  } else {
    console.error(err);
  }
  process.exit(1);
});
