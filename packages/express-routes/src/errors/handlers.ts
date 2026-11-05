import { toHttpErrorPayload } from '@borecount/http/errors';
import { withErrorHandling } from '@borecount/http/route-core';
import type { Response } from 'express';

export const sendInvalidInput = (res: Response, message: string): Response =>
  res.status(400).json({ error: 'INVALID_INPUT', message });

const sendDomainError = (res: Response, error: unknown): Response => {
  const { statusCode, headers, ...body } = toHttpErrorPayload(error);
  if (headers) res.set(headers);
  return res.status(statusCode).json(body);
};

export const withDomainErrorHandling = async (
  res: Response,
  handler: () => Promise<void>,
): Promise<void> => {
  await withErrorHandling(handler, (error) => {
    sendDomainError(res, error);
  });
};
