import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { sendInvalidInput } from './send-invalid-input';

type ValidationError = FastifyError & {
  validation?: unknown;
  validationContext?: string;
};

export const isQuerystringValidationError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  Array.isArray((error as { validation?: unknown }).validation) &&
  (error as { validationContext?: unknown }).validationContext === 'querystring';

const validationMessage = (context: string | undefined): string => {
  if (context === 'params') return 'Invalid path parameter';
  if (context === 'querystring') return 'Invalid querystring';
  return 'Invalid request body';
};

export const handleValidationError = (
  error: ValidationError,
  _request: FastifyRequest,
  reply: FastifyReply,
): void => {
  if (Array.isArray(error.validation)) {
    sendInvalidInput(reply, validationMessage(error.validationContext));
    return;
  }

  throw error;
};
