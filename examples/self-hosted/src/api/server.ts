/**
 * Implements the example's HTTP server with Fastify.
 * Registers financial API routes, request authentication, resource controls,
 * health/readiness endpoints, metrics, and safe error/log handling. Receives services
 * and policies from host.ts so HTTP setup does not create database connections.
 */
import './fastify-extensions';
import { randomUUID } from 'node:crypto';
import { issueAccessToken, type JwtAuthConfig, verifyAccessToken } from './auth/jwt';
import { sendDomainError } from './errors';
import { HostProtection, protectReports } from './resource-protection/host-protection';
import { ApiMetrics } from './observability/metrics';
import type { CreateServerCoreOptions } from './server-types';
import type { ApplicationServices } from '@borecount/core/application';
import { ApiKeyRole } from '@borecount/core/application';
import { ForbiddenError, UnauthorizedError } from '@borecount/core/errors';
import type { AdjustmentAuthorizationHook } from '@borecount/http/route-core';
import { registerLedgerAdapter } from '@borecount/fastify-routes';
import {
  type AuthTokenRequestHeaders,
  type AuthTokenResponse,
  authTokenResponseSchema,
} from '@borecount/http/contracts';
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';

const API_KEY_HEADER = 'x-api-key';
const BEARER_PREFIX = 'Bearer ';
const TOKEN_ENDPOINT = '/v1/auth/token';
const V1_ROUTE_PREFIX = '/v1/';
const isValidationError = (error: unknown): error is { validation: unknown; message: string } =>
  typeof error === 'object' &&
  error !== null &&
  'validation' in error &&
  'message' in error &&
  typeof (error as { message: unknown }).message === 'string';

const routePath = (url: string): string => {
  const querySeparatorIndex = url.indexOf('?');
  if (querySeparatorIndex === -1) {
    return url;
  }

  return url.slice(0, querySeparatorIndex);
};

const resolveRouteLabel = (request: {
  apiPath?: string;
  routeOptions?: { url?: string };
  url: string;
}): string => {
  const routeTemplate = request.routeOptions?.url;
  if (typeof routeTemplate === 'string' && routeTemplate.length > 0) {
    return routeTemplate;
  }

  return '/unmatched';
};

interface RequestLogContext {
  requestId: string;
  tenantId: string | null;
  apiKeyId: string | null;
  route: string;
}

const buildRequestLogContext = (
  request: { id: string; tenantId?: string; apiKeyId?: string },
  route: string,
): RequestLogContext => ({
  requestId: request.id,
  tenantId: request.tenantId ?? null,
  apiKeyId: request.apiKeyId ?? null,
  route,
});

export const createServerCore = (options: CreateServerCoreOptions): FastifyInstance => {
  const server = Fastify({
    logger: options.logger ? {
      ...(typeof options.logger === 'object' ? options.logger : {}),
      serializers: {
        req: () => ({ redacted: true }),
        res: (reply: { statusCode: number }) => ({ statusCode: reply.statusCode }),
        err: () => ({ type: 'Error', message: 'Internal server error', stack: '' }),
      },
      redact: ['req.headers', 'res.headers', 'authorization', 'cookie', 'body', 'query'],
    } : false,
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'requestId',
    }),
    bodyLimit: options.limits?.bodyBytes ?? 1_048_576,
    trustProxy: options.trustedProxies ?? false,
    requestIdHeader: false,
    genReqId: (request) => {
      const value = request.headers['x-request-id'];
      return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : randomUUID();
    },
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
  });

  server.addHook('onRequest', async (request, reply) => {
    request.requestStartedAt = process.hrtime.bigint();
    reply.header('x-request-id', request.id);
  });

  server.get('/health', async () => {
    return { ok: true };
  });

  server.get('/ready', async (request, reply) => {
    try {
      await options.readinessCheck();
      return reply.status(200).send({ ok: true });
    } catch {
      request.log.error(
        {
          ...buildRequestLogContext(request, '/ready'),
          statusCode: 503,
        },
        'Readiness check failed',
      );
      return reply.status(503).send({
        error: 'NOT_READY',
        message: 'Service not ready',
      });
    }
  });

  server.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: 'NOT_FOUND', message: 'Route not found' }));

  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof Error && 'code' in error && error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send({
        error: 'PAYLOAD_TOO_LARGE',
        message: 'Request body is too large',
      });
    }

    if (isValidationError(error) || (error instanceof Error && 'code' in error &&
        ['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY', 'FST_ERR_CTP_INVALID_MEDIA_TYPE'].includes(String(error.code)))) {
      return reply.status(400).send({
        error: 'INVALID_INPUT',
        message: 'Invalid request',
      });
    }

    return sendDomainError(reply, error);
  });

  server.addHook('onSend', async (request, reply, payload) => {
    if (reply.statusCode >= 500 && request.routeOptions.url !== '/ready') {
      reply.type('application/json');
      reply.removeHeader('content-length');
      return JSON.stringify({ error: 'INTERNAL_ERROR', message: 'Internal server error' });
    }
    return payload;
  });
  return server;
};

