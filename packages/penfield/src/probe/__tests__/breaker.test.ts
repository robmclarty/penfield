import { describe, expect, test } from 'vitest';

import { admit, CLOSED, fail, succeed } from '../index.js';
import type { Breaker } from '../index.js';

const OPEN_AFTER = 3;
const HALF_OPEN_MS = 30_000;

describe('the breaker', () => {
  test('opens on the third failure in a row, and says so once', () => {
    const first = fail(CLOSED, 1_000, OPEN_AFTER);
    const second = fail(first.breaker, 2_000, OPEN_AFTER);
    const third = fail(second.breaker, 3_000, OPEN_AFTER);
    expect([first.change, second.change, third.change]).toEqual([null, null, 'opened']);
    expect(second.breaker).toEqual({ state: 'closed', failures: 2, opened_at: null });
    expect(third.breaker).toEqual({ state: 'open', failures: 3, opened_at: 3_000 });
  });

  test('a success while closed resets the count without a change', () => {
    const failed = fail(CLOSED, 1_000, OPEN_AFTER).breaker;
    expect(succeed(failed)).toEqual({ breaker: CLOSED, change: null });
  });

  test('an open breaker admits nothing until half_open_ms has passed, then one half-open probe', () => {
    const open: Breaker = { state: 'open', failures: 3, opened_at: 10_000 };
    expect(admit(open, 10_000 + HALF_OPEN_MS - 1, HALF_OPEN_MS)).toBeUndefined();
    expect(admit(open, 10_000 + HALF_OPEN_MS, HALF_OPEN_MS)).toEqual({ ...open, state: 'half_open' });
    expect(admit(CLOSED, 0, HALF_OPEN_MS)).toBe(CLOSED);
  });

  test('one success in half-open closes it', () => {
    const half_open: Breaker = { state: 'half_open', failures: 3, opened_at: 10_000 };
    expect(succeed(half_open)).toEqual({ breaker: CLOSED, change: 'closed' });
  });

  test('a failure in half-open opens it again from now, with no new change', () => {
    const half_open: Breaker = { state: 'half_open', failures: 3, opened_at: 10_000 };
    expect(fail(half_open, 40_000, OPEN_AFTER)).toEqual({
      breaker: { state: 'open', failures: 4, opened_at: 40_000 },
      change: null,
    });
  });

  test('open_after 1 opens on the first failure', () => {
    expect(fail(CLOSED, 5, 1)).toEqual({ breaker: { state: 'open', failures: 1, opened_at: 5 }, change: 'opened' });
  });
});
