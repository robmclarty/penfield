import { describe, expect, test } from 'vitest';

import { format_issues, load_config } from '../../config/index.js';
import type { Config } from '../../config/index.js';
import { candidate_models, glob_regex, merge_catalogue, names_model, parse_candidate } from '../index.js';
import type { Breakers, Catalogue, CatalogueModel, Discovery } from '../index.js';

const AT = '2026-10-31T12:00:00.000Z';

const CONFIG = `version: 1
nodes:
  searle:
    kind: ollama
    url: http://searle.test:11434
    privacy: lan
    memory_gb: 48
    max_loaded: 2
    slots: { default: 2, "qwen3.8:27b-mlx": 1, nomic-embed-text: 4 }
    pinned: [qwen3.8:27b-mlx]
  closet:
    kind: openai_compatible
    url: http://closet.test:8080/v1
    privacy: lan
    discover: false
    models: [gemma4:26b, glm-4.7-flash]
  claude:
    kind: claude_decision
    models: [sonnet, opus]
    efforts: [low, high]
models:
  "qwen3*":            { profiles: [chat], speed: fast }
  "qwen3.8:27b*":      { profiles: [reason], quality: high, context: 65536 }
  "glm-4.?-flash":     { profiles: [extract] }
  "nomic-embed-text*": { profiles: [embed] }
  "claude/opus":       { profiles: [code-heavy], quality: frontier, cost: high }
profiles:
  chat:       { candidates: [qwen3.6:35b-mlx, qwen3.8:27b-mlx, claude/sonnet@low] }
  embed:      { candidates: [nomic-embed-text] }
  code-heavy: { candidates: [claude/opus@high, searle/qwen3.8:27b-mlx] }
  summarize:  { candidates: [closet/gemma4:26b] }
  extract:    { candidates: [qwen3:4b-instruct-2507] }
`;

const loaded = (text: string): Config => {
  const result = load_config(text);
  if (!result.ok) throw new Error(format_issues('penfield.yaml', result.issues));
  return result.config;
};

const config = loaded(CONFIG);

const NO_BREAKERS: Breakers = { nodes: {}, models: {} };

const searle_up: Discovery = {
  node: 'searle',
  state: 'up',
  models: [
    { id: 'qwen3.8:27b-mlx', node: 'searle', residency: 'resident', size_bytes: 1, context_length: 65_536 },
    { id: 'qwen3.6:35b-mlx', node: 'searle', residency: 'cold', size_bytes: 2, context_length: null },
    { id: 'nomic-embed-text:latest', node: 'searle', residency: 'cold', size_bytes: 3, context_length: null },
  ],
};

const merged = (searle?: Discovery, breakers: Breakers = NO_BREAKERS): Catalogue =>
  merge_catalogue(config, { seen: searle === undefined ? {} : { searle: { discovery: searle, at: AT } }, breakers });

const model = (catalogue: Catalogue, ref: string): CatalogueModel => {
  const found = catalogue.models.find((each) => each.ref === ref);
  if (found === undefined) throw new Error(`no ${ref} in the catalogue`);
  return found;
};

describe('the overlay', () => {
  test('the first matching key wins, in file order', () => {
    expect(model(merged(searle_up), 'searle/qwen3.8:27b-mlx')).toMatchObject({
      overlay: 'qwen3*',
      profiles: ['chat'],
      speed: 'fast',
      quality: null,
      context: null,
    });
  });

  test('a key matches the node/id as well as the id', () => {
    expect(model(merged(), 'claude/opus')).toMatchObject({
      overlay: 'claude/opus',
      profiles: ['code-heavy'],
      quality: 'frontier',
      cost: 'high',
    });
    expect(model(merged(), 'claude/sonnet')).toMatchObject({ overlay: null, profiles: [] });
  });

  test('`*` is the only wildcard: `?` and `.` are literal', () => {
    expect(model(merged(), 'closet/glm-4.7-flash').overlay).toBeNull();
    expect(glob_regex('glm-4.?-flash').test('glm-4.?-flash')).toBe(true);
    expect(glob_regex('qwen3.8:27b*').test('qwen3x8:27b-mlx')).toBe(false);
    expect(glob_regex('qwen3.8:27b*').test('qwen3.8:27b')).toBe(true);
    expect(glob_regex('*/opus').test('claude/opus')).toBe(true);
    expect(glob_regex('a*b*c').test('a-b-b-c')).toBe(true);
    expect(glob_regex('(x)[y]+').test('(x)[y]+')).toBe(true);
  });
});

