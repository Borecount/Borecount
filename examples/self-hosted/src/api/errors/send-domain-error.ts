import type { FastifyReply } from 'fastify';
import { toHttpErrorPayload } from '@borecount/http';

export const mapHostError = (error: unknown) => {
  const payload = toHttpErrorPayload(error);
  // Even branded domain 5xx errors must not expose underlying diagnostics.
  return payload.statusCode >= 500
    ? { statusCode: payload.statusCode, body: { error: 'INTERNAL_ERROR', message: 'Internal server error' } }
    : payload;
};
export const sendDomainError = (reply: FastifyReply, error: unknown): FastifyReply => {
  const payload = mapHostError(error);
  if ('headers' in payload && payload.headers) reply.headers(payload.headers);
  return reply.status(payload.statusCode).send(payload.body);
};
