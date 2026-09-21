// One bounded token bucket per gateway; no attacker-controlled IP map or proxy-header trust.
// This is a pilot overload guard, not a substitute for host/network DDoS protection.
export class RequestBudget {
  private tokens: number;
  private last: number;
  constructor(
    private burst = 120,
    private perSecond = 10,
    now = Date.now(),
  ) {
    this.tokens = burst;
    this.last = now;
  }
  allow(now = Date.now()) {
    const elapsed = Math.max(0, now - this.last);
    this.last = Math.max(this.last, now);
    this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.perSecond) / 1000);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
