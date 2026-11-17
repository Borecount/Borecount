import type { RateLimitConfig } from './rate-limit/policy';
import type { FastifyServerOptions } from 'fastify';

export interface CreateServerCoreOptions {
  readinessCheck: () => Promise<void>;
  limits?: RateLimitConfig;
  trustedProxies?: string[];
  logger: FastifyServerOptions['logger'];
}
