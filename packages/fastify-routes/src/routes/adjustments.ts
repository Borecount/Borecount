import {
  type AdjustmentService,
  ForbiddenError,
  UnauthorizedError,
} from '@borecount/core/application';
import {
  adjustmentResponseSchema,
  type CreateAdjustmentRequest,
  createAdjustmentBodySchema,
} from '@borecount/http/contracts';
import { toAdjustmentResponse } from '@borecount/http/mappers';
import type { AdjustmentAuthorizationHook } from '@borecount/http/route-core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { handleValidationError } from '../errors/validation-error-handler';
import { BaseRoute } from '../routing/base-route';

export class AdjustmentRoutes extends BaseRoute {
  public constructor(
    private readonly adjustments: AdjustmentService,
    private readonly authorizeAdjustment?: AdjustmentAuthorizationHook<FastifyRequest>,
  ) {
    super();
  }

  public register(server: FastifyInstance): void {
    for (const [path, direction] of [
      ['/v1/adjustments/credit', 'credit'],
      ['/v1/adjustments/debit', 'debit'],
    ] as const) {
      server.post<{ Body: CreateAdjustmentRequest }>(
        path,
        {
          errorHandler: handleValidationError,
          schema: {
            body: createAdjustmentBodySchema,
            response: { 200: adjustmentResponseSchema, 201: adjustmentResponseSchema },
          },
        },
        async (request, reply) =>
          this.handle(reply, async () => {
            const body = request.body;
            const { tenantId, apiKeyId, apiKeyRole } = request;
            if (!tenantId || !apiKeyId || !apiKeyRole) {
              throw new UnauthorizedError('Bearer token is required');
            }
            const actorId = body.actor_id;
            if (this.authorizeAdjustment) {
              const actor = await this.authorizeAdjustment({
                request,
                direction,
                tenantId,
                apiKeyId,
                apiKeyRole,
                body,
              });
              if (!actor || actor.actorId !== actorId) {
                throw new ForbiddenError('Actor claim conflicts with trusted context');
              }
            }
            const result = await this.adjustments[direction]({
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
            return reply.status(result.created ? 201 : 200).send(toAdjustmentResponse(result));
          }),
      );
    }
  }
}
