import { readFileSync } from 'node:fs';

import { describe, expect, test, vi } from 'vitest';

import { merge_catalogue } from '../../catalogue/index.js';
import type { Catalogue, Discovery } from '../../catalogue/index.js';
import { format_issues, load_config } from '../../config/index.js';
import type { Config } from '../../config/index.js';
import { route } from '../index.js';
import type { ModelRung, RoutedProfile, RouteInput } from '../index.js';

// Plan step 9: the ladder over the house file, deploy/penfield.example.yaml. The
// table below is Stage A's routing policy as it runs: what each kind of request
// routes to, by which rung, and how sure the ladder is.

const loaded = (text: string): Config => {
  const result = load_config(text);
  if (!result.ok) throw new Error(format_issues('penfield.yaml', result.issues));
  return result.config;
};

const HOUSE = loaded(readFileSync(new URL('../../../../../deploy/penfield.example.yaml', import.meta.url), 'utf8'));

const up = (node: string, ids: string[]): Discovery => ({
  node,
  state: 'up',
  models: ids.map((id) => ({ id, node, residency: 'resident', size_bytes: null, context_length: null })),
});

const SEARLE = ['qwen3.8:27b-mlx', 'qwen3.6:35b-mlx', 'gemma4:26b', 'nomic-embed-text:latest', 'qwen3:4b-instruct-2507-q4_K_M'];

const catalogue_of = (config: Config, discovery: Discovery): Catalogue =>
  merge_catalogue(config, {
    seen: { searle: { discovery, at: '2026-10-31T12:00:00.000Z' } },
    breakers: { nodes: {}, models: {} },
  });

const CATALOGUE = catalogue_of(HOUSE, up('searle', SEARLE));

// A short chat question from rob for `auto`; each row changes what it says.
const ask = (overrides: Partial<RouteInput> = {}): RouteInput => ({
  request_id: 'req_1',
  caller: { name: 'rob', max_privacy: 'cloud', priority: 'interactive', keep_prompts: true },
  format: 'openai',
  endpoint: 'chat',
  model: 'auto',
  text: 'What is a lease?',
  system_text: '',
  history_turns: 0,
  tokens_estimate: 4,
  tools: false,
  attachments: 'none',
  hints: {},
  ...overrides,
});

// `chat · rule · 1`, `model claude/opus · explicit · 1`, `refused · rule · 1`, with
// an alias's policy after.
const summary = (routed: RoutedProfile): string => {
  const target = routed.kind === 'profile' ? routed.profile : routed.kind === 'model' ? `model ${routed.model}` : 'refused';
  const policy = [
    ...(routed.prefer === undefined ? [] : [`prefer ${routed.prefer}`]),
    ...(routed.max_privacy === undefined ? [] : [`max_privacy ${routed.max_privacy}`]),
  ];
  return [target, routed.rung, String(routed.confidence), ...policy].join(' · ');
};

const k = (thousands: number): number => thousands * 1000;

// A file whose router holds only these rules, written as YAML list lines.
const ruled = (rules: string): Config =>
  loaded(`version: 1
nodes:
  searle: { kind: ollama, url: http://searle.test:11434, privacy: lan }
profiles:
  chat: { candidates: [qwen3.6:35b-mlx] }
router:
  rules:
${rules}
`);

// A stand-in for a Stage C rung that always answers `profile` at `confidence`.
const answering =
  (profile: string, confidence: number): ModelRung =>
  () =>
    Promise.resolve({ kind: 'answer', profile, confidence, reason: `model rung: ${profile}` });

const agent_turn = (tokens: number) => route(ask({ tools: true, tokens_estimate: tokens }), CATALOGUE, HOUSE);

const refusing: ModelRung = () => Promise.resolve({ kind: 'refused', reason: 'embedding: the embedder is down' });