export const registerApplication = (
  server: FastifyInstance,
  {
    services,
    jwtAuth,
    authorizeAdjustment,
    protection,
  }: {
    services: ApplicationServices;
    jwtAuth: JwtAuthConfig;
    protection: HostProtection;
    authorizeAdjustment: AdjustmentAuthorizationHook<FastifyRequest>;
  },
): void => {
  const metrics = new ApiMetrics();

  server.decorateRequest('tenantId');
  server.decorateRequest('apiKeyId');
  server.decorateRequest('apiKeyRole');
  server.decorateRequest('apiPath');
  server.decorateRequest('requestStartedAt');

  server.get('/metrics', async (_request, reply) =>
    reply
      .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
      .status(200)
      .send(metrics.renderPrometheus()),
  );

  server.addHook('onRequest', async (request) => {
    const path = request.routeOptions.url ?? routePath(request.url);
    request.apiPath = path;

    if (path.startsWith(V1_ROUTE_PREFIX)) {
      protection.beforeAuth(request.ip);
    }
    if (path === TOKEN_ENDPOINT) protection.tokenAttempt(request.ip);
  });

  server.addHook('onRequest', async (request, reply) => {
    if (reply.sent) {
      return;
    }

    const path = request.apiPath ?? routePath(request.url);

    if (!path.startsWith(V1_ROUTE_PREFIX)) {
      return;
    }

    if (path === TOKEN_ENDPOINT) {
      const apiKeyHeader = request.headers[API_KEY_HEADER];
      if (typeof apiKeyHeader !== 'string') {
        throw new UnauthorizedError('API key is required');
      }

      const auth = await services.apiKeys.authenticate(apiKeyHeader);
      request.tenantId = auth.tenantId;
      request.apiKeyId = auth.apiKeyId;
      request.apiKeyRole = auth.role;
      return;
    }

    const authorizationHeader = request.headers.authorization;
    if (typeof authorizationHeader !== 'string' || !authorizationHeader.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedError('Bearer token is required');
    }

    const token = authorizationHeader.slice(BEARER_PREFIX.length).trim();
    let previousSigningKeyIndex: number | null = null;
    const auth = verifyAccessToken(token, jwtAuth, {
      onPreviousSigningKeyUsed: (details) => {
        previousSigningKeyIndex = details.previousSigningKeyIndex;
      },
    });

    if (previousSigningKeyIndex !== null) {
      request.log.warn(
        {
          ...buildRequestLogContext(request, resolveRouteLabel(request)),
          apiKeyId: auth.apiKeyId,
          previousSigningKeyIndex,
          tenantId: auth.tenantId,
        },
        'JWT verified with previous signing key',
      );
    }

    await services.apiKeys.assertAccessTokenIsActive(auth);
    request.tenantId = auth.tenantId;
    request.apiKeyId = auth.apiKeyId;
    request.apiKeyRole = auth.role;

    if (path.startsWith('/v1/admin/') && auth.role !== ApiKeyRole.ADMIN) {
      throw new ForbiddenError('Admin API key is required');
    }
  });

  server.addHook('preValidation', async request => {
    if (request.apiPath === '/v1/transactions/bulk') protection.validateBulk(request.body);
  });
  server.addHook('preHandler', async request => {
    const path = request.apiPath ?? '';
    if (path.startsWith(V1_ROUTE_PREFIX) && path !== TOKEN_ENDPOINT && request.tenantId) {
      protection.account(request.tenantId, request.method !== 'GET' && request.method !== 'HEAD');
    }
  });

  server.addHook('onResponse', async (request, reply) => {
    const route = resolveRouteLabel(request);
    const statusCode = reply.statusCode;

    const requestStartedAt = request.requestStartedAt ?? process.hrtime.bigint();
    const elapsedNanoseconds = process.hrtime.bigint() - requestStartedAt;
    const durationSeconds = Number(elapsedNanoseconds) / 1_000_000_000;
    const durationMs = durationSeconds * 1000;

    metrics.observeRequest(route, statusCode, durationSeconds);

    if (statusCode >= 400 && route === TOKEN_ENDPOINT) {
      metrics.incrementTokenIssuanceFailure(statusCode);
    }

    if ((statusCode === 401 || statusCode === 403) && route.startsWith(V1_ROUTE_PREFIX)) {
      metrics.incrementAuthFailure(route, statusCode);
    }

    if (statusCode >= 500) request.log.error({ ...buildRequestLogContext(request, route), statusCode }, 'Request failed');

    request.log.info(
      {
        ...buildRequestLogContext(request, route),
        method: request.method,
        statusCode,
        durationMs,
      },
      'Request completed',
    );
  });

  server.post<{ Headers: AuthTokenRequestHeaders }>(
    TOKEN_ENDPOINT,
    {
      schema: {
        response: {
          200: authTokenResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const accessToken = issueAccessToken(
        {
          apiKeyId: request.apiKeyId as string,
          tenantId: request.tenantId as string,
          role: request.apiKeyRole as ApiKeyRole,
        },
        jwtAuth,
      );

      const response: AuthTokenResponse = {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: jwtAuth.accessTokenTtlSeconds,
      };

      return reply.status(200).send(response);
    },
  );

  registerLedgerAdapter(server, protectReports(services, protection), { authorizeAdjustment });
};
