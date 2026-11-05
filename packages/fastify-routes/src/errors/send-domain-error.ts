import { toHttpErrorPayload } from '@borecount/http/errors';
import type { FastifyReply } from 'fastify';

export const sendDomainError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (
    typeof error === 'object' &&
    error !== null &&
    Array.isArray((error as { validation?: unknown }).validation) &&
    (error as { validationContext?: unknown }).validationContext === 'querystring'
  ) {
    return reply.status(400).send({ error: 'INVALID_INPUT', message: 'Invalid querystring' });
  }
  const { statusCode, headers, body } = toHttpErrorPayload(error);
  if (headers) reply.headers(headers);
  return reply.status(statusCode).send(body);
};
