/**
 * Token bucket rate limiter for the public API gateway (sample change for
 * the review E2E; not wired into any entrypoint).
 */
export class TokenBucket {
  private tokens: number
  private lastRefill: number

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    now = Date.now(),
  ) {
    this.tokens = capacity
    this.lastRefill = now
  }

  refill(now: number): void {
    const elapsed = now - this.lastRefill
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond)
    this.lastRefill = now
  }

  /** Returns true when a request is admitted and consumes one token. */
  tryAdmit(now: number): boolean {
    if (now < this.lastRefill) return false
    this.refill(now)
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}
