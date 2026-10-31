import type { BreakerState } from '../catalogue/index.js';

// Spec §6's circuit breaker, as pure functions over plain data. Consecutive
// failures open it; once `half_open_ms` has passed it lets one probe through
// (half-open), and one success closes it. A node has one, and so does each model.

export type Breaker = { state: BreakerState; failures: number; opened_at: number | null };

export const CLOSED: Breaker = { state: 'closed', failures: 0, opened_at: null };

// The transitions that are incidents: `opened` is `breaker_open`, `closed` is `recovered`.
type Change = 'opened' | 'closed' | null;

export type Step = { breaker: Breaker; change: Change };

export const succeed = (breaker: Breaker): Step => ({
  breaker: CLOSED,
  change: breaker.state === 'closed' ? null : 'closed',
});

// A failed half-open probe opens it again, to wait another `half_open_ms`.
export const fail = (breaker: Breaker, now: number, open_after: number): Step => {
  const failures = breaker.failures + 1;
  if (breaker.state !== 'closed') return { breaker: { state: 'open', failures, opened_at: now }, change: null };
  return failures >= open_after
    ? { breaker: { state: 'open', failures, opened_at: now }, change: 'opened' }
    : { breaker: { ...breaker, failures }, change: null };
};

// The breaker to probe with now, or undefined while an open one is still waiting.
export const admit = (breaker: Breaker, now: number, half_open_ms: number): Breaker | undefined => {
  if (breaker.state !== 'open') return breaker;
  const waited = now - (breaker.opened_at ?? now);
  return waited >= half_open_ms ? { ...breaker, state: 'half_open' } : undefined;
};
