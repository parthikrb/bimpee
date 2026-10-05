export interface Limiter {
  /** Resolves true when the call identified by `key` may proceed. */
  limit(key: string): Promise<boolean>;
}

/** Adapter for the Workers rate-limiting binding (`ratelimits` in wrangler.jsonc). */
export function bindingLimiter(binding: RateLimit): Limiter {
  return {
    async limit(key) {
      try {
        const { success } = await binding.limit({ key });
        return success;
      } catch {
        return true; // fail open: the binding is a cost guard, not auth
      }
    },
  };
}

/**
 * Sliding-window limiter local to one isolate. Best effort only (each isolate
 * has its own counters); used when the binding is absent, e.g. in tests.
 */
export class MemoryLimiter implements Limiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max = 30,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async limit(key: string): Promise<boolean> {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (!v.some((x) => t - x < this.windowMs)) this.hits.delete(k);
    }
    return true;
  }
}
