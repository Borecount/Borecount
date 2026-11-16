/**
 * Applies the host's request budgets and reporting concurrency policy.
 * Coordinates pre-authentication IP limits, authenticated tenant read/write limits
 * and bulk validation. Wraps awaited reporting services so permits remain held until
 * database work completes, including error paths.
 */
import { RateLimitExceededError } from '@borecount/core/errors';
import { FixedWindowLimiter } from '../rate-limit/fixed-window-limiter';
import { parseRateLimitConfig, type RateLimitConfig, type EndpointRateLimitConfig } from '../rate-limit/policy';
import { HostInputError } from '../errors/host-input-error';

export class HostProtection {
  private readonly abuse: FixedWindowLimiter;
  private readonly auth: FixedWindowLimiter;
  private readonly tenants: FixedWindowLimiter;
  private readonly reports = new Map<string, number>();
  private activeReports = 0;

  constructor(readonly config = parseRateLimitConfig({}), limiter?: FixedWindowLimiter, clock = Date.now) {
    this.tenants = limiter ?? new FixedWindowLimiter(config.maxKeys, clock);
    this.abuse = new FixedWindowLimiter(config.maxKeys, clock);
    this.auth = new FixedWindowLimiter(config.maxKeys, clock);
  }
  private consume(limiter: FixedWindowLimiter, key: string, policy: EndpointRateLimitConfig) {
    const decision = limiter.consume(key, policy);
    if (!decision.allowed) throw new RateLimitExceededError(decision.retryAfterSeconds);
  }
  beforeAuth(ip: string) { this.consume(this.abuse, ip, this.config.abuse); }
  tokenAttempt(ip: string) { this.consume(this.auth, ip, this.config.authToken); }
  account(tenantId: string, write: boolean) {
    this.consume(this.tenants, `${write ? 'write' : 'read'}:${tenantId}`, write ? this.config.write : this.config.read);
  }
  validateBulk(input: unknown) {
    if (typeof input !== 'object' || input === null) return;
    const transactions = (input as { transactions?: unknown }).transactions;
    if (Array.isArray(transactions) && transactions.length > this.config.bulkItems) {
      throw new HostInputError('Bulk transaction count exceeds the host limit');
    }
  }
  acquireReport(tenantId: string): () => void {
    const count = this.reports.get(tenantId) ?? 0;
    if (count >= this.config.tenantReportConcurrency || this.activeReports >= this.config.reportConcurrency) {
      // No queue: retry delay is a backoff hint, not an estimate of query completion.
      throw new RateLimitExceededError(1);
    }
    this.reports.set(tenantId, count + 1);
    this.activeReports++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeReports--;
      const remaining = this.reports.get(tenantId)! - 1;
      if (remaining === 0) this.reports.delete(tenantId);
      else this.reports.set(tenantId, remaining);
    };
  }
}

/** Wrap the actual awaited service work so disconnects cannot free a running query's permit. */
export function protectReports<T extends import('@borecount/core/application').ApplicationServices>(services: T, protection: HostProtection): T {
  const guard = <S extends object>(service: S, methods: string[]): S => !service ? service : new Proxy(service, {
    get(target, key) {
      const method = Reflect.get(target, key);
      if (typeof method !== 'function') return method;
      if (!methods.includes(String(key))) return method.bind(target);
      return async (...args: unknown[]) => {
        const tenantId = (args[0] as { tenantId: string }).tenantId;
        const release = protection.acquireReport(tenantId);
        try { return await method.apply(target, args); }
        finally { release(); }
      };
    },
  });
  return Object.assign(Object.create(services), {
    balances: guard(services.balances, ['getAt', 'listHistory', 'getTrialBalance']),
    statements: guard(services.statements, ['getAccountStatement', 'getCreditLotStatement']),
  });
}
