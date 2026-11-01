import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { fake_clock } from '../../../test/helpers/fake_clock.js';
import type { FakeClock } from '../../../test/helpers/fake_clock.js';
import { merge_catalogue } from '../../catalogue/index.js';
import type { Breakers, Catalogue, Discovery } from '../../catalogue/index.js';
import { format_issues, load_config } from '../../config/index.js';
import type { Config } from '../../config/index.js';
import { open_db } from '../../log/index.js';
import type { Db } from '../../log/index.js';
import type { RouteInput, RoutedProfile } from '../../route/index.js';
import { claim, create_leases, place } from '../index.js';
import type { Decision, Leases } from '../index.js';

const AT = '2026-10-31T12:00:00.000Z';

// searle is plato's 48 GB Mac with the 27B pinned; hume is a local box with no
// memory_gb; closet speaks only OpenAI and cannot say what is loaded.
const CONFIG = `version: 1
nodes:
  searle:
    kind: ollama
    url: http://searle.test:11434
    privacy: lan
    memory_gb: 48
    slots: { default: 2, "qwen3.8:27b-mlx": 1 }
    pinned: [qwen3.8:27b-mlx]
  hume:
    kind: ollama
    url: http://hume.test:11434
    privacy: local
    pinned: [phi4:14b]
  closet:
    kind: openai_compatible
    url: http://closet.test:8080/v1
    privacy: lan
    discover: false
    models: [glm-4.7-flash]
  claude:
    kind: claude_decision
    models: [haiku, sonnet, opus]
models:
  "qwen3.8:27b*":  { profiles: [chat], speed: slow, quality: high }
  "qwen3.6:35b*":  { profiles: [chat], speed: fast, quality: medium }
  "gemma4:26b*":   { profiles: [summarize], speed: fast, quality: medium }
  "claude/sonnet": { profiles: [chat], quality: frontier }
profiles:
  chat:       { candidates: [qwen3.6:35b-mlx, qwen3.8:27b-mlx, claude/sonnet@low] }
  summarize:  { candidates: [gemma4:26b, qwen3.6:35b-mlx] }
  code-heavy: { candidates: [claude/opus@high, qwen3.8:27b-mlx] }
  wide:       { candidates: [mistral-small:24b, qwen3.6:35b-mlx] }
  extract:    { candidates: [closet/glm-4.7-flash, qwen3.6:35b-mlx] }
  local:      { candidates: [llama4:scout, phi4:14b] }
policy:
  cold_load: avoid
  busy: { default: degrade, wait_ms: 5000 }
  deadline_ms: { default: 600000, summarize: 60000 }
callers:
  rob:         { max_privacy: cloud }
  night-shift: { max_privacy: lan, priority: batch, busy: wait, wait_ms: 120000 }
  nurselog:    { max_privacy: lan, models: [qwen3.8:27b-mlx, nomic-embed-text] }
`;

const loaded = (text: string): Config => {
  const result = load_config(text);
  if (!result.ok) throw new Error(format_issues('penfield.yaml', result.issues));
  return result.config;
};

const config = loaded(CONFIG);

const with_cold_load = (cold_load: Config['policy']['cold_load']): Config => ({
  ...config,
  policy: { ...config.policy, cold_load },
});

const QWEN35 = 'searle/qwen3.6:35b-mlx';
const QWEN27 = 'searle/qwen3.8:27b-mlx';
const GEMMA = 'searle/gemma4:26b';
const MISTRAL = 'searle/mistral-small:24b';

const SIZE = { 'qwen3.8:27b-mlx': 16e9, 'qwen3.6:35b-mlx': 20e9, 'gemma4:26b': 16e9, 'mistral-small:24b': 24e9 };

type Ids = keyof typeof SIZE;

const searle = (resident: readonly Ids[] = ['qwen3.8:27b-mlx', 'qwen3.6:35b-mlx']): Discovery => ({
  node: 'searle',
  state: 'up',
  models: Object.entries(SIZE).map(([id, size_bytes]) => ({
    id,
    node: 'searle',
    residency: resident.some((each) => each === id) ? 'resident' : 'cold',
    size_bytes,
    context_length: null,
  })),
});

const hume = (phi4: 'resident' | 'cold' = 'resident'): Discovery => ({
  node: 'hume',
  state: 'up',
  models: [
    { id: 'phi4:14b', node: 'hume', residency: phi4, size_bytes: 9e9, context_length: null },
    { id: 'llama4:scout', node: 'hume', residency: 'cold', size_bytes: 60e9, context_length: null },
  ],
});