describe('the house routing table', () => {
  const TABLE: [string, Partial<RouteInput>, string][] = [
    // Plain chat lands on the chat rule; the endpoint alone decides embeddings.
    ['a short question',                          {},                                                          'chat · rule · 1'],
    ['an embeddings request',                     { endpoint: 'embeddings' },                                  'embed · shape · 1'],
    ['an image to describe',                      { attachments: 'images' },                                   'chat · rule · 1'],
    // An agent's turn carries tools: code-light, or code-heavy past 12 k tokens.
    ['an agent turn',                             { tools: true, tokens_estimate: k(3) },                      'code-light · rule · 1'],
    ['an agent turn past 12 k tokens',            { tools: true, tokens_estimate: k(20) },                     'code-heavy · rule · 1'],
    ['a long agent turn: tools outrank length',   { tools: true, tokens_estimate: k(30) },                     'code-heavy · rule · 1'],
    // Pasted code is code-light only once it is long; a long read is summarize.
    ['pasted code past 4 k tokens',               { attachments: 'code', tokens_estimate: k(6) },              'code-light · rule · 1'],
    ['a short pasted snippet',                    { attachments: 'code', tokens_estimate: 800 },               'chat · rule · 1'],
    ['a long document to read',                   { tokens_estimate: k(30) },                                  'summarize · rule · 1'],
    // The system prompt picks classify, its (?i) read as the i flag.
    ['a classifier system prompt',                { system_text: 'Classify the support ticket.' },             'classify · rule · 1'],
    ['a labelling prompt in capitals',            { system_text: 'LABEL each line as spam or not.' },          'classify · rule · 1'],
    // A profile hint outranks everything below it, and must name a real profile.
    ['a profile hint',                            { hints: { profile: 'reason' } },                            'reason · rule · 1'],
    ['a hint outranks tools',                     { tools: true, hints: { profile: 'extract' } },              'extract · rule · 1'],
    ['a hint naming no profile',                  { hints: { profile: 'poetry' } },                            'refused · rule · 1'],
    // The house aliases run the same ladder and carry their policy with them.
    ['auto/fast',                                 { model: 'auto/fast' },                                      'chat · rule · 1 · prefer speed'],
    ['auto/private with tools',                   { model: 'auto/private', tools: true },                      'code-light · rule · 1 · max_privacy lan'],
    // A profile's name routes to it, past the rules; a model's name skips the ladder.
    ['a profile by name',                         { model: 'summarize', tools: true },                         'summarize · alias · 1'],
    ['a concrete tag',                            { model: 'qwen3.6:35b-mlx', tools: true },                   'model qwen3.6:35b-mlx · explicit · 1'],
    ['a Claude model by name',                    { model: 'claude/opus' },                                    'model claude/opus · explicit · 1'],
    ['a model no node has',                       { model: 'gpt-9' },                                          'refused · explicit · 1'],
  ];

  test('holds twenty requests', () => {
    expect(TABLE).toHaveLength(20);
  });

  const rows = TABLE.map(([what, overrides, expected]) => ({ what, overrides, expected }));

  test.each(rows)('$what: $expected', async ({ overrides, expected }) => {
    expect(summary(await route(ask(overrides), CATALOGUE, HOUSE))).toBe(expected);
  });
});

describe('the reasons', () => {
  test('name the alias and the rule that answered', async () => {
    expect((await route(ask(), CATALOGUE, HOUSE)).reasons).toEqual(['alias: "auto" runs the ladder', 'rule 8 (chat): chat']);
    const heavy = await route(ask({ model: 'auto/best', tools: true, tokens_estimate: k(20) }), CATALOGUE, HOUSE);
    expect(heavy.reasons).toEqual([
      'alias: "auto/best" runs the ladder, prefer quality',
      'rule 3 (tools, over 12000 tokens): code-heavy',
    ]);
  });

  test('name the nodes that have an explicit model', async () => {
    expect(await route(ask({ model: 'nomic-embed-text', endpoint: 'embeddings' }), CATALOGUE, HOUSE)).toEqual({
      kind: 'model',
      model: 'nomic-embed-text',
      rung: 'explicit',
      confidence: 1,
      reasons: ['explicit: searle has "nomic-embed-text"'],
    });
  });

  test('a hint naming no profile is refused with the reason, not passed to the rules below', async () => {
    expect(await route(ask({ hints: { profile: 'poetry' } }), CATALOGUE, HOUSE)).toEqual({
      kind: 'refused',
      reason: 'no profile "poetry" in penfield.yaml\'s profiles',
      rung: 'rule',
      confidence: 1,
      reasons: [
        'alias: "auto" runs the ladder',
        'rule 2 (a profile hint): poetry, as hinted',
        'no profile "poetry" in penfield.yaml\'s profiles',
      ],
    });
  });
});

