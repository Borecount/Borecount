/** Validate every host-owned PostgreSQL URL before creating a client. */
import { existsSync } from 'node:fs';

// Execution context comes from the process, never from the host's private JSON config.
export function parseDatabaseUrl(value, { env = process.env, inDocker = existsSync('/.dockerenv') } = {}) {
  const composeNetwork = inDocker && env.SELF_HOST_NETWORK === 'compose';
  let url;
  try { url = new URL(typeof value === 'string' ? value.trim() : ''); } catch {}
  if (!url || !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname || !url.pathname || url.pathname === '/') {
    throw new Error('Database URL must specify an explicit PostgreSQL host and database');
  }
  if (url.hostname.includes(':')) throw new Error('IPv6 PostgreSQL URLs are unsupported by the pinned driver');
  let username, password;
  try { username = decodeURIComponent(url.username); password = decodeURIComponent(url.password); } catch {}
  if (!username || !password || username.includes('\0') || password.includes('\0')) {
    throw new Error('Explicit PostgreSQL username and password are required');
  }
  // Pin the effective port: postgres.js otherwise consults PGPORT for a missing URL port.
  if (!url.port) url.port = '5432';
  const seen = new Set();
  for (const [key] of url.searchParams) {
    const normalized = key.toLowerCase();
    if (seen.has(normalized)) throw new Error('Duplicate PostgreSQL URL parameters are forbidden');
    seen.add(normalized);
    if (!['sslmode', 'application_name'].includes(key)) {
      throw new Error('Only sslmode and application_name are supported in PostgreSQL URL queries');
    }
  }
  const local = ['127.0.0.1', 'localhost'].includes(url.hostname) ||
    (composeNetwork && url.hostname === 'postgres');
  if (!local &&
      url.searchParams.get('sslmode') !== 'verify-full') {
    throw new Error('Remote PostgreSQL requires verified TLS');
  }
  return url;
}