type House = { searle?: Discovery; hume?: Discovery; breakers?: Breakers };

const house = ({ searle: s = searle(), hume: h = hume(), breakers = { nodes: {}, models: {} } }: House = {}): Catalogue =>
  merge_catalogue(config, {
    seen: {
      searle: { discovery: s, at: AT },
      hume: { discovery: h, at: AT },
      closet: { discovery: { node: 'closet', state: 'up', models: [] }, at: AT },
    },
    breakers,
  });

const input_for = (caller: string, more: Partial<RouteInput> = {}): RouteInput => {
  const policy = config.callers[caller];
  if (policy === undefined) throw new Error(`no caller ${caller}`);
  return {
    request_id: 'req-1',
    caller: { ...policy, name: caller },
    format: 'openai',
    endpoint: 'chat',
    model: 'auto',
    text: 'what is the capital of France?',
    system_text: '',
    history_turns: 0,
    tokens_estimate: 8,
    tools: false,
    attachments: 'none',
    hints: {},
    ...more,
  };
};

const to_profile = (profile: string, policy: Pick<RoutedProfile, 'prefer' | 'max_privacy'> = {}): RoutedProfile => ({
  ...policy,
  kind: 'profile',
  profile,
  rung: 'rule',
  confidence: 1,
  reasons: [`rule: profile "${profile}"`],
});

type Options = { in_use?: Record<string, number>; catalogue?: Catalogue; config?: Config; input?: Partial<RouteInput> };

const decide = (routed: RoutedProfile, caller: string, options: Options = {}): Decision =>
  place(
    routed,
    input_for(caller, options.input),
    options.catalogue ?? house(),
    options.in_use ?? {},
    options.config ?? config,
    { id: 'dec-1', at: AT },
  );

const target_ref = ({ target }: Decision): string => {
  if (target.kind === 'proxy') return `${target.node}/${target.model}`;
  if (target.kind === 'claude_decision') return `claude/${target.model}@${target.effort}`;
  return `refused: ${target.reason}`;
};

const skipped = ({ reasons }: Decision): string[] => reasons.filter((reason) => reason.startsWith('place: skipped'));

describe('the first ready candidate with a free slot', () => {
  test('a resident model with a slot free is chosen, its rivals kept as ranked alternatives', () => {
    const decision = decide(to_profile('chat'), 'rob');
    expect(decision).toMatchObject({
      id: 'dec-1',
      request_id: 'req-1',
      at: AT,
      caller: 'rob',
      profile: 'chat',
      rung: 'rule',
      confidence: 1,
      target: { kind: 'proxy', node: 'searle', model: 'qwen3.6:35b-mlx', format: 'openai' },
      alternatives: [
        { kind: 'proxy', node: 'searle', model: 'qwen3.8:27b-mlx', format: 'openai' },
        { kind: 'claude_decision', model: 'sonnet', effort: 'low' },
      ],
      placement: { resident: true, cold_load: false, waited_ms: 0 },
      policy: { max_privacy: 'cloud', busy: 'degrade' },
    });
    expect(decision.reasons).toEqual([
      'rule: profile "chat"',
      `place: chose ${QWEN35}, resident, 2 of 2 slots free`,
    ]);
  });

  test('two slots, then busy: one lease leaves a slot, two leave none', () => {
    expect(target_ref(decide(to_profile('chat'), 'rob', { in_use: { [QWEN35]: 1 } }))).toBe(QWEN35);
    const full = decide(to_profile('chat'), 'rob', { in_use: { [QWEN35]: 2 } });
    expect(target_ref(full)).toBe(QWEN27);
  });
});