describe('the explicit rung', () => {
  test('skips the ladder: no rung below it runs', async () => {
    const embedding = vi.fn<ModelRung>();
    const classifier = vi.fn<ModelRung>();
    const routed = await route(ask({ model: 'qwen3.8:27b-mlx', tools: true }), CATALOGUE, HOUSE, { embedding, classifier });
    expect(routed).toMatchObject({ kind: 'model', model: 'qwen3.8:27b-mlx', rung: 'explicit' });
    expect(embedding).not.toHaveBeenCalled();
    expect(classifier).not.toHaveBeenCalled();
  });

  test('a model that is no alias, profile or catalogue model is refused, naming a node that is down', async () => {
    const down = catalogue_of(HOUSE, { node: 'searle', state: 'down', models: [], reason: 'connect ECONNREFUSED' });
    expect(await route(ask({ model: 'qwen3.6:35b-mlx' }), down, HOUSE)).toMatchObject({
      kind: 'refused',
      rung: 'explicit',
      reason: '"qwen3.6:35b-mlx" is no alias, profile or model in the catalogue (searle is down: connect ECONNREFUSED)',
    });
    expect(await route(ask({ model: 'gpt-9' }), CATALOGUE, HOUSE)).toMatchObject({
      reason: '"gpt-9" is no alias, profile or model in the catalogue',
    });
  });

  test('a name off the object prototype is no alias', async () => {
    expect(await route(ask({ model: 'constructor' }), CATALOGUE, HOUSE)).toMatchObject({ kind: 'refused', rung: 'explicit' });
  });
});

describe('aliases', () => {
  const config = loaded(`version: 1
nodes:
  searle: { kind: ollama, url: http://searle.test:11434, privacy: lan }
profiles:
  chat: { candidates: [qwen3.6:35b-mlx] }
  code-heavy: { candidates: [qwen3.8:27b-mlx] }
aliases:
  auto: { ladder: default }
  code: { profile: code-heavy, prefer: quality, max_privacy: lan }
`);
  const catalogue = catalogue_of(config, up('searle', SEARLE));

  test("one naming a profile routes there at 1.0, carrying its prefer and max_privacy", async () => {
    expect(await route(ask({ model: 'code' }), catalogue, config)).toEqual({
      kind: 'profile',
      profile: 'code-heavy',
      rung: 'alias',
      confidence: 1,
      prefer: 'quality',
      max_privacy: 'lan',
      reasons: ['alias: "code" is profile "code-heavy", prefer quality, max_privacy lan'],
    });
  });

  test('a profile name routes to that profile, with no policy of its own', async () => {
    expect(await route(ask({ model: 'chat', tools: true }), catalogue, config)).toEqual({
      kind: 'profile',
      profile: 'chat',
      rung: 'alias',
      confidence: 1,
      reasons: ['alias: "chat" is a profile'],
    });
  });
});

