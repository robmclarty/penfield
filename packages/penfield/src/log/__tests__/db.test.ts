import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { DB_FILE, open_db } from '../index.js';
import type { Db } from '../index.js';

let dir = '';
let opened: Db[] = [];

const open = (state_dir = dir): Db => {
  const db = open_db(state_dir);
  opened.push(db);
  return db;
};

const columns = (db: Db, table: string): unknown[] =>
  db.all('select name from pragma_table_info(:table)', { table }).map((row) => row['name']);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'penfield-db-'));
  opened = [];
});

afterEach(() => {
  for (const db of opened) db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a second open sees the first one's rows and mints its own instance id", () => {
  const first = open();
  const insert = 'insert into incidents (id, at, node, model, kind, detail) values (:id, :at, :node, :model, :kind, :detail)';
  const row = { id: 'inc-1', at: '2026-10-31T10:00:00.000Z', node: 'searle', model: null, kind: 'probe_fail', detail: 'timeout' };
  expect(first.run(insert, row)).toEqual({ changes: 1 });
  first.close();
  opened = [];

  const second = open();
  expect(second.all('select * from incidents')).toEqual([row]);
  expect(second.instance_id).not.toBe(first.instance_id);
  expect(second.instance_id).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
});

test('the journal is WAL', () => {
  expect(open().get('pragma journal_mode')).toEqual({ journal_mode: 'wal' });
});

test("the tables carry spec §5.5's columns, with D31's and D43's on decisions", () => {
  const db = open();
  expect(columns(db, 'decisions')).toEqual([
    'id', 'request_id', 'at', 'caller', 'profile', 'rung',
    'confidence', 'target_kind', 'target_node', 'target_model', 'effort',
    'alternatives', 'reasons',
    'resident', 'cold_load', 'waited_ms', 'degraded_from',
    'outcome',
    'first_byte_ms', 'total_ms', 'bytes_out', 'upstream_status',
    'prompt', 'input', 'upstream_prompt_tokens',
    'policy',
  ]);
  expect(columns(db, 'leases')).toEqual([
    'id', 'request_id', 'decision_id', 'caller', 'node', 'model',
    'instance', 'started_at', 'last_byte_at', 'deadline_at', 'state',
  ]);
  expect(columns(db, 'incidents')).toEqual(['id', 'at', 'node', 'model', 'kind', 'detail']);
  expect(db.get('pragma user_version')).toEqual({ user_version: 2 });
});

test("a file from user_version 1 gains D43's policy column and keeps its rows", () => {
  const file = join(dir, DB_FILE);
  const old = new DatabaseSync(file);
  old.exec(`create table decisions (id text primary key, at text, caller text);
insert into decisions (id, at, caller) values ('dec-0', '2026-10-31T10:00:00.000Z', 'rob');
pragma user_version = 1;`);
  old.close();
  const db = open();
  expect(columns(db, 'decisions').at(-1)).toBe('policy');
  expect(db.all('select id, policy from decisions')).toEqual([{ id: 'dec-0', policy: null }]);
  expect(db.get('pragma user_version')).toEqual({ user_version: 2 });
  db.close();
  opened = [];
  // A second open finds nothing left to migrate.
  expect(open().get('pragma user_version')).toEqual({ user_version: 2 });
});

test('a state dir that does not exist yet is created', () => {
  const state_dir = join(dir, 'var', 'lib', 'penfield');
  const db = open(state_dir);
  expect(db.file).toBe(join(state_dir, DB_FILE));
  expect(existsSync(db.file)).toBe(true);
});

test('get finds nothing as undefined, and run counts the rows it changed', () => {
  const db = open();
  expect(db.get('select id from leases where id = :id', { id: 'nope' })).toBeUndefined();
  expect(db.run("update leases set state = 'released' where state = 'active'")).toEqual({ changes: 0 });
});