describe('the busy policy', () => {
  test('degrade takes candidate two, with degraded_from set', () => {
    const decision = decide(to_profile('chat'), 'rob', { in_use: { [QWEN35]: 2 } });
    expect(decision.target).toEqual({ kind: 'proxy', node: 'searle', model: 'qwen3.8:27b-mlx', format: 'openai' });
    expect(decision.placement).toEqual({ resident: true, cold_load: false, waited_ms: 0, degraded_from: QWEN35 });
    expect(decision.reasons.slice(-2)).toEqual([
      `place: ${QWEN35} is busy, 2 of 2 slots held; degraded to ${QWEN27}`,
      `place: chose ${QWEN27}, resident, 1 of 1 slots free`,
    ]);
    // The busy model stays the first alternative, for a retry.
    expect(decision.alternatives[0]).toMatchObject({ node: 'searle', model: 'qwen3.6:35b-mlx' });
  });

  test('degrade down to a decision for the caller, and refused fast when nothing is free', () => {
    const both = { [QWEN35]: 2, [QWEN27]: 1 };
    expect(target_ref(decide(to_profile('chat'), 'rob', { in_use: both }))).toBe('claude/sonnet@low');
    const nurselog = decide(to_profile('chat'), 'nurselog', { in_use: both });
    expect(nurselog.target).toEqual({
      kind: 'refused',
      reason: `every candidate is busy: ${QWEN27} is busy, 1 of 1 slots held, and the rest are full`,
    });
  });

  test('wait keeps the busy first candidate, for claim to wait on', () => {
    const decision = decide(to_profile('chat'), 'night-shift', { in_use: { [QWEN35]: 2 } });
    expect(target_ref(decision)).toBe(QWEN35);
    expect(decision.policy).toEqual({ max_privacy: 'lan', busy: 'wait', wait_ms: 120_000 });
    expect(decision.placement).toEqual({ resident: true, cold_load: false, waited_ms: 0 });
    expect(decision.reasons).toContain(`place: ${QWEN35} is busy, 2 of 2 slots held; it waits up to 120000 ms for a slot`);
  });

  test("the caller's busy wins over the profile's, and the profile's over the default", () => {
    const by_profile = loaded(CONFIG.replace('busy: { default: degrade, wait_ms: 5000 }', 'busy: { default: degrade, wait_ms: 5000, chat: wait }'));
    expect(decide(to_profile('chat'), 'rob', { config: by_profile }).policy).toMatchObject({ busy: 'wait', wait_ms: 5_000 });
    expect(decide(to_profile('summarize'), 'rob', { config: by_profile }).policy.busy).toBe('degrade');
    const night = input_for('night-shift');
    const degrading = { ...night, caller: { ...night.caller, busy: 'degrade' as const } };
    expect(place(to_profile('chat'), degrading, house(), {}, by_profile, { id: 'd', at: AT }).policy.busy).toBe('degrade');
    expect(decide(to_profile('summarize'), 'night-shift').policy.busy).toBe('wait');
  });
});

