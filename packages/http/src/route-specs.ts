import {
  errorResponseSchema,
  rateLimitExceededResponseSchema,
  requestTooLargeResponseSchema,
} from './errors';

export const defaultErrorResponses = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
  413: requestTooLargeResponseSchema,
  429: rateLimitExceededResponseSchema,
  500: errorResponseSchema,
} as const;
