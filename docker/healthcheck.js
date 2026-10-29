// HEALTHCHECK of the image: exit 0 if /health answers 200. No curl in the image.
const port = process.env.PORT ?? '2322';

try {
  const res = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(4000),
  });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