describe('cold loads', () => {
  test('cold_load allow takes the first candidate even when it is cold', () => {
    const decision = decide(to_profile('summarize'), 'rob', { config: with_cold_load('allow') });
    expect(target_ref(decision)).toBe(GEMMA);
    expect(decision.placement).toEqual({ resident: false, cold_load: true, waited_ms: 0 });
    expect(decision.reasons.at(-1)).toBe(
      `place: chose ${GEMMA}, a cold load: 20.0 GB beside 20.0 GB pinned or leased in 48 GB fits; it may evict idle ${QWEN35}; 2 of 2 slots free`,
    );
  });

  test('cold_load avoid takes a resident candidate before a cold one, and loads when the resident is busy', () => {
    expect(target_ref(decide(to_profile('summarize'), 'rob'))).toBe(QWEN35);
    // With the pinned 27B evicted, 20 GB fits beside the busy 35B's 25.
    const roomy = house({ searle: searle(['qwen3.6:35b-mlx']) });
    const busy = decide(to_profile('summarize'), 'rob', { catalogue: roomy, in_use: { [QWEN35]: 2 } });
    expect(target_ref(busy)).toBe(GEMMA);
    expect(busy.placement).toEqual({ resident: false, cold_load: true, waited_ms: 0, degraded_from: QWEN35 });
  });

  test('cold_load never loads nothing, so a busy resident model leaves nothing to take', () => {
    const never = with_cold_load('never');
    const decision = decide(to_profile('summarize'), 'rob', { config: never });
    expect(target_ref(decision)).toBe(QWEN35);
    expect(skipped(decision)).toEqual([`place: skipped ${GEMMA}: it is cold, and cold_load is never`]);
    expect(target_ref(decide(to_profile('summarize'), 'rob', { config: never, in_use: { [QWEN35]: 2 } }))).toMatch(/^refused: every candidate is busy/);
  });

  test('a load that would evict the pinned model is refused; the pinned model is never named for eviction', () => {
    const decision = decide(to_profile('wide'), 'rob', { config: with_cold_load('allow') });
    // 30 GB would fit alone in 48, but not beside the pinned 27B's 20.
    expect(skipped(decision)).toEqual([
      `place: skipped ${MISTRAL}: it is cold, and a load 30.0 GB beside 20.0 GB pinned or leased in 48 GB does not fit, and ${QWEN27} must stay`,
    ]);
    expect(target_ref(decision)).toBe(QWEN35);
    const gemma = decide(to_profile('summarize'), 'rob', { config: with_cold_load('allow') });
    expect(gemma.reasons.join('\n')).not.toMatch(/evict[^\n]*qwen3\.8/);
  });

  test("a load that does not fit beside the node's leased models is refused (D44)", () => {
    // The 35B holds a lease, so it must stay: 20 + 20 pinned + 25 leased is over 48.
    const decision = decide(to_profile('summarize'), 'rob', { config: with_cold_load('allow'), in_use: { [QWEN35]: 1 } });
    expect(skipped(decision)).toEqual([
      `place: skipped ${GEMMA}: it is cold, and a load 20.0 GB beside 45.0 GB pinned or leased in 48 GB does not fit, and ${QWEN27}, ${QWEN35} must stay`,
    ]);
    expect(target_ref(decision)).toBe(QWEN35);
  });

  test('a node with no memory_gb loads only when nothing pinned or leased is resident', () => {
    const allow = with_cold_load('allow');
    const pinned = decide(to_profile('local'), 'rob', { config: allow });
    expect(skipped(pinned)).toEqual([
      'place: skipped hume/llama4:scout: it is cold, and a load node hume has no memory_gb, so a load could evict pinned or leased hume/phi4:14b',
    ]);
    expect(target_ref(pinned)).toBe('hume/phi4:14b');
    const empty = decide(to_profile('local'), 'rob', { config: allow, catalogue: house({ hume: hume('cold') }) });
    expect(target_ref(empty)).toBe('hume/llama4:scout');
    expect(empty.reasons.at(-1)).toContain('nothing pinned or leased is resident (node hume has no memory_gb)');
  });

  test('a model holding a lease counts as resident, whatever discovery last said', () => {
    const stale = house({ searle: searle(['qwen3.8:27b-mlx']) });
    const decision = decide(to_profile('summarize'), 'rob', { catalogue: stale, in_use: { [GEMMA]: 1 } });
    expect(target_ref(decision)).toBe(GEMMA);
    expect(decision.placement).toEqual({ resident: true, cold_load: false, waited_ms: 0 });
  });
});

