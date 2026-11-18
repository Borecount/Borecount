/**
 * Provides the operator-only tenant provisioning entry point.
 * Reads a persisted private onboarding command and invokes the public provisioning
 * service through the separate operator connection. Prints identifiers rather than
 * credentials so interrupted operations can be retried with the original input.
 */
import { parseDatabaseUrl } from './database-policy.mjs';
import { readFile } from 'node:fs/promises';
import { createDbClient, createTenantProvisioningService } from '@borecount/postgres-adapter';

// Operator-only CLI. Persist the generated command before invoking this process;
// the same UUID, raw key and fields make interrupted onboarding safely retryable.
try {
  const config = JSON.parse(await readFile(process.env.SELF_HOST_OPERATOR_CONFIG!, 'utf8'));
  const command = JSON.parse(await readFile(process.env.SELF_HOST_PROVISION_INPUT!, 'utf8'));
  const target = parseDatabaseUrl(config.OPERATOR_DATABASE_URL);
  const client = createDbClient({ databaseUrl: target.href });
  try {
    const [identity] = await client.sql`select pg_has_role(current_user, 'borecount_operator', 'MEMBER') as allowed`;
    if (!identity.allowed) throw new Error('Operator role required');
    const result = await createTenantProvisioningService(client).provisionTenant(command);
    console.log(JSON.stringify({ created: result.created, tenantId: result.tenantId, apiKeyId: result.key.id }));
  } finally { await client.sql.end({ timeout: 5 }); }
} catch {
  console.error('Provisioning rejected; retain the original command and check configuration or conflicting state');
  process.exitCode = 1;
}
