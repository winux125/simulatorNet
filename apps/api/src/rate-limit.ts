import { AuthenticationError } from "./auth-errors";

interface WindowState { count: number; resetsAt: number }

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, WindowState>();

  constructor(
    private readonly maximum: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maximumKeys = 10_000,
  ) {}

  consume(key: string): void {
    const now = this.now();
    const existing = this.windows.get(key);
    if (!existing || existing.resetsAt <= now) {
      if (!existing && this.windows.size >= this.maximumKeys) this.prune(now);
      if (!existing && this.windows.size >= this.maximumKeys) {
        const oldest = this.windows.keys().next().value as string | undefined;
        if (oldest) this.windows.delete(oldest);
      }
      this.windows.set(key, { count: 1, resetsAt: now + this.windowMs });
      return;
    }
    existing.count += 1;
    if (existing.count > this.maximum) {
      throw new AuthenticationError("RATE_LIMIT_EXCEEDED", "Request rate limit exceeded", 429);
    }
  }

  private prune(now: number): void {
    for (const [key, state] of this.windows) {
      if (state.resetsAt <= now) this.windows.delete(key);
    }
  }
}
