import type { ApiKeyRole } from '@borecount/http/contracts';
import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId?: string;
    apiKeyId?: string;
    apiKeyRole?: ApiKeyRole;
  }
}
