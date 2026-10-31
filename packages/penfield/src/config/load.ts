import { readFile } from 'node:fs/promises';

import { isMap, isScalar, isSeq, LineCounter, parseDocument, stringify } from 'yaml';
import type { Document } from 'yaml';
import type { z } from 'zod';

import { check_references, config_schema } from './schema.js';
import type { Config, ReferenceIssue } from './schema.js';

// Reads penfield.yaml once (D40): `yaml` parses it with a line counter, zod checks
// the shape, `check_references` the static facts across sections (D41), and every
// issue is mapped from its path back to a line and column an editor can jump to.

type Path = (string | number)[];

export type ConfigIssue = { path: Path; message: string; line?: number; col?: number };

export type LoadResult = { ok: true; config: Config } | { ok: false; issues: ConfigIssue[] };

type Located = { path: Path; message: string; at_key?: true };

const start_of = (node: unknown): number | undefined =>
  isScalar(node) || isMap(node) || isSeq(node) ? node.range?.[0] : undefined;

// Walks the YAML tree along `path`. An existing scalar reports itself; a map or a
// list reports the key that names it; a missing key reports its parent's key.
const offset_of = (doc: Document, path: Path, at_key: boolean): number => {
  let node: unknown = doc.contents;
  let offset = start_of(node) ?? 0;
  for (const [index, segment] of path.entries()) {
    const last = index === path.length - 1;
    if (isMap(node)) {
      const pair = node.items.find((item) => isScalar(item.key) && String(item.key.value) === String(segment));
      if (pair === undefined) return offset;
      const key_at = start_of(pair.key) ?? offset;
      if (last) return at_key || !isScalar(pair.value) ? key_at : (start_of(pair.value) ?? key_at);
      offset = key_at;
      node = pair.value;
    } else if (isSeq(node) && typeof segment === 'number') {
      const item: unknown = node.items[segment];
      if (item === undefined) return offset;
      offset = start_of(item) ?? offset;
      node = item;
    } else {
      return offset;
    }
  }
  return offset;
};

const from_zod = (issue: z.core.$ZodIssue): Located[] => {
  const path = issue.path.map((segment) => (typeof segment === 'number' ? segment : String(segment)));
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => ({ path: [...path, key], message: `unknown key "${key}"`, at_key: true }));
  }
  if (issue.code === 'invalid_key') {
    const key = String(path.at(-1));
    return [{ path, message: `invalid key "${key}": ${issue.issues[0]?.message ?? issue.message}`, at_key: true }];
  }
  const absent = issue.code === 'invalid_type' || issue.code === 'invalid_value';
  if (absent && issue.input === undefined && path.length > 0) {
    return [{ path, message: `missing key "${String(path.at(-1))}"` }];
  }
  return [{ path, message: issue.message }];
};

const by_position = (a: ConfigIssue, b: ConfigIssue): number =>
  (a.line ?? 0) - (b.line ?? 0) || (a.col ?? 0) - (b.col ?? 0);

const locate = (doc: Document, counter: LineCounter, issues: readonly (Located | ReferenceIssue)[]): ConfigIssue[] =>
  issues
    .map(({ path, message, at_key }) => ({
      path,
      message,
      ...counter.linePos(offset_of(doc, path, at_key === true)),
    }))
    .toSorted(by_position);

export const load_config = (text: string): LoadResult => {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter, prettyErrors: false });
  if (doc.errors.length > 0) {
    const issues = doc.errors.map((error) => ({
      path: [],
      message: `yaml: ${error.message}`,
      ...counter.linePos(error.pos[0]),
    }));
    return { ok: false, issues };
  }
  const parsed = config_schema.safeParse(doc.toJS(), { reportInput: true });
  if (!parsed.success) return { ok: false, issues: locate(doc, counter, parsed.error.issues.flatMap(from_zod)) };
  const references = check_references(parsed.data);
  if (references.length > 0) return { ok: false, issues: locate(doc, counter, references) };
  return { ok: true, config: parsed.data };
};

export const read_config = async (file: string): Promise<LoadResult> => {
  try {
    return load_config(await readFile(file, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, issues: [{ path: [], message: `cannot read the config: ${reason}` }] };
  }
};

const format_path = (path: Path): string =>
  path
    .map((segment, index) => {
      if (typeof segment === 'number') return `[${segment}]`;
      if (!/^[a-z_][\w-]*$/i.test(segment)) return `[${JSON.stringify(segment)}]`;
      return index === 0 ? segment : `.${segment}`;
    })
    .join('');

// `penfield.yaml:42:7 aliases.auto.ladder: <message>`, one line per issue.
export const format_issues = (file: string, issues: readonly ConfigIssue[]): string =>
  issues
    .map(({ path, message, line, col }) => {
      const where = line === undefined ? file : `${file}:${line}:${col ?? 1}`;
      return path.length === 0 ? `${where} ${message}\n` : `${where} ${format_path(path)}: ${message}\n`;
    })
    .join('');

export type CheckResult = { code: 0 | 1; out: string; err: string };

// `penfield check-config`: the merged config with every default applied, or every issue.
export const check_config = async (file: string): Promise<CheckResult> => {
  const result = await read_config(file);
  if (!result.ok) return { code: 1, out: '', err: format_issues(file, result.issues) };
  return { code: 0, out: stringify(result.config, { lineWidth: 0 }), err: '' };
};
