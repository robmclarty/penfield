import type { Clock } from '../../src/clock.js';

// A clock that moves only when a test says so (D34). `advance` runs every timer
// that falls due on the way, in order, each at its own time.

export type FakeClock = Clock & {
  advance: (ms: number) => void;
  // Timers still waiting.
  pending: () => number;
};

type Timer = { due: number; run: () => void };

export const fake_clock = (start = Date.parse('2026-10-31T12:00:00.000Z')): FakeClock => {
  let now = start;
  let timers: Timer[] = [];
  const next_due = (until: number): Timer | undefined =>
    timers.filter(({ due }) => due <= until).toSorted((a, b) => a.due - b.due)[0];
  return {
    now: () => now,
    after: (ms, run) => {
      const timer = { due: now + ms, run };
      timers.push(timer);
      return () => {
        timers = timers.filter((each) => each !== timer);
      };
    },
    advance: (ms) => {
      const until = now + ms;
      for (let timer = next_due(until); timer !== undefined; timer = next_due(until)) {
        const ran = timer;
        timers = timers.filter((each) => each !== ran);
        now = ran.due;
        ran.run();
      }
      now = until;
    },
    pending: () => timers.length,
  };
};
