import { writeFile } from 'node:fs/promises';
import { generateUuidV7 } from '@borecount/core/base';
import { generateApiKey } from '@borecount/core/application';
const path = process.env.SELF_HOST_TENANT_INPUT;
const role = process.env.SELF_HOST_TENANT_ROLE ?? 'ADMIN';
const tenantName = process.env.SELF_HOST_TENANT_NAME;
if (!path || !tenantName?.trim() || !['ADMIN', 'SERVICE'].includes(role)) throw new Error('Supply output path, tenant name and ADMIN/SERVICE role');
process.umask(0o077);
await writeFile(path, JSON.stringify({ tenantId: generateUuidV7(new Date()), tenantName: tenantName.trim(),
  keyName: process.env.SELF_HOST_KEY_NAME ?? 'Initial key', role, rawApiKey: generateApiKey() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log('Private tenant command created; retain it for exact retries');
