import { type ApplicationServices, ForbiddenError } from '@borecount/core/application';
import {
  type CreateAdjustmentRequest,
  createAdjustmentBodySchema,
} from '@borecount/http/contracts';
import { toAdjustmentResponse } from '@borecount/http/mappers';
import type { AdjustmentAuthorizationHook } from '@borecount/http/route-core';
import type { Application, Response } from 'express';
import { sendInvalidInput, withDomainErrorHandling } from '../errors/handlers';
import { requireContext } from '../request/context';
import { validate } from '../request/validation';
import type { RequestWithContext } from '../types';

export const registerAdjustmentRoutes = (
  app: Application,
  services: Pick<ApplicationServices, 'adjustments'>,
  authorizeAdjustment?: AdjustmentAuthorizationHook<RequestWithContext>,
): void => {
  for (const [path, direction] of [
    ['/v1/adjustments/credit', 'credit'],
    ['/v1/adjustments/debit', 'debit'],
  ] as const) {
    app.post(path, async (req: RequestWithContext, res: Response) =>
      withDomainErrorHandling(res, async () => {
        const validatedBody = validate<CreateAdjustmentRequest>(
          createAdjustmentBodySchema,
          req.body,
        );
        if (!validatedBody) {
          sendInvalidInput(res, 'Invalid request body');
          return;
        }
        const { tenantId, apiKeyId, apiKeyRole } = requireContext(req);
        const body = authorizeAdjustment ? structuredClone(validatedBody) : validatedBody;
        const actorId = body.actor_id;
        if (authorizeAdjustment) {
          const actor = await authorizeAdjustment({
            request: req,
            direction,
            tenantId,
            apiKeyId,
            apiKeyRole,
            body: structuredClone(body),
          });
          if (!actor || actor.actorId !== actorId) {
            throw new ForbiddenError('Actor claim conflicts with trusted context');
          }
        }
        const result = await services.adjustments[direction]({
          tenantId,
          ledgerId: body.ledger_id,
          accountId: body.account_id,
          offsetAccountId: body.offset_account_id,
          reference: body.reference,
          amountMinor: BigInt(body.amount_minor),
          description: body.description,
          reasonCode: body.reason_code,
          actorId,
          attributes: body.attributes,
        });
        res.status(result.created ? 201 : 200).json(toAdjustmentResponse(result));
      }),
    );
  }
};
