import { buildServer } from './api/server.js';
import { ConfigError, loadConfig } from './config/index.js';

const USAGE = 'Verwendung: doorstep <serve|import> [--region <url>]';

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

async function main(argv: string[]): Promise<void> {
  const [command = 'serve'] = argv;
  switch (command) {
    case 'serve':
      await serve();
      return;
    case 'import':
      // Wird in Phase 2 umgesetzt.
      loadConfig();
      console.error('Der Import ist noch nicht implementiert (Phase 2).');
      process.exitCode = 1;
      return;
    default:
      console.error(`Unbekanntes Kommando: ${command}\n${USAGE}`);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
});