describe('what placement skips, each with its reason', () => {
  test('a breaker-open node is skipped, and so is a model whose own breaker is open', () => {
    const open = decide(to_profile('chat'), 'rob', { catalogue: house({ breakers: { nodes: { searle: 'open' }, models: {} } }) });
    expect(skipped(open)).toEqual([
      `place: skipped ${QWEN35}: node searle's breaker is open`,
      `place: skipped ${QWEN27}: node searle's breaker is open`,
    ]);
    expect(target_ref(open)).toBe('claude/sonnet@low');
    const model = decide(to_profile('chat'), 'rob', { catalogue: house({ breakers: { nodes: {}, models: { [QWEN35]: 'half_open' } } }) });
    expect(skipped(model)).toEqual([`place: skipped ${QWEN35}: its breaker is half-open`]);
    expect(target_ref(model)).toBe(QWEN27);
  });

  test('a down node is skipped with its reason, and one not yet probed is skipped too', () => {
    const down: Discovery = { node: 'searle', state: 'down', models: [], reason: 'connect ECONNREFUSED' };
    const decision = decide(to_profile('extract'), 'rob', { catalogue: house({ searle: down }) });
    expect(skipped(decision)).toEqual(['place: skipped "qwen3.6:35b-mlx": no node has it']);
    expect(target_ref(decision)).toBe('closet/glm-4.7-flash');
    const unprobed = merge_catalogue(config, { seen: { searle: { discovery: searle(), at: AT } }, breakers: { nodes: {}, models: {} } });
    expect(skipped(decide(to_profile('extract'), 'rob', { catalogue: unprobed }))).toEqual([
      'place: skipped closet/glm-4.7-flash: node closet has not been probed yet',
    ]);
  });

  test('a cloud candidate is skipped for a lan caller, with the reason', () => {
    const decision = decide(to_profile('code-heavy'), 'night-shift');
    expect(skipped(decision)).toEqual(["place: skipped claude/opus: cloud is above caller night-shift's max_privacy lan"]);
    expect(target_ref(decision)).toBe(QWEN27);
    expect(target_ref(decide(to_profile('code-heavy'), 'rob'))).toBe('claude/opus@high');
  });

  test("an alias's or a hint's max_privacy lowers the caller's, and never raises it", () => {
    const alias = decide(to_profile('code-heavy', { max_privacy: 'lan' }), 'rob');
    expect(skipped(alias)).toEqual(["place: skipped claude/opus: cloud is above the alias's max_privacy lan"]);
    expect(alias.policy.max_privacy).toBe('lan');
    const hint = decide(to_profile('chat'), 'rob', { input: { hints: { max_privacy: 'local' } } });
    expect(target_ref(hint)).toBe('refused: no candidate can serve this request');
    expect(skipped(hint)[0]).toBe(`place: skipped ${QWEN35}: lan is above the request's hint max_privacy local`);
    const raised = decide(to_profile('code-heavy'), 'night-shift', { input: { hints: { max_privacy: 'cloud' } } });
    expect(target_ref(raised)).toBe(QWEN27);
  });

  test("a candidate outside the caller's models list is skipped with the reason (D38)", () => {
    const decision = decide(to_profile('chat'), 'nurselog');
    expect(skipped(decision)).toEqual([
      `place: skipped ${QWEN35}: not in caller nurselog's models list`,
      "place: skipped claude/sonnet: cloud is above caller nurselog's max_privacy lan",
    ]);
    expect(target_ref(decision)).toBe(QWEN27);
  });

  test('a node that does not speak the incoming format is skipped (C1)', () => {
    const decision = decide(to_profile('extract'), 'rob', { input: { format: 'anthropic' } });
    expect(skipped(decision)).toEqual(['place: skipped closet/glm-4.7-flash: node closet does not accept the anthropic format']);
    expect(decision.target).toEqual({ kind: 'proxy', node: 'searle', model: 'qwen3.6:35b-mlx', format: 'anthropic' });
  });
});

describe('the request', () => {
  test('a named model is placed only on the nodes that have it, with no profile (D6)', () => {
    const routed: RoutedProfile = { kind: 'model', model: 'qwen3.8:27b-mlx', rung: 'explicit', confidence: 1, reasons: ['explicit: searle has "qwen3.8:27b-mlx"'] };
    const decision = decide(routed, 'rob');
    expect(decision).toMatchObject({ profile: null, rung: 'explicit', alternatives: [] });
    expect(target_ref(decision)).toBe(QWEN27);
    const outside = decide({ ...routed, model: 'qwen3.6:35b-mlx' }, 'nurselog');
    expect(outside.target).toEqual({ kind: 'refused', reason: 'no candidate can serve this request' });
    expect(skipped(outside)).toEqual([`place: skipped ${QWEN35}: not in caller nurselog's models list`]);
  });

  test("the ladder's refusal is the decision's, its reasons whole", () => {
    const routed: RoutedProfile = { kind: 'refused', reason: '"nope" is no alias, profile or model in the catalogue', rung: 'explicit', confidence: 1, reasons: ['"nope" is no alias, profile or model in the catalogue'] };
    expect(decide(routed, 'rob')).toMatchObject({
      profile: null,
      target: { kind: 'refused', reason: routed.reasons[0] },
      reasons: routed.reasons,
      alternatives: [],
      placement: { resident: false, cold_load: false, waited_ms: 0 },
    });
  });

  test("prefer re-ranks by the overlay's quality or speed, the profile's order between equals", () => {
    const best = decide(to_profile('chat', { prefer: 'quality' }), 'rob');
    expect(target_ref(best)).toBe('claude/sonnet@low');
    expect(best.reasons).toContain(`place: prefer quality ranks claude/sonnet, ${QWEN27}, ${QWEN35}`);
    const fast = decide(to_profile('chat'), 'rob', { input: { hints: { prefer: 'speed' } } });
    expect(fast.reasons).toContain(`place: prefer speed ranks ${QWEN35}, ${QWEN27}, claude/sonnet`);
    expect(fast.policy.prefer).toBe('speed');
  });

  test("a Claude decision takes the request's effort when the node offers it, else the candidate's", () => {
    expect(target_ref(decide(to_profile('code-heavy'), 'rob', { input: { hints: { effort: 'max' } } }))).toBe('claude/opus@max');
    expect(target_ref(decide(to_profile('code-heavy'), 'rob'))).toBe('claude/opus@high');
    const named: RoutedProfile = { kind: 'model', model: 'claude/haiku', rung: 'explicit', confidence: 1, reasons: [] };
    expect(target_ref(decide(named, 'rob'))).toBe('claude/haiku@medium');
  });
});

