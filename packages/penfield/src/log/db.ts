import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';

// penfield.db: the decision log, the lease table and the incidents in one SQLite
// file under the state dir (C8). This is the only module that touches the driver
// (D39): the rest of the service sees `Db`, so a swap of drivers is this one file.

export const DB_FILE = 'penfield.db';

const SETUP = `
pragma journal_mode = wal;
pragma synchronous = normal;
pragma busy_timeout = 5000;

create table if not exists decisions (
  id text primary key, request_id text, at text, caller text, profile text, rung text,
  confidence real, target_kind text, target_node text, target_model text, effort text,
  alternatives text,            -- JSON
  reasons text,                 -- JSON
  resident int, cold_load int, waited_ms int, degraded_from text,
  outcome text,                 -- ok | stalled | deadline | client_gone | upstream_error | refused | hinted
  first_byte_ms int, total_ms int, bytes_out int, upstream_status int,
  prompt text,                  -- JSON of text and system_text, only under the caller's keep_prompts
  input text,                   -- the RouteInput as JSON, without text and system_text (D31)
  upstream_prompt_tokens int    -- the node's own prompt count, beside tokens_estimate (Q4)
);
create index if not exists decisions_at on decisions (at);
create index if not exists decisions_caller_at on decisions (caller, at);

create table if not exists leases (
  id text primary key, request_id text, decision_id text, caller text, node text, model text,
  instance text,                -- the boot's instance id; an active lease from another is an orphan
  started_at text, last_byte_at text, deadline_at text,
  state text                    -- active | released | stalled | orphaned
);
create index if not exists leases_state on leases (state);

create table if not exists incidents (
  id text primary key, at text, node text, model text,
  kind text,                    -- stall | deadline | probe_fail | breaker_open | recovered | candidate_missing
  detail text
);
create index if not exists incidents_at on incidents (at);

pragma user_version = 1;
`;

type SqlValue = string | number | bigint | null;

export type Row = Record<string, SqlValue | Uint8Array>;

type Params = Record<string, SqlValue>;

export type Db = {
  file: string;
  // A fresh id each boot; leases carry it, so the next boot can sweep the last one's.
  instance_id: string;
  run: (statement: string, params?: Params) => { changes: number };
  all: (statement: string, params?: Params) => Row[];
  get: (statement: string, params?: Params) => Row | undefined;
  close: () => void;
};

// Opens penfield.db in `state_dir`, creating both if they are missing.
export const open_db = (state_dir: string): Db => {
  mkdirSync(state_dir, { recursive: true });
  const file = join(state_dir, DB_FILE);
  const sql = new DatabaseSync(file);
  sql.exec(SETUP);
  const statements = new Map<string, StatementSync>();
  const prepared = (text: string): StatementSync => {
    const cached = statements.get(text);
    if (cached !== undefined) return cached;
    const statement = sql.prepare(text);
    statements.set(text, statement);
    return statement;
  };
  return {
    file,
    instance_id: randomUUID(),
    run: (text, params = {}) => ({ changes: Number(prepared(text).run(params).changes) }),
    all: (text, params = {}) => prepared(text).all(params),
    get: (text, params = {}) => prepared(text).get(params),
    close: () => {
      sql.close();
    },
  };
};
