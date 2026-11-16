/**
 * Composes the runnable self-hosted example from configuration and public packages.
 * Creates separate runtime and credential-lookup database clients, verifies their
 * security configuration, and supplies application services and authorization policy
 * to the HTTP server. Owns database cleanup; index.ts owns listening and process signals.
 */
import { createApplicationServices, createDbClient } from '@borecount/postgres-adapter';
import { ApiKeyRole } from '@borecount/core/application';
import { ForbiddenError } from '@borecount/core/errors';
import { createServerCore, registerApplication } from './api/server';
import { parseJwtAuthConfig } from './api/auth/policy';
import { parseRateLimitConfig } from './api/rate-limit/policy';
import { HostProtection } from './api/resource-protection/host-protection';
import { parseTrustedProxies } from './api/resource-protection/trusted-proxies';

export async function createSelfHostedServer(env: NodeJS.ProcessEnv, logger: Parameters<typeof createServerCore>[0]['logger'] = true) {
  if (!env.DATABASE_URL || !env.AUTH_DATABASE_URL || env.DATABASE_URL === env.AUTH_DATABASE_URL) {
    throw new Error('Separate runtime and authentication connections are required');
  }
  const target = new URL(env.DATABASE_URL);
  const authTarget = new URL(env.AUTH_DATABASE_URL);
  if (target.hostname !== authTarget.hostname || target.port !== authTarget.port || target.pathname !== authTarget.pathname) {
    throw new Error('Runtime and authentication must use the same database endpoint');
  }
  for (const url of [target, authTarget]) {
    if (!['127.0.0.1', 'localhost', 'postgres'].includes(url.hostname) && url.searchParams.get('sslmode') !== 'verify-full') {
      throw new Error('Remote PostgreSQL requires verified TLS');
    }
  }
  const limits = parseRateLimitConfig(env);
  const jwtAuth = parseJwtAuthConfig(env);
  const positive = (value: string | undefined, fallback: number) => {
    const parsed = Number(value ?? fallback);
    if (!Number.isInteger(parsed) || parsed < 1) throw new Error('Invalid pool configuration');
    return parsed;
  };
  const pool = { idleTimeoutSeconds: positive(env.DB_IDLE_TIMEOUT, 20),
    connectTimeoutSeconds: positive(env.DB_CONNECT_TIMEOUT, 10) };
  const runtime = createDbClient({ databaseUrl: env.DATABASE_URL, ...pool, max: positive(env.DB_POOL_MAX, 10) });
  const lookup = createDbClient({ databaseUrl: env.AUTH_DATABASE_URL, ...pool, max: positive(env.AUTH_DB_POOL_MAX, 2) });
  const close = async () => {
    await Promise.all([runtime.sql.end({ timeout: 5 }), lookup.sql.end({ timeout: 5 })]);
  };
  try {
    // Fail closed if privileged credentials or the wrong database are supplied.
    // This profile deliberately has no demo tables, provisioning routes or reset worker.
    const check = async () => {
      const [identity] = await runtime.sql`select current_user as role,
        current_database() as database, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
        pg_has_role(current_user, 'borecount_runtime', 'MEMBER') as runtime,
        pg_has_role(current_user, 'borecount_operator', 'MEMBER') as operator,
        pg_has_role(current_user, 'borecount_authenticator', 'MEMBER') as authenticator,
        pg_has_role(current_user, 'borecount_credential_owner', 'MEMBER') as credential_owner,
        has_schema_privilege(current_user, 'public', 'CREATE') as ddl
        from pg_roles where rolname = current_user`;
      const [auth] = await lookup.sql`select current_user as role, current_database() as database,
        rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
        pg_has_role(current_user, 'borecount_authenticator', 'MEMBER') as authenticator,
        pg_has_role(current_user, 'borecount_runtime', 'MEMBER') as runtime,
        pg_has_role(current_user, 'borecount_operator', 'MEMBER') as operator,
        pg_has_role(current_user, 'borecount_credential_owner', 'MEMBER') as credential_owner,
        has_table_privilege(current_user, (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'api_keys'), 'SELECT') as credentials,
        has_schema_privilege(current_user, 'public', 'CREATE') as ddl
        from pg_roles where rolname = current_user`;
      if (!identity.runtime || identity.operator || identity.authenticator || identity.credential_owner || identity.ddl ||
          identity.rolsuper || identity.rolbypassrls || identity.rolcreatedb || identity.rolcreaterole ||
          !auth.authenticator || auth.operator || auth.runtime || auth.credential_owner || auth.credentials || auth.ddl || auth.rolsuper || auth.rolbypassrls ||
          auth.rolcreatedb || auth.rolcreaterole || auth.database !== identity.database || auth.role === identity.role) {
        throw new Error('Unsafe self-hosted database role composition');
      }
      const [schema] = await runtime.sql`select count(*)::int as count from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_policy p on p.polrelid = c.oid and p.polname = 'borecount_runtime_scope'
        where n.nspname = 'public' and c.relrowsecurity
        and not pg_has_role(current_user, c.relowner, 'MEMBER')`;
      if (schema.count !== 19) throw new Error('Security overlay is missing or incompatible');
      const [inventory] = await runtime.sql`select count(*)::int as count from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')`;
      if (inventory.count !== 19) throw new Error('This profile requires the package-only schema');
      await lookup.sql`select * from borecount_security.find_active_api_key('readiness-no-key')`;
    };
    await check();
    const server = createServerCore({ limits, logger,
      trustedProxies: parseTrustedProxies(env.TRUSTED_PROXY_CIDRS), readinessCheck: check });
    registerApplication(server, {
      services: createApplicationServices(runtime, lookup), jwtAuth,
      protection: new HostProtection(limits),
      authorizeAdjustment: async ({ apiKeyId, apiKeyRole }) => {
        if (apiKeyRole !== ApiKeyRole.ADMIN) throw new ForbiddenError('Adjustments require an ADMIN key');
        return { actorId: apiKeyId };
      },
    });
    server.addHook('onClose', close);
    return server;
  } catch (error) {
    await close();
    throw error;
  }
}