describe('nodes and their models', () => {
  test("a discover: false node has its models: list, residency unknown, discovery or not", () => {
    const listed: Discovery = { node: 'closet', state: 'up', models: [] };
    const catalogue = merge_catalogue(config, { seen: { closet: { discovery: listed, at: AT } }, breakers: NO_BREAKERS });
    expect(catalogue.models.filter(({ node }) => node === 'closet')).toEqual([
      expect.objectContaining({ ref: 'closet/gemma4:26b', residency: 'unknown', slots: 1, pinned: false }),
      expect.objectContaining({ ref: 'closet/glm-4.7-flash', residency: 'unknown', slots: 1, pinned: false }),
    ]);
    expect(catalogue.nodes.find(({ name }) => name === 'closet')).toMatchObject({ state: 'up', discovered_at: AT });
  });

  test('a claude_decision node appears as claude/<model> candidates, never leased', () => {
    const catalogue = merged();
    expect(catalogue.models.filter(({ node }) => node === 'claude').map(({ ref }) => ref)).toEqual([
      'claude/sonnet',
      'claude/opus',
    ]);
    expect(candidate_models(catalogue, 'claude/opus@high')).toEqual([model(catalogue, 'claude/opus')]);
    expect(model(catalogue, 'claude/opus')).toMatchObject({ slots: null, pinned: false, residency: 'unknown' });
    expect(catalogue.nodes.find(({ name }) => name === 'claude')).toEqual({
      name: 'claude',
      kind: 'claude_decision',
      privacy: 'cloud',
      url: null,
      formats: [],
      efforts: ['low', 'high'],
      memory_gb: null,
      max_loaded: null,
      enabled: true,
      state: 'up',
      reason: null,
      discovered_at: null,
      breaker: 'closed',
    });
  });

  test("a node's memory_gb and max_loaded reach the snapshot, null where the file leaves them out", () => {
    const sizes = merged(searle_up).nodes.map(({ name, memory_gb, max_loaded }) => [name, memory_gb, max_loaded]);
    expect(sizes).toEqual([
      ['searle', 48, 2],
      ['closet', null, null],
      ['claude', null, null],
    ]);
  });

  test('a pinned model is marked, and nothing else is', () => {
    const refs = merged(searle_up).models.filter(({ pinned }) => pinned).map(({ ref }) => ref);
    expect(refs).toEqual(['searle/qwen3.8:27b-mlx']);
  });

  test("a model's own slot count overrides the node default, `:latest` or not", () => {
    const counts = merged(searle_up)
      .models.filter(({ node }) => node === 'searle')
      .map(({ id, slots }) => [id, slots]);
    expect(counts).toEqual([
      ['qwen3.8:27b-mlx', 1],
      ['qwen3.6:35b-mlx', 2],
      ['nomic-embed-text:latest', 4],
    ]);
  });

  test("residency and the node's context come from discovery, the file's context from the overlay", () => {
    const without_first = loaded(CONFIG.replace('  "qwen3*":            { profiles: [chat], speed: fast }\n', ''));
    const built = merge_catalogue(without_first, { seen: { searle: { discovery: searle_up, at: AT } }, breakers: NO_BREAKERS });
    expect(model(built, 'searle/qwen3.8:27b-mlx')).toMatchObject({
      residency: 'resident',
      context: 65_536,
      context_length: 65_536,
      size_bytes: 1,
      overlay: 'qwen3.8:27b*',
    });
  });

  test('a discovering node is unknown with no models until its first discovery', () => {
    const catalogue = merged();
    expect(catalogue.nodes.find(({ name }) => name === 'searle')).toMatchObject({ state: 'unknown', url: 'http://searle.test:11434' });
    expect(catalogue.models.some(({ node }) => node === 'searle')).toBe(false);
  });

  test('breaker states show on their node and model; the rest are closed', () => {
    const breakers: Breakers = { nodes: { searle: 'open' }, models: { 'searle/qwen3.6:35b-mlx': 'half_open' } };
    const catalogue = merged(searle_up, breakers);
    expect(catalogue.nodes.map(({ name, breaker }) => [name, breaker])).toEqual([
      ['searle', 'open'],
      ['closet', 'closed'],
      ['claude', 'closed'],
    ]);
    expect(model(catalogue, 'searle/qwen3.6:35b-mlx').breaker).toBe('half_open');
    expect(model(catalogue, 'searle/qwen3.8:27b-mlx').breaker).toBe('closed');
  });

  test('the snapshot is plain data', () => {
    const catalogue = merged(searle_up);
    expect(JSON.parse(JSON.stringify(catalogue))).toEqual(catalogue);
    expect(structuredClone(catalogue)).toEqual(catalogue);
  });
});

