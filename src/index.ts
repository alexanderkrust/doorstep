import { Metrics } from './api/metrics.js';
import { buildServer, DEFAULT_RELOAD_INTERVAL_MS } from './api/server.js';
import { ConfigError, loadConfig } from './config/index.js';
import { ImportArgsError, parseImportArgs } from './import/args.js';
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
  'Verwendung: doorstep <serve|import|update> [--region <url>] [--input <datei.osm.pbf>]';

/** Exit-Code, wenn bereits ein Import läuft (EX_TEMPFAIL). */
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

  // Derselbe Einstieg wie dieser Prozess, nur mit einem anderen Kommando.
  const script = process.argv[1] ?? '';
  const startJob = (command: 'import' | 'update') =>
    startBackgroundImport(process.execPath, [...process.execArgv, script, command]);

  const shutdown = (signal: string) => {
    app.log.info({ signal }, 'Fahre herunter');
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
  // Sofort auf einen neuen Index wechseln, ohne auf die nächste Prüfung zu warten.
  process.on('SIGHUP', () => {
    if (!app.reloadIndex()) app.log.info('SIGHUP: Index unverändert');
  });

  await app.listen({ host: config.host, port: config.port });

  if (config.updateCron) {
    cron = scheduleCron(
      config.updateCron,
      async () => {
        if (job?.running) {
          metrics.observeUpdate('skipped');
          app.log.warn('Geplantes Update übersprungen: es läuft bereits ein Import');
          return;
        }
        app.log.info({ region: config.regionUrl }, 'Starte geplantes Update');
        job = startJob('update');
        const ok = await job.done;
        metrics.observeUpdate(ok ? 'success' : 'failure');
        if (ok) {
          app.reloadIndex();
          app.log.info({ next: cron?.next() }, 'Geplantes Update fertig');
        } else if (!stopping.signal.aborted) {
          app.log.error(
            { next: cron?.next() },
            'Geplantes Update fehlgeschlagen, der bisherige Index bleibt aktiv',
          );
        }
      },
      (err: unknown) => {
        app.log.error({ err }, 'Geplantes Update fehlgeschlagen');
      },
    );
    app.log.info({ cron: config.updateCron, next: cron.next() }, 'Geplante Updates aktiv');
  }

  if (needsAutoImport(config)) {
    app.log.info(
      { region: config.regionUrl },
      'Kein Index vorhanden, starte Import im Hintergrund (bis dahin antwortet /api mit 503)',
    );
    job = startJob('import');
    const ok = await job.done;
    if (ok) {
      app.log.info('Import fertig, der Index ist aktiv');
    } else if (!stopping.signal.aborted) {
      app.log.error('Import fehlgeschlagen, beende den Server');
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
  const started = Date.now();
  const result = await runImport({
    dataDir: config.dataDir,
    regionUrl: args.regionUrl,
    ...(args.input ? { input: args.input } : {}),
    log: (message) => {
      log.info(message);
    },
  });
  log.info('Fertig', {
    seconds: Math.round((Date.now() - started) / 100) / 10,
    places: result.places,
    skipped: result.skipped,
    ...(command === 'update'
      ? { hint: 'Eine laufende API lädt den neuen Index automatisch (spätestens nach 5 s)' }
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
      // Beide bauen index.next.sqlite und tauschen ihn atomar aus; `update` lädt den
      // Extrakt nur neu, wenn sich die Geofabrik-MD5 geändert hat.
      await importCommand(command, rest);
      return;
    default:
      console.error(`Unbekanntes Kommando: ${command}\n${USAGE}`);
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
