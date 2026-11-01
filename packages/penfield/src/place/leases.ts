import { randomUUID } from 'node:crypto';

import type { Clock } from '../clock.js';
import type { Db, Row } from '../log/index.js';

// The lease table (D13): every forwarded request holds a lease on its node and
// model from dispatch to the last byte, and the rows live in penfield.db's
// `leases` (C8). Acquiring is one conditional insert, so the slot count is checked
// and taken in one statement. `release` is the only way a lease stops being
// active (spec §6), and it hands the freed slot to the head of that model's
// waiting line: Stage A's `wait` is one in-memory FIFO per node and model, with no
// fairness across callers (D15).

// What a lease ends with. `orphaned` is the boot sweep's and the reaper's.
export type Outcome = 'ok' | 'stalled' | 'deadline' | 'client_gone' | 'upstream_error' | 'orphaned';

export type LeaseState = 'active' | 'released' | 'stalled' | 'orphaned';

export type Lease = {
  id: string;
  request_id: string;
  decision_id: string;
  caller: string;
  node: string;
  model: string;
  // The boot that took it; an active lease from another boot is an orphan.
  instance: string;
  started_at: string;
  last_byte_at: string | null;
  deadline_at: string;
  state: LeaseState;
};

// What a lease is taken for: the decision's target, its model's slot count from
// the catalogue, and the profile's `deadline_ms`.
export type Claim = {
  request_id: string;
  decision_id: string;
  caller: string;
  node: string;
  model: string;
  slots: number;
  deadline_ms: number;
};

export type Waited = { ok: true; lease: Lease; waited_ms: number } | { ok: false; waited_ms: number; reason: string };

// Active leases per model ref (`node/model`): what placement reads.
export type InUse = Readonly<Record<string, number>>;

export type Leases = {
  // A lease if a slot is free now, else null.
  acquire: (claim: Claim) => Lease | null;
  // A lease now, or the first slot released within `wait_ms`, in arrival order;
  // a refusal once `wait_ms` passes or `signal` aborts.
  wait: (claim: Claim, wait_ms: number, signal?: AbortSignal) => Promise<Waited>;
  // True the first time; a lease already released stays as it ended.
  release: (id: string, outcome: Outcome) => boolean;
  in_use: () => InUse;
  active: () => Lease[];
};

const STATE_OF: Record<Outcome, LeaseState> = {
  ok: 'released',
  deadline: 'released',
  client_gone: 'released',
  upstream_error: 'released',
  stalled: 'stalled',
  orphaned: 'orphaned',
};

const INSERT = `insert into leases
  (id, request_id, decision_id, caller, node, model, instance, started_at, last_byte_at, deadline_at, state)
select :id, :request_id, :decision_id, :caller, :node, :model, :instance, :started_at, null, :deadline_at, 'active'
where (select count(*) from leases where node = :node and model = :model and state = 'active') < :slots`;

const RELEASE = `update leases set state = :state where id = :id and state = 'active'`;

const SELECT = `select id, request_id, decision_id, caller, node, model, instance,
  started_at, last_byte_at, deadline_at, state from leases`;

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`leases.${key} is not text`);
  return value;
};

const LEASE_STATES: readonly string[] = ['active', 'released', 'stalled', 'orphaned'] satisfies LeaseState[];

const is_state = (value: string): value is LeaseState => LEASE_STATES.includes(value);

const to_lease = (row: Row): Lease => {
  const state = text(row, 'state');
  if (!is_state(state)) throw new Error(`leases.state "${state}" is not a lease state`);
  const last_byte_at = row['last_byte_at'];
  return {
    id: text(row, 'id'),
    request_id: text(row, 'request_id'),
    decision_id: text(row, 'decision_id'),
    caller: text(row, 'caller'),
    node: text(row, 'node'),
    model: text(row, 'model'),
    instance: text(row, 'instance'),
    started_at: text(row, 'started_at'),
    last_byte_at: typeof last_byte_at === 'string' ? last_byte_at : null,
    deadline_at: text(row, 'deadline_at'),
    state,
  };
};

