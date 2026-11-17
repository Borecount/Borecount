/**
 * Provides bounded, process-local fixed-window accounting.
 * Tracks request budgets with an injectable clock, reclaims expired identities and
 * rejects new identities at capacity while retaining active budgets. HostProtection
 * uses independent instances for abuse, authentication and tenant traffic.
 */
import type { EndpointRateLimitConfig } from './policy';

interface FixedWindowBucket {
  expiresAtMs: number;
  count: number;
}
export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/** Process-local, bounded storage. Active buckets are never evicted to admit new keys. */
export class FixedWindowLimiter {
  private readonly buckets = new Map<string, FixedWindowBucket>();
  private nextSweepMs = 0;
  private earliestExpiryMs = Infinity;

  constructor(private readonly maxKeys = 10_000, private readonly clock = Date.now) {
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new Error('Invalid limiter capacity');
  }

  get size(): number { return this.buckets.size; }

  public consume(key: string, policy: EndpointRateLimitConfig, nowMs = this.clock()): RateLimitDecision {
    if (!Number.isSafeInteger(policy.maxRequests) || policy.maxRequests < 1 ||
        !Number.isSafeInteger(policy.windowSeconds) || policy.windowSeconds < 1 ||
        policy.windowSeconds > 86_400) throw new Error('Invalid rate limit policy');
    // Keys are host-generated IP/UUID contexts, never credentials or resource IDs.
    if (key.length > 256) return { allowed: false, retryAfterSeconds: 1 };
    if (nowMs >= this.nextSweepMs) {
      this.earliestExpiryMs = Infinity;
      for (const [storedKey, bucket] of this.buckets) {
        if (nowMs >= bucket.expiresAtMs) this.buckets.delete(storedKey);
        else this.earliestExpiryMs = Math.min(this.earliestExpiryMs, bucket.expiresAtMs);
      }
      this.nextSweepMs = nowMs + 1000;
    }
    let bucket = this.buckets.get(key);
    if (bucket && nowMs >= bucket.expiresAtMs) {
      this.buckets.delete(key);
      bucket = undefined;
    }
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((Math.max(this.earliestExpiryMs, this.nextSweepMs) - nowMs) / 1000)) };
      }
      bucket = { expiresAtMs: nowMs + policy.windowSeconds * 1000, count: 0 };
      this.buckets.set(key, bucket);
      this.earliestExpiryMs = Math.min(this.earliestExpiryMs, bucket.expiresAtMs);
    }
    if (bucket.count >= policy.maxRequests) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.expiresAtMs - nowMs) / 1000)) };
    }
    bucket.count++;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
