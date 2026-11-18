import { createHash, randomBytes } from 'node:crypto';

/** Generate a credential before provisioning; retain it securely for exact retries. */
export const generateApiKey = (): string => `llk_${randomBytes(32).toString('hex')}`;

export const hashApiKey = (apiKey: string): string =>
  createHash('sha256').update(apiKey, 'utf8').digest('hex');
