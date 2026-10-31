// The time every timed part of the service reads (D34): the prober now, the leases
// and the proxy later. Each takes a `Clock` as an argument, so a test runs them on
// a fake one and waits for nothing.

export type Clock = {
  // Milliseconds since the epoch.
  now: () => number;
  // Runs `run` once, `ms` from now; the returned function cancels it.
  after: (ms: number, run: () => void) => () => void;
};

