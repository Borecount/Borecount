import { readFile } from 'node:fs/promises';
import { createDbClient, createTenantProvisioningService } from '@borecount/postgres-adapter';

// Operator-only CLI. Persist the generated command before invoking this process;
// the same UUID, raw key and fields make interrupted onboarding safely retryable.
try {
  const config = JSON.parse(await readFile(process.env.SELF_HOST_OPERATOR_CONFIG!, 'utf8'));
  const command = JSON.parse(await readFile(process.env.SELF_HOST_PROVISION_INPUT!, 'utf8'));
  if (!config.OPERATOR_DATABASE_URL) throw new Error('Operator connection required');
  const client = createDbClient({ databaseUrl: config.OPERATOR_DATABASE_URL });
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
