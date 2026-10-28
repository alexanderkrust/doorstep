// HEALTHCHECK des Images: Exit 0, wenn /health mit 200 antwortet. Ohne curl im Image.
const port = process.env.PORT ?? '2322';

try {
  const res = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(4000),
  });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