describe('candidate_missing (D41)', () => {
  test('nothing is missing before a discovering node has been read, where it may yet appear', () => {
    expect(merged().warnings).toEqual([]);
  });

  test('after discovery, a candidate no node has is a warning', () => {
    expect(merged(searle_up).warnings).toEqual([
      {
        kind: 'candidate_missing',
        profile: 'extract',
        candidate: 'qwen3:4b-instruct-2507',
        message: 'no node has "qwen3:4b-instruct-2507"',
      },
    ]);
  });

  test("a down node's candidates are warnings that say why, never a throw", () => {
    const down: Discovery = { node: 'searle', state: 'down', models: [], reason: 'connect ECONNREFUSED' };
    const catalogue = merged(down);
    expect(catalogue.nodes[0]).toMatchObject({ state: 'down', reason: 'connect ECONNREFUSED', discovered_at: AT });
    expect(catalogue.warnings.map(({ profile, candidate, message }) => `${profile} ${candidate}: ${message}`)).toEqual([
      'chat qwen3.6:35b-mlx: no node has "qwen3.6:35b-mlx" (searle is down: connect ECONNREFUSED)',
      'chat qwen3.8:27b-mlx: no node has "qwen3.8:27b-mlx" (searle is down: connect ECONNREFUSED)',
      'embed nomic-embed-text: no node has "nomic-embed-text" (searle is down: connect ECONNREFUSED)',
      'code-heavy searle/qwen3.8:27b-mlx: node "searle" has no model "qwen3.8:27b-mlx" (searle is down: connect ECONNREFUSED)',
      'extract qwen3:4b-instruct-2507: no node has "qwen3:4b-instruct-2507" (searle is down: connect ECONNREFUSED)',
    ]);
  });
});

describe('names and candidates', () => {
  test.each([
    ['claude/opus@high', { node: 'claude', model: 'opus', effort: 'high' }],
    ['qwen3.6:35b-mlx', { node: null, model: 'qwen3.6:35b-mlx', effort: null }],
    ['qwen3@low', { node: null, model: 'qwen3', effort: 'low' }],
    ['openrouter/anthropic/claude-sonnet-5.5', { node: 'openrouter', model: 'anthropic/claude-sonnet-5.5', effort: null }],
  ])('parse_candidate(%s)', (text, expected) => {
    expect(parse_candidate(text)).toEqual(expected);
  });

  test.each([
    ['nomic-embed-text', { node: 'searle', id: 'nomic-embed-text:latest' }, true],
    ['searle/nomic-embed-text', { node: 'searle', id: 'nomic-embed-text:latest' }, true],
    ['nomic-embed-text:latest', { node: 'searle', id: 'nomic-embed-text:latest' }, true],
    ['closet/nomic-embed-text', { node: 'searle', id: 'nomic-embed-text:latest' }, false],
    ['qwen3', { node: 'searle', id: 'qwen3:4b' }, false],
    ['anthropic/claude-sonnet-5.5', { node: 'openrouter', id: 'anthropic/claude-sonnet-5.5' }, false],
    ['openrouter/anthropic/claude-sonnet-5.5', { node: 'openrouter', id: 'anthropic/claude-sonnet-5.5' }, true],
  ])('names_model(%s) of %o is %s', (wanted, of, expected) => {
    expect(names_model(wanted, of)).toBe(expected);
  });

  test('a bare candidate names the model on every node that has it, in node order', () => {
    const both: Discovery = {
      node: 'searle',
      state: 'up',
      models: [{ id: 'gemma4:26b', node: 'searle', residency: 'resident', size_bytes: null, context_length: null }],
    };
    expect(candidate_models(merged(both), 'gemma4:26b').map(({ ref }) => ref)).toEqual([
      'searle/gemma4:26b',
      'closet/gemma4:26b',
    ]);
    expect(candidate_models(merged(both), 'closet/gemma4:26b').map(({ ref }) => ref)).toEqual(['closet/gemma4:26b']);
  });
});
