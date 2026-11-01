import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { fake_clock } from '../../../test/helpers/fake_clock.js';
import type { FakeClock } from '../../../test/helpers/fake_clock.js';
import { log_incident, open_db } from '../../log/index.js';
import type { Db, Incident } from '../../log/index.js';
import { create_leases, create_reaper, sweep_orphans } from '../index.js';
import type { Claim, Leases } from '../index.js';

let dir = '';
let opened: Db[] = [];
let clock: FakeClock;

const open = (): Db => {
  const db = open_db(dir);
  opened.push(db);
  return db;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'penfield-leases-'));
  opened = [];
  clock = fake_clock();
});

afterEach(() => {
  for (const db of opened) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const QWEN = 'qwen3.6:35b-mlx';

let requests = 0;

const claim_for = (more: Partial<Claim> = {}): Claim => {
  requests += 1;
  return {
    request_id: `req-${requests}`,
    decision_id: `dec-${requests}`,
    caller: 'rob',
    node: 'searle',
    model: QWEN,
    slots: 2,
    deadline_ms: 600_000,
    ...more,
  };
};

const held = (leases: Leases, claim: Claim) => {
  const lease = leases.acquire(claim);
  if (lease === null) throw new Error(`no slot for ${claim.request_id}`);
  return lease;
};

const states = (db: Db): unknown[] => db.all('select request_id, state from leases order by rowid');

describe('acquire', () => {
  test('two slots, then busy', () => {
    const leases = create_leases({ db: open(), clock });
    expect(leases.acquire(claim_for())).not.toBeNull();
    expect(leases.acquire(claim_for())).not.toBeNull();
    expect(leases.acquire(claim_for())).toBeNull();
    expect(leases.in_use()).toEqual({ [`searle/${QWEN}`]: 2 });
    // Another model on the same node has slots of its own.
    expect(leases.acquire(claim_for({ model: 'gemma4:26b' }))).not.toBeNull();
  });

  test('leases live in SQLite: another open of penfield.db reads them', () => {
    const leases = create_leases({ db: open(), clock });
    const lease = held(leases, claim_for({ deadline_ms: 90_000 }));
    expect(lease).toMatchObject({
      node: 'searle',
      model: QWEN,
      caller: 'rob',
      started_at: '2026-10-31T12:00:00.000Z',
      deadline_at: '2026-10-31T12:01:30.000Z',
      last_byte_at: null,
      state: 'active',
    });
    const other = open();
    expect(other.all('select * from leases')).toEqual([{ ...lease, instance: opened[0]?.instance_id }]);
    expect(create_leases({ db: other, clock }).active()).toEqual([lease]);
  });
});

describe('release', () => {
  test('is idempotent: the first call releases, later ones change nothing', () => {
    const db = open();
    const leases = create_leases({ db, clock });
    const lease = held(leases, claim_for({ slots: 1 }));
    expect(leases.release(lease.id, 'ok')).toBe(true);
    expect(leases.release(lease.id, 'ok')).toBe(false);
    expect(leases.release(lease.id, 'stalled')).toBe(false);
    expect(leases.release('no-such-lease', 'ok')).toBe(false);
    expect(states(db)).toEqual([{ request_id: lease.request_id, state: 'released' }]);
    expect(leases.in_use()).toEqual({});
    expect(leases.acquire(claim_for({ slots: 1 }))).not.toBeNull();
  });

  test('a stall ends the lease as stalled, every other outcome as released', () => {
    const db = open();
    const leases = create_leases({ db, clock });
    const outcomes = ['ok', 'stalled', 'deadline', 'client_gone', 'upstream_error'] as const;
    const ids = outcomes.map((outcome) => ({ outcome, id: held(leases, claim_for({ slots: 9 })).id }));
    for (const { outcome, id } of ids) leases.release(id, outcome);
    expect(db.all('select state from leases order by rowid').map(({ state }) => state)).toEqual([
      'released',
      'stalled',
      'released',
      'released',
      'released',
    ]);
  });

  test('touch stamps an active lease with the last byte, and leaves an ended one as it ended', () => {
    const db = open();
    const leases = create_leases({ db, clock });
    const lease = held(leases, claim_for());
    clock.advance(1_500);
    leases.touch(lease.id);
    expect(leases.active()[0]).toMatchObject({ id: lease.id, last_byte_at: '2026-10-31T12:00:01.500Z' });
    leases.release(lease.id, 'ok');
    clock.advance(1_000);
    leases.touch(lease.id);
    expect(db.get('select last_byte_at from leases where id = :id', { id: lease.id })).toEqual({
      last_byte_at: '2026-10-31T12:00:01.500Z',
    });
  });
});

describe('wait: one FIFO per node and model', () => {
  test('served in arrival order as slots are released, each with how long it waited', async () => {
    const leases = create_leases({ db: open(), clock });
    const first = held(leases, claim_for({ slots: 1 }));
    const b = leases.wait(claim_for({ slots: 1, caller: 'night-shift' }), 5_000);
    const c = leases.wait(claim_for({ slots: 1, caller: 'nurselog' }), 5_000);
    // Behind a line, even a claim that could fit is not served first.
    expect(leases.acquire(claim_for({ slots: 2 }))).toBeNull();
    clock.advance(1_500);
    leases.release(first.id, 'ok');
    const served_b = await b;
    expect(served_b).toMatchObject({ ok: true, waited_ms: 1_500, lease: { caller: 'night-shift', state: 'active' } });
    clock.advance(500);
    if (!served_b.ok) throw new Error('b was not served');
    leases.release(served_b.lease.id, 'ok');
    expect(await c).toMatchObject({ ok: true, waited_ms: 2_000, lease: { caller: 'nurselog' } });
    expect(clock.pending()).toBe(0);
  });

  test('a free slot is taken at once, with nothing waited', async () => {
    const leases = create_leases({ db: open(), clock });
    expect(await leases.wait(claim_for(), 5_000)).toMatchObject({ ok: true, waited_ms: 0 });
  });

  test('served under the deadline, refused past it', async () => {
    const leases = create_leases({ db: open(), clock });
    const first = held(leases, claim_for({ slots: 1 }));
    const under = leases.wait(claim_for({ slots: 1 }), 5_000);
    clock.advance(4_999);
    leases.release(first.id, 'ok');
    const served = await under;
    expect(served).toMatchObject({ ok: true, waited_ms: 4_999 });

    const past = leases.wait(claim_for({ slots: 1 }), 5_000);
    clock.advance(5_000);
    expect(await past).toEqual({ ok: false, waited_ms: 5_000, reason: `no slot on searle/${QWEN} came free within 5000 ms` });
    // The refused claim left the line, so the next release frees the slot for anyone.
    if (!served.ok) throw new Error('not served');
    leases.release(served.lease.id, 'ok');
    expect(leases.acquire(claim_for({ slots: 1 }))).not.toBeNull();
  });

  test('a client that goes away leaves the line', async () => {
    const leases = create_leases({ db: open(), clock });
    const first = held(leases, claim_for({ slots: 1 }));
    const gone = new AbortController();
    const waiting = leases.wait(claim_for({ slots: 1 }), 5_000, gone.signal);
    clock.advance(200);
    gone.abort();
    expect(await waiting).toEqual({ ok: false, waited_ms: 200, reason: 'the client went away while it waited' });
    expect(clock.pending()).toBe(0);
    leases.release(first.id, 'ok');
    expect(leases.in_use()).toEqual({});
    const already = new AbortController();
    already.abort();
    held(leases, claim_for({ slots: 1 }));
    expect(await leases.wait(claim_for({ slots: 1 }), 5_000, already.signal)).toMatchObject({ ok: false, waited_ms: 0 });
  });
});

const incidents = (db: Db): unknown[] => db.all('select node, model, kind from incidents order by at, detail');

const reaping = (db: Db, leases: Leases) => ({
  leases,
  clock,
  instance_id: db.instance_id,
  incident: (each: Incident) => void log_incident(db, each),
});

describe('orphans', () => {
  test("the boot sweep releases another instance's active leases as orphaned, and only those", () => {
    const before = open();
    const old = create_leases({ db: before, clock });
    const crashed = [held(old, claim_for()), held(old, claim_for())];
    const finished = held(old, claim_for({ slots: 3 }));
    old.release(finished.id, 'ok');

    const db = open();
    const leases = create_leases({ db, clock });
    const ours = held(leases, claim_for({ slots: 3 }));
    const deps = reaping(db, leases);
    expect(sweep_orphans(deps)).toBe(2);
    expect(db.all('select id, state from leases order by rowid')).toEqual([
      ...crashed.map(({ id }) => ({ id, state: 'orphaned' })),
      { id: finished.id, state: 'released' },
      { id: ours.id, state: 'active' },
    ]);
    expect(incidents(db)).toEqual([
      { node: 'searle', model: QWEN, kind: 'orphaned' },
      { node: 'searle', model: QWEN, kind: 'orphaned' },
    ]);
    expect(sweep_orphans(deps)).toBe(0);
  });

  test('the reaper leaves a lease at its deadline_at to the proxy and takes it 30 s past, the slot going to the line (D47)', async () => {
    const db = open();
    const leases = create_leases({ db, clock });
    // Ticks every 5 s: on the deadline at 15 s, and on 30 s past it at 45 s.
    const reaper = create_reaper({ ...reaping(db, leases), every_ms: 5_000 });
    const hung = held(leases, claim_for({ slots: 1, deadline_ms: 15_000 }));
    const waiting = leases.wait(claim_for({ slots: 1 }), 120_000);
    reaper.start();
    clock.advance(45_000);
    expect(leases.active().map(({ id }) => id)).toEqual([hung.id]);
    expect(incidents(db)).toEqual([]);
    clock.advance(5_000);
    expect(await waiting).toMatchObject({ ok: true, waited_ms: 50_000 });
    expect(db.get('select state from leases where id = :id', { id: hung.id })).toEqual({ state: 'orphaned' });
    expect(db.all('select kind, detail from incidents')).toEqual([
      {
        kind: 'orphaned',
        detail: `lease ${hung.id} for rob (request ${hung.request_id}) was still active 30 s past its deadline_at 2026-10-31T12:00:15.000Z; released`,
      },
    ]);
    expect(reaper.tick()).toBe(0);
    reaper.stop();
    expect(clock.pending()).toBe(0);
  });
});
