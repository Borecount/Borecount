/** Validate every host-owned PostgreSQL URL before creating a client. */
export function parseDatabaseUrl(value) {
  let url;
  try { url = new URL(typeof value === 'string' ? value.trim() : ''); } catch {}
  if (!url || !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname || !url.pathname || url.pathname === '/') {
    throw new Error('Database URL must specify an explicit PostgreSQL host and database');
  }
  const seen = new Set();
  for (const [key] of url.searchParams) {
    const normalized = key.toLowerCase();
    if (seen.has(normalized)) throw new Error('Duplicate PostgreSQL URL parameters are forbidden');
    seen.add(normalized);
    if (!['sslmode', 'application_name'].includes(key)) {
      throw new Error('Only sslmode and application_name are supported in PostgreSQL URL queries');
    }
  }
  if (!['127.0.0.1', 'localhost', 'postgres', '[::1]'].includes(url.hostname) &&
      url.searchParams.get('sslmode') !== 'verify-full') {
    throw new Error('Remote PostgreSQL requires verified TLS');
  }
  return url;
}
