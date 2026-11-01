import type { Clock } from '../clock.js';
import type { Incident } from '../log/index.js';
import type { Lease, Leases } from './leases.js';

// Orphaned leases (spec §6). On boot, every active lease another instance took is
// an orphan: its request died with that process, so there is nothing to abort.
// On each tick, an active lease `REAPER_GRACE_MS` past its `deadline_at` is one
// whose holder died, since the proxy's own timer ends it at the deadline itself
// (D47). Both mark the lease `orphaned` through `release`, the one release path,
// so a freed slot goes to whoever waits for it, and both write an `orphaned`
// incident.

// D47: long enough that a tick landing on `deadline_at` leaves the lease to the
// proxy, which releases it as `deadline` and writes no incident.
const REAPER_GRACE_MS = 30_000;

export type ReaperDeps = {
  leases: Leases;
  clock: Clock;
  // This boot's, from `open_db`.
  instance_id: string;
  // `log.incident`, bound to the db by the caller.
  incident: (incident: Incident) => void;
};

const orphan = (deps: ReaperDeps, lease: Lease, why: string): boolean => {
  if (!deps.leases.release(lease.id, 'orphaned')) return false;
  deps.incident({
    at: new Date(deps.clock.now()).toISOString(),
    node: lease.node,
    model: lease.model,
    kind: 'orphaned',
    detail: `lease ${lease.id} for ${lease.caller} (request ${lease.request_id}) ${why}; released`,
  });
  return true;
};

// How many it released.
const orphan_all = (deps: ReaperDeps, leases: readonly Lease[], why: (lease: Lease) => string): number => {
  let released = 0;
  for (const lease of leases) if (orphan(deps, lease, why(lease))) released += 1;
  return released;
};

// The leases it released.
export const sweep_orphans = (deps: ReaperDeps): number =>
  orphan_all(
    deps,
    deps.leases.active().filter(({ instance }) => instance !== deps.instance_id),
    (lease) => `was active under instance ${lease.instance}, not this boot`,
  );

export type Reaper = {
  // The leases it released.
  tick: () => number;
  start: () => void;
  stop: () => void;
};

export const create_reaper = (deps: ReaperDeps & { every_ms: number }): Reaper => {
  const tick = (): number => {
    const now = deps.clock.now();
    return orphan_all(
      deps,
      deps.leases.active().filter(({ deadline_at }) => Date.parse(deadline_at) + REAPER_GRACE_MS < now),
      (lease) => `was still active ${REAPER_GRACE_MS / 1000} s past its deadline_at ${lease.deadline_at}`,
    );
  };
  let cancel: (() => void) | null = null;
  const loop = (): void => {
    cancel = deps.clock.after(deps.every_ms, () => {
      tick();
      loop();
    });
  };
  return {
    tick,
    start: () => {
      if (cancel === null) loop();
    },
    stop: () => {
      cancel?.();
      cancel = null;
    },
  };
};
