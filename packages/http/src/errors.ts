import type { UnknownRecord } from '@borecount/core/base';
import { isDomainError, RateLimitExceededError } from '@borecount/core/errors';
import type { InferSchema } from './schema-types';

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

// Hosts enforce resource limits; this contract only adds the retry delay to the shared error shape.
export const rateLimitExceededResponseSchema = {
  ...errorResponseSchema,
  required: [...errorResponseSchema.required, 'retry_after_seconds'],
  properties: {
    ...errorResponseSchema.properties,
    retry_after_seconds: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  },
} as const;

export type RateLimitExceededResponse = InferSchema<typeof rateLimitExceededResponseSchema>;

export type ErrorResponse = {
  error: string;
  message: string;
  details?: UnknownRecord;
};

const asRecord = (value: unknown): UnknownRecord | null =>
  typeof value === 'object' && value !== null ? (value as UnknownRecord) : null;

const extractDetails = (error: unknown): UnknownRecord | undefined => {
  const record = asRecord(error);
  return asRecord(record?.details) ?? undefined;
};

export const toHttpErrorPayload = (
  error: unknown,
): ErrorResponse & {
  statusCode: number;
  headers?: Record<string, string>;
  retry_after_seconds?: number;
} => {
  if (error instanceof RateLimitExceededError) {
    return {
      statusCode: 429,
      headers: { 'Retry-After': String(error.retryAfterSeconds) },
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Rate limit exceeded',
      retry_after_seconds: error.retryAfterSeconds,
    };
  }

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