describe('claim: the lease, separate from the decision', () => {
  let dir = '';
  let db: Db;
  let clock: FakeClock;
  let leases: Leases;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'penfield-place-'));
    db = open_db(dir);
    clock = fake_clock();
    leases = create_leases({ db, clock });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const deps = () => ({ leases, catalogue: house(), config });

  test('placing takes no lease; claiming takes one under the profile deadline', async () => {
    const decision = decide(to_profile('summarize'), 'rob', { in_use: leases.in_use() });
    expect(leases.active()).toEqual([]);
    const claimed = await claim(decision, deps());
    expect(claimed.decision).toBe(decision);
    expect(claimed.lease).toMatchObject({ node: 'searle', model: 'qwen3.6:35b-mlx', decision_id: 'dec-1', deadline_at: '2026-10-31T12:01:00.000Z' });
    expect(leases.in_use()).toEqual({ [QWEN35]: 1 });
  });

  test('a Claude decision and a refusal take no lease', async () => {
    expect((await claim(decide(to_profile('code-heavy'), 'rob'), deps())).lease).toBeNull();
    const refused = decide(to_profile('chat'), 'rob', { input: { hints: { max_privacy: 'local' } } });
    expect(await claim(refused, deps())).toEqual({ decision: refused, lease: null });
  });

  const fill = (ref: string, model: string, slots: number) => {
    for (let index = 0; index < slots; index += 1) {
      leases.acquire({ request_id: `held-${index}`, decision_id: 'd', caller: 'rob', node: 'searle', model, slots, deadline_ms: 600_000 });
    }
    expect(leases.in_use()[ref]).toBe(slots);
  };

  test('wait is served under its wait_ms, with waited_ms on the decision', async () => {
    fill(QWEN35, 'qwen3.6:35b-mlx', 2);
    const decision = decide(to_profile('chat'), 'night-shift', { in_use: leases.in_use() });
    const pending = claim(decision, deps());
    clock.advance(90_000);
    const [first] = leases.active();
    if (first === undefined) throw new Error('no lease');
    leases.release(first.id, 'ok');
    const claimed = await pending;
    expect(claimed.lease).toMatchObject({ caller: 'night-shift', model: 'qwen3.6:35b-mlx' });
    expect(claimed.decision.placement.waited_ms).toBe(90_000);
    expect(claimed.decision.reasons.at(-1)).toBe(`place: waited 90000 ms for a slot on ${QWEN35}`);
  });

  test('wait is refused past its wait_ms, the model it waited on first among the alternatives', async () => {
    fill(QWEN35, 'qwen3.6:35b-mlx', 2);
    const decision = decide(to_profile('chat'), 'night-shift', { in_use: leases.in_use() });
    const pending = claim(decision, deps());
    clock.advance(120_000);
    const claimed = await pending;
    expect(claimed.lease).toBeNull();
    expect(claimed.decision.target).toEqual({ kind: 'refused', reason: `no slot on ${QWEN35} came free within 120000 ms` });
    expect(claimed.decision.placement.waited_ms).toBe(120_000);
    expect(claimed.decision.alternatives[0]).toEqual(decision.target);
  });

  test('degrade with no slot left at claim time is refused, not queued', async () => {
    const decision = decide(to_profile('chat'), 'rob');
    fill(QWEN35, 'qwen3.6:35b-mlx', 2);
    const claimed = await claim(decision, deps());
    expect(claimed.decision.target).toEqual({ kind: 'refused', reason: `${QWEN35} has no free slot` });
    expect(clock.pending()).toBe(0);
  });

  test('a target gone from the catalogue is refused', async () => {
    const decision = decide(to_profile('chat'), 'rob');
    const empty = merge_catalogue(config, { seen: {}, breakers: { nodes: {}, models: {} } });
    const claimed = await claim(decision, { ...deps(), catalogue: empty });
    expect(claimed.decision.target).toEqual({ kind: 'refused', reason: `${QWEN35} is no longer in the catalogue` });
  });
});
