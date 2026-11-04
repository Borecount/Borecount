import type { JsonPrimitive } from '@borecount/core/base';
import type { ApiKeyRole, CreateAdjustmentRequest } from './contracts';

export type ErrorResponder<ReturnType = unknown> = (error: unknown) => ReturnType;

export const withErrorHandling = async <T>(
  handler: () => Promise<T>,
  onError: ErrorResponder<T>,
): Promise<T> => {
  try {
    return await handler();
  } catch (error) {
    return onError(error);
  }
};

export abstract class BaseRouteCore<HandlerReply> {
  protected async handle(
    handler: () => Promise<HandlerReply>,
    onError: ErrorResponder<HandlerReply>,
  ) {
    return withErrorHandling(handler, onError);
  }
}

export abstract class BaseEntityRouteCore<TEntity, TDto> {
  protected abstract toDto(entity: TEntity): TDto;

  protected dto(entity: TEntity): TDto {
    return this.toDto(entity);
  }

  protected dtoList(entities: TEntity[]): TDto[] {
    return entities.map((entity) => this.toDto(entity));
  }
}

type ReadonlyJsonValue = JsonPrimitive | ReadonlyJsonObject | readonly ReadonlyJsonValue[];
interface ReadonlyJsonObject {
  readonly [key: string]: ReadonlyJsonValue;
}

/** Host policy input after request validation and authentication-context checks. */
export type AdjustmentAuthorizationContext<Request> = {
  readonly request: Request;
  readonly direction: 'credit' | 'debit';
  readonly tenantId: string;
  readonly apiKeyId: string;
  readonly apiKeyRole: ApiKeyRole;
  readonly body: Readonly<Omit<CreateAdjustmentRequest, 'attributes'>> & {
    readonly attributes?: ReadonlyJsonObject;
  };
};

/** Return the trusted effective actor, or throw a safe application error to deny. */
export type AdjustmentAuthorizationHook<Request> = (
  context: AdjustmentAuthorizationContext<Request>,
) => { readonly actorId: string } | Promise<{ readonly actorId: string }>;

export type LedgerAdapterOptions<Request> = {
  /** Defaults to true. Set false only for callers trusted to assert adjustment actors. */
  requireAdjustmentAuthorization?: boolean;
  /** Required unless requireAdjustmentAuthorization is explicitly false. */
  authorizeAdjustment?: AdjustmentAuthorizationHook<Request>;
};
