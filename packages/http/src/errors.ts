import { type DomainError, isDomainError, type UnknownRecord } from '@borecount/core/base';
import type { InferSchema } from './schema-types';

// Hosts enforce resource limits; these contracts only govern their HTTP responses.
export const rateLimitExceededResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['error', 'message', 'retry_after_seconds'],
  properties: {
    error: { type: 'string', enum: ['RATE_LIMIT_EXCEEDED'] },
    message: { type: 'string', enum: ['Rate limit exceeded'] },
    retry_after_seconds: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  },
} as const;

export const requestTooLargeResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['error', 'message'],
  properties: {
    error: { type: 'string', enum: ['REQUEST_TOO_LARGE'] },
    message: { type: 'string', enum: ['Request too large'] },
  },
} as const;

export type RateLimitExceededResponse = InferSchema<typeof rateLimitExceededResponseSchema>;
export type RequestTooLargeResponse = InferSchema<typeof requestTooLargeResponseSchema>;

export const rateLimitExceededPayload = (retryAfterSeconds: number): RateLimitExceededResponse => {
  if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1) {
    throw new RangeError('retryAfterSeconds must be a positive safe integer');
  }
  return {
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Rate limit exceeded',
    retry_after_seconds: retryAfterSeconds,
  };
};

export const requestTooLargePayload = (): RequestTooLargeResponse => ({
  error: 'REQUEST_TOO_LARGE',
  message: 'Request too large',
});

export type ErrorResponse = {
  error: string;
  message: string;
  details?: UnknownRecord;
};

export const errorResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['error', 'message'],
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
    details: {
      type: 'object',
      additionalProperties: true,
    },
  },
} as const;

export type HttpErrorDto = {
  statusCode: number;
  code: string;
  message: string;
  details?: UnknownRecord;
};

const codeToStatus: Record<string, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  LEDGER_NOT_FOUND: 404,
  ACCOUNT_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  INVARIANT_VIOLATION: 409,
};

export function mapDomainErrorToHttp(error: DomainError): HttpErrorDto {
  return {
    statusCode: codeToStatus[error.code] ?? 400,
    code: error.code,
    message: error.message,
  };
}

const asRecord = (value: unknown): UnknownRecord | null =>
  typeof value === 'object' && value !== null ? (value as UnknownRecord) : null;

const extractDetails = (error: unknown): UnknownRecord | undefined => {
  const record = asRecord(error);
  return asRecord(record?.details) ?? undefined;
};

export const toHttpErrorPayload = (
  error: unknown,
): { statusCode: number; error: string; message: string; details?: UnknownRecord } => {
  if (isDomainError(error)) {
    return {
      statusCode: error.httpStatus,
      error: error.code,
      message: error.message,
      details: extractDetails(error),
    };
  }

  return {
    statusCode: 500,
    error: 'INTERNAL_ERROR',
    message: 'Internal server error',
  };
};

export const invalidInputPayload = (
  message: string,
): { error: 'INVALID_INPUT'; message: string } => ({
  error: 'INVALID_INPUT',
  message,
});
