/**
 * Starts the example as an operating-system process.
 * Reads private configuration, asks host.ts to assemble the application, opens the
 * HTTP listener, and handles bounded graceful shutdown for SIGTERM and SIGINT.
 */
import { readFile } from 'node:fs/promises';
import { createSelfHostedServer } from './host';

try {
  // The request container receives only runtime/auth credentials and signing keys.
  // File input avoids putting secrets in Compose interpolation or command arguments.
  const config = process.env.SELF_HOST_CONFIG
    ? JSON.parse(await readFile(process.env.SELF_HOST_CONFIG, 'utf8')) : process.env;
  const env = { ...process.env, ...config };
  const port = Number(env.PORT ?? 3000);
  const timeout = Number(env.SHUTDOWN_TIMEOUT_MS ?? 10000);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(timeout) || timeout < 1) {
    throw new Error('Invalid port or shutdown deadline');
  }
  const server = await createSelfHostedServer(env);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => process.exit(1), timeout);
    timer.unref();
    try { await server.close(); clearTimeout(timer); process.exitCode = 0; }
    catch { process.exitCode = 1; }
  };
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
  await server.listen({ host: env.HOST ?? '0.0.0.0', port });
} catch {
  process.stderr.write('Self-hosted startup failed; check release, roles and configuration\n');
  process.exitCode = 1;
}
