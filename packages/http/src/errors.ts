import type { UnknownRecord } from '@borecount/core/base';
import { isDomainError, isRateLimitExceededError } from '@borecount/core/errors';
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

type Digit = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
type ErrorStatus = `${4 | 5}${Digit}${Digit}` extends `${infer Status extends number}`
  ? Status
  : never;

export type HttpErrorPayload =
  | {
      statusCode: 429;
      headers: { 'Retry-After': string };
      body: RateLimitExceededResponse;
    }
  | {
      statusCode: Exclude<ErrorStatus, 429>;
      headers?: Record<string, string>;
      body: ErrorResponse;
    };

export const toHttpErrorPayload = (error: unknown): HttpErrorPayload => {
  if (isRateLimitExceededError(error)) {
    return {
      statusCode: 429,
      headers: { 'Retry-After': String(error.retryAfterSeconds) },
      body: {
        error: 'RATE_LIMIT_EXCEEDED',
        message: 'Rate limit exceeded',
        retry_after_seconds: error.retryAfterSeconds,
      },
    };
  }

  if (isDomainError(error) && error.httpStatus !== 429) {
    const details = extractDetails(error);
    return {
      statusCode: error.httpStatus as Exclude<ErrorStatus, 429>,
      body: { error: error.code, message: error.message, ...(details ? { details } : {}) },
    };
  }

  return {
    statusCode: 500,
    body: { error: 'INTERNAL_ERROR', message: 'Internal server error' },
  };
};
