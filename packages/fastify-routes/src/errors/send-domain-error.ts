import { toHttpErrorPayload } from '@borecount/http/errors';
import type { FastifyReply } from 'fastify';
import { sendInvalidInput } from './send-invalid-input';
import { isQuerystringValidationError } from './validation-error-handler';

export const sendDomainError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (isQuerystringValidationError(error)) {
    return sendInvalidInput(reply, 'Invalid querystring');
  }
  const { statusCode, headers, body } = toHttpErrorPayload(error);
  if (headers) reply.headers(headers);
  return reply.status(statusCode).send(body);
};
