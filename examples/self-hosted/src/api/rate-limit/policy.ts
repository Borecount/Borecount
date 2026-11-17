/**
 * Parses the example's configurable resource budgets and safe defaults.
 * Validates rate windows/counts, limiter storage, body/bulk sizes and report
 * concurrency, returning one consistent policy for HTTP setup and HostProtection.
 */
import { parseIntegerWithinRange } from '../../utils/parse-integer-with-range';
export interface EndpointRateLimitConfig { maxRequests: number; windowSeconds: number; }
export interface RateLimitConfig {
  authToken: EndpointRateLimitConfig;
  write: EndpointRateLimitConfig;
  read: EndpointRateLimitConfig;
  abuse: EndpointRateLimitConfig;
  maxKeys: number;
  bodyBytes: number;
  bulkItems: number;
  reportConcurrency: number;
  tenantReportConcurrency: number;
}
const integer = (env: NodeJS.ProcessEnv, name: string, defaultValue: number, max: number) =>
  parseIntegerWithinRange(env[name], { defaultValue, min: 1, max, errorMessage: `${name} must be an integer in 1..${max}` });
export const parseRateLimitConfig = (env: NodeJS.ProcessEnv): RateLimitConfig => {
  const policy = (name: string, requests: number, seconds = 60): EndpointRateLimitConfig => ({
    maxRequests: integer(env, `RATE_LIMIT_${name}_MAX_REQUESTS`, requests, 1_000_000),
    windowSeconds: integer(env, `RATE_LIMIT_${name}_WINDOW_SECONDS`, seconds, 86_400),
  });
  const config = {
    authToken: policy('AUTH_TOKEN', 20), write: policy('WRITE', 120), read: policy('READ', 600),
    abuse: policy('ABUSE', 1200),
    maxKeys: integer(env, 'RATE_LIMIT_MAX_KEYS', 10_000, 100_000),
    bodyBytes: integer(env, 'REQUEST_BODY_MAX_BYTES', 1_048_576, 1_048_576),
    bulkItems: integer(env, 'REQUEST_BULK_MAX_ITEMS', 100, 100),
    reportConcurrency: integer(env, 'REPORT_CONCURRENCY_MAX', 4, 1000),
    tenantReportConcurrency: integer(env, 'REPORT_TENANT_CONCURRENCY_MAX', 2, 1000),
  };
  if (config.tenantReportConcurrency > config.reportConcurrency) {
    throw new Error('REPORT_TENANT_CONCURRENCY_MAX must not exceed REPORT_CONCURRENCY_MAX');
  }
  return config;
};