type Waiter = { claim: Claim; since: number; settle: (waited: Waited) => void };

const ref_of = ({ node, model }: { node: string; model: string }): string => `${node}/${model}`;

const iso = (ms: number): string => new Date(ms).toISOString();

const NOTHING = (): void => undefined;

export const create_leases = ({ db, clock }: { db: Db; clock: Clock }): Leases => {
  const lines = new Map<string, Waiter[]>();

  const acquire = (claim: Claim): Lease | null => {
    const now = clock.now();
    const lease: Lease = {
      id: randomUUID(),
      request_id: claim.request_id,
      decision_id: claim.decision_id,
      caller: claim.caller,
      node: claim.node,
      model: claim.model,
      instance: db.instance_id,
      started_at: iso(now),
      last_byte_at: null,
      deadline_at: iso(now + claim.deadline_ms),
      state: 'active',
    };
    const { last_byte_at: _never, state: _active, ...row } = lease;
    return db.run(INSERT, { ...row, slots: claim.slots }).changes === 1 ? lease : null;
  };

  const leave = (ref: string, waiter: Waiter): void => {
    const line = (lines.get(ref) ?? []).filter((each) => each !== waiter);
    if (line.length === 0) lines.delete(ref);
    else lines.set(ref, line);
  };

  // The freed slot goes to the head of the line, and on down while slots last.
  const hand_off = (ref: string): void => {
    const line = lines.get(ref) ?? [];
    for (let head = line[0]; head !== undefined; head = line[0]) {
      const lease = acquire(head.claim);
      if (lease === null) return;
      line.shift();
      if (line.length === 0) lines.delete(ref);
      head.settle({ ok: true, lease, waited_ms: clock.now() - head.since });
    }
  };

  const wait = (claim: Claim, wait_ms: number, signal?: AbortSignal): Promise<Waited> => {
    const ref = ref_of(claim);
    // Behind someone already waiting, a free slot is theirs, not this claim's.
    const now = lines.has(ref) ? null : acquire(claim);
    if (now !== null) return Promise.resolve({ ok: true, lease: now, waited_ms: 0 });
    if (signal?.aborted === true) return Promise.resolve({ ok: false, waited_ms: 0, reason: 'the client went away' });
    return new Promise((resolve) => {
      const since = clock.now();
      let cancel = NOTHING;
      const on_abort = (): void => {
        leave(ref, waiter);
        waiter.settle({ ok: false, waited_ms: clock.now() - since, reason: 'the client went away while it waited' });
      };
      const waiter: Waiter = {
        claim,
        since,
        settle: (waited) => {
          cancel();
          signal?.removeEventListener('abort', on_abort);
          resolve(waited);
        },
      };
      lines.set(ref, [...(lines.get(ref) ?? []), waiter]);
      cancel = clock.after(wait_ms, () => {
        leave(ref, waiter);
        waiter.settle({ ok: false, waited_ms: wait_ms, reason: `no slot on ${ref} came free within ${wait_ms} ms` });
      });
      signal?.addEventListener('abort', on_abort, { once: true });
    });
  };

  const release = (id: string, outcome: Outcome): boolean => {
    if (db.run(RELEASE, { id, state: STATE_OF[outcome] }).changes !== 1) return false;
    const row = db.get(`${SELECT} where id = :id`, { id });
    if (row !== undefined) hand_off(ref_of(to_lease(row)));
    return true;
  };

  return {
    acquire: (claim) => (lines.has(ref_of(claim)) ? null : acquire(claim)),
    wait,
    release,
    in_use: () =>
      Object.fromEntries(
        db
          .all(`select node, model, count(*) as held from leases where state = 'active' group by node, model`)
          .map((row) => [ref_of({ node: text(row, 'node'), model: text(row, 'model') }), Number(row['held'])]),
      ),
    active: () => db.all(`${SELECT} where state = 'active' order by started_at, id`).map(to_lease),
  };
};
