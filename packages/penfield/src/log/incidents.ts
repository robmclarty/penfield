import { randomUUID } from 'node:crypto';

import type { Db } from './db.js';

// `log.incident`: one append-only row for every step of spec §6, so the UI can
// show what went wrong and what was done about it.

export type IncidentKind =
  | 'stall'
  | 'deadline'
  | 'probe_fail'
  | 'breaker_open'
  | 'recovered'
  | 'candidate_missing'
  | 'orphaned';

export type Incident = {
  // ISO, from the caller's clock (D34).
  at: string;
  node: string | null;
  model: string | null;
  kind: IncidentKind;
  detail: string;
};

const INSERT = `insert into incidents (id, at, node, model, kind, detail)
values (:id, :at, :node, :model, :kind, :detail)`;

export const log_incident = (db: Db, incident: Incident): string => {
  const id = randomUUID();
  db.run(INSERT, { id, ...incident });
  return id;
};
