import { buildServer } from './api/server.js';
import { ConfigError, loadConfig } from './config/index.js';
import { ImportArgsError, parseImportArgs } from './import/args.js';
import { runImport } from './import/pipeline.js';

const USAGE = 'Verwendung: doorstep <serve|import> [--region <url>] [--input <datei.osm.pbf>]';

async function serve(): Promise<void> {
  const config = loadConfig();
  const app = buildServer(config);

  const shutdown = (signal: string) => {
    app.log.info({ signal }, 'Fahre herunter');
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
