import { buildServer } from './api/server.js';
import { ConfigError, loadConfig } from './config/index.js';
import { ImportArgsError, parseImportArgs } from './import/args.js';
import {
  needsAutoImport,
  startBackgroundImport,
  type BackgroundImport,
} from './import/background.js';
import { runImport } from './import/pipeline.js';

const USAGE =
  'Verwendung: doorstep <serve|import|update> [--region <url>] [--input <datei.osm.pbf>]';

async function serve(): Promise<void> {
  const config = loadConfig();
  let job: BackgroundImport | undefined;
  const stopping = new AbortController();
  const app = buildServer(config, { importing: () => job?.running ?? false });

  const shutdown = (signal: string) => {
    app.log.info({ signal }, 'Fahre herunter');
    stopping.abort();
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

  await app.listen({ host: config.host, port: config.port });

  if (needsAutoImport(config)) {
    app.log.info(
      { region: config.regionUrl },
      'Kein Index vorhanden, starte Import im Hintergrund (bis dahin antwortet /api mit 503)',
    );
    // Derselbe Einstieg wie dieser Prozess, nur mit dem Kommando `import`.
    const script = process.argv[1] ?? '';
    job = startBackgroundImport(process.execPath, [...process.execArgv, script, 'import']);
    const ok = await job.done;
    if (ok) {
      app.log.info('Import fertig, der Index ist aktiv');
    } else if (!stopping.signal.aborted) {
      app.log.error('Import fehlgeschlagen, beende den Server');
      await app.close();
      process.exit(1);
    }
  }
}

async function importCommand(argv: string[]): Promise<void> {
  const config = loadConfig();
  const args = parseImportArgs(argv, config.regionUrl);
  const started = Date.now();
  const result = await runImport({
    dataDir: config.dataDir,
    regionUrl: args.regionUrl,
    ...(args.input ? { input: args.input } : {}),
    log: (message) => {
      console.log(`[import] ${message}`);
    },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `[import] Fertig in ${seconds} s: ${String(result.places)} Einträge, ${String(result.skipped)} Features übersprungen`,
  );
}

async function main(argv: string[]): Promise<void> {
  const [command = 'serve', ...rest] = argv;
  switch (command) {
    case 'serve':
      await serve();
      return;
    case 'import':
      await importCommand(rest);
      return;
    case 'update':
      // Baut index.next.sqlite und tauscht ihn atomar aus. Ein laufender Server
      // liest den neuen Index erst nach einem Neustart (Neuladen folgt in Phase 6).
      await importCommand(rest);
      console.log('[update] Server neu starten, damit der neue Index aktiv wird');
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
  } else {
    console.error(err);
  }
  process.exit(1);
});