describe('the shape and rule rungs', () => {
  test('an endpoint whose profile the file lacks is refused at shape (the house has no stt)', async () => {
    expect(await route(ask({ endpoint: 'audio_transcriptions' }), CATALOGUE, HOUSE)).toMatchObject({
      kind: 'refused',
      rung: 'shape',
      reason: 'no profile "stt" in penfield.yaml\'s profiles',
    });
  });

  test('tokens_gt is strictly over: 12000 is code-light, 12001 code-heavy', async () => {
    expect(summary(await agent_turn(k(12)))).toBe('code-light · rule · 1');
    expect(summary(await agent_turn(k(12) + 1))).toBe('code-heavy · rule · 1');
  });

  test('a rule naming a profile the file lacks is refused, not skipped', async () => {
    const config = ruled('    - { when: { tools: true }, profile: agents }');
    expect(await route(ask({ tools: true }), CATALOGUE, config)).toMatchObject({
      kind: 'refused',
      rung: 'rule',
      reason: 'no profile "agents" in penfield.yaml\'s profiles',
      reasons: ['alias: "auto" runs the ladder', 'rule 1 (tools): agents', 'no profile "agents" in penfield.yaml\'s profiles'],
    });
  });

  test('a system_matches that does not compile refuses the request it would test', async () => {
    const config = ruled('    - { when: { system_matches: "(?i)[unclosed" }, profile: chat }');
    const routed = await route(ask({ system_text: 'anything' }), CATALOGUE, config);
    expect(routed).toMatchObject({ kind: 'refused', rung: 'rule' });
    expect(routed.kind === 'refused' && routed.reason).toMatch(/^rule 1's system_matches does not compile: /);
  });

  test('a $hint rule with no hint passes to the next rule, and an empty when matches anything', async () => {
    const config = ruled(`    - { when: {}, profile: $hint }
    - { when: { chat: false }, profile: embed }
    - { when: {}, profile: chat }`);
    expect(await route(ask(), CATALOGUE, config)).toMatchObject({
      profile: 'chat',
      reasons: ['alias: "auto" runs the ladder', 'rule 3 (any request): chat'],
    });
  });
});

describe('the model rungs and the default', () => {
  const config = loaded(`version: 1
nodes:
  searle: { kind: ollama, url: http://searle.test:11434, privacy: lan }
profiles:
  chat: { candidates: [qwen3.6:35b-mlx] }
  code-light: { candidates: [qwen3.8:27b-mlx] }
  reason: { candidates: [qwen3.8:27b-mlx] }
`);

  test('Stage A passes none, and with no rule matching the default answers chat at 0.5', async () => {
    expect(await route(ask(), CATALOGUE, config)).toEqual({
      kind: 'profile',
      profile: 'chat',
      rung: 'default',
      confidence: 0.5,
      reasons: ['alias: "auto" runs the ladder', 'rule: none of 0 matched', 'default: no rung above cleared the threshold, so chat'],
    });
  });

  test('an injected rung that clears the threshold answers, and the rungs below it never run', async () => {
    const classifier = vi.fn<ModelRung>();
    const routed = await route(ask(), CATALOGUE, config, { embedding: answering('code-light', 0.9), classifier });
    expect(routed).toMatchObject({ profile: 'code-light', rung: 'embedding', confidence: 0.9 });
    expect(classifier).not.toHaveBeenCalled();
  });

  test('one below the threshold is noted and passed over; meeting it exactly clears it', async () => {
    const rungs = { embedding: answering('code-light', 0.4), classifier: answering('reason', 0.7) };
    expect(await route(ask(), CATALOGUE, config, rungs)).toMatchObject({
      profile: 'reason',
      rung: 'classifier',
      confidence: 0.7,
      reasons: [
        'alias: "auto" runs the ladder',
        'rule: none of 0 matched',
        'model rung: code-light, at 0.4 below the 0.7 threshold',
        'model rung: reason',
      ],
    });
  });

  test('when none clears it, the default stands', async () => {
    const rungs = { embedding: answering('code-light', 0.4), classifier: answering('reason', 0.6) };
    expect(await route(ask(), CATALOGUE, config, rungs)).toMatchObject({ profile: 'chat', rung: 'default', confidence: 0.5 });
  });

  test('a model rung that refuses ends the ladder there', async () => {
    expect(await route(ask(), CATALOGUE, config, { embedding: refusing })).toMatchObject({
      kind: 'refused',
      rung: 'embedding',
      reason: 'embedding: the embedder is down',
    });
  });

  test('a file without a chat profile refuses at the default', async () => {
    const bare = loaded(`version: 1
nodes:
  searle: { kind: ollama, url: http://searle.test:11434, privacy: lan }
profiles:
  reason: { candidates: [qwen3.8:27b-mlx] }
`);
    expect(await route(ask(), CATALOGUE, bare)).toMatchObject({ kind: 'refused', rung: 'default', confidence: 0.5 });
  });
});
