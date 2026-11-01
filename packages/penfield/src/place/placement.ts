import { candidate_models, names_model, parse_candidate } from '../catalogue/index.js';
import type { Catalogue, CatalogueModel, CatalogueNode } from '../catalogue/index.js';
import type { Config, Effort, Format, Privacy } from '../config/index.js';
import type { RouteInput, RoutedProfile } from '../route/index.js';
import type { Claim, InUse, Lease, Leases } from './leases.js';

// Placement (D12): the profile's ranked candidates, or the nodes that have the one
// model a request named (D6), filtered by the caller's policy and the catalogue's
// health, then the first that is ready and has a free slot. `place` is pure over a
// snapshot of the lease table, so `/route` can decide without taking a lease;
// `claim` is the separate call that takes one, waiting in line when the busy
// policy says so. Nothing here calls a model (C3).

type ClaudeModel = 'haiku' | 'sonnet' | 'opus';

export type Target =
  | { kind: 'proxy'; node: string; model: string; format: Format }
  | { kind: 'claude_decision'; model: ClaudeModel; effort: Effort }
  | { kind: 'refused'; reason: string };

export type Placement = { resident: boolean; cold_load: boolean; waited_ms: number; degraded_from?: string };

type Busy = 'degrade' | 'wait';

type Prefer = NonNullable<RoutedProfile['prefer']>;

// `wait_ms` is there when `busy` is `wait`.
type DecisionPolicy = { max_privacy: Privacy; prefer?: Prefer; busy: Busy; wait_ms?: number };

// Spec §5.3. `profile` is null for a request that named a model, which no rung routed.
export type Decision = {
  id: string;
  request_id: string;
  at: string;
  caller: string;
  profile: string | null;
  rung: RoutedProfile['rung'];
  confidence: number;
  reasons: string[];
  target: Target;
  alternatives: Target[];
  placement: Placement;
  policy: DecisionPolicy;
};

export type PlaceConfig = Pick<Config, 'profiles' | 'policy'>;

// The decision's id and time, minted by the caller so `place` stays pure.
export type Stamp = { id: string; at: string };

const RANK: Record<Privacy, number> = { local: 0, lan: 1, cloud: 2 };

// D44: a model's footprint is its weights on disk plus this share of them again for
// its KV cache and runtime. A quarter is a first guess, to check against what
// `/api/ps` reports loaded on searle (the 35B took 21.9 GB at range 2's stop).
const KV_ALLOWANCE = 0.25;

const GB = 1e9;

// ── the request's policy ──────────────────────────────────────────────────────

type Capped = { max_privacy: Privacy; by: string };

// The lowest of the caller's, the alias's and the hint's: a hint lowers, never raises.
const cap_of = (routed: RoutedProfile, input: RouteInput): Capped => {
  const caps: Capped[] = [
    { max_privacy: input.caller.max_privacy, by: `caller ${input.caller.name}'s` },
    ...(routed.max_privacy === undefined ? [] : [{ max_privacy: routed.max_privacy, by: "the alias's" }]),
    ...(input.hints.max_privacy === undefined ? [] : [{ max_privacy: input.hints.max_privacy, by: "the request's hint" }]),
  ];
  return caps.reduce((low, each) => (RANK[each.max_privacy] < RANK[low.max_privacy] ? each : low));
};

// A per-profile key of `busy`, `stall_ms` or `deadline_ms`, never a reserved one.
const own_value = (values: object, profile: string | null, reserved: readonly string[]): unknown =>
  profile === null || reserved.includes(profile) || !Object.hasOwn(values, profile)
    ? undefined
    : Object.entries(values).find(([key]) => key === profile)?.[1];

const is_busy = (value: unknown): value is Busy => value === 'degrade' || value === 'wait';

// The caller's own word, then the profile's, then the default (D15).
const busy_of = (input: RouteInput, profile: string | null, config: PlaceConfig): Busy => {
  const own = own_value(config.policy.busy, profile, ['default', 'wait_ms']);
  return input.caller.busy ?? (is_busy(own) ? own : config.policy.busy.default);
};

const policy_of = (routed: RoutedProfile, input: RouteInput, profile: string | null, config: PlaceConfig): DecisionPolicy => {
  const prefer = input.hints.prefer ?? routed.prefer;
  const busy = busy_of(input, profile, config);
  return {
    max_privacy: cap_of(routed, input).max_privacy,
    ...(prefer === undefined ? {} : { prefer }),
    busy,
    ...(busy === 'wait' ? { wait_ms: input.caller.wait_ms ?? config.policy.busy.wait_ms } : {}),
  };
};

// The profile's own `deadline_ms`, else the default: how long a lease may live.
const deadline_ms_of = (config: PlaceConfig, profile: string | null): number => {
  const own = own_value(config.policy.deadline_ms, profile, ['default']);
  return typeof own === 'number' ? own : config.policy.deadline_ms.default;
};

// ── candidates ────────────────────────────────────────────────────────────────

type Context = {
  input: RouteInput;
  catalogue: Catalogue;
  in_use: InUse;
  cap: Capped;
  cold_load: Config['policy']['cold_load'];
};

type Option = {
  ref: string;
  target: Exclude<Target, { kind: 'refused' }>;
  model: CatalogueModel;
  // Serves without a load: a decision, or a model that is resident or cannot say.
  ready: boolean;
  resident: boolean;
  cold: boolean;
  // A cold load the policy and the node's memory allow, and why it fits or does not.
  loadable: boolean;
  fit: string | null;
  held: number;
  slots: number | null;
  free: boolean;
};

const held_of = (in_use: InUse, ref: string): number => in_use[ref] ?? 0;

// A model holding a lease is loaded, whatever the last discovery said.
const is_resident = (model: CatalogueModel, in_use: InUse): boolean =>
  model.residency === 'resident' || held_of(in_use, model.ref) > 0;

const policy_skip = (model: CatalogueModel, node: CatalogueNode, ctx: Context): string | null => {
  if (!node.enabled) return `node ${node.name} is disabled`;
  if (node.kind === 'anthropic_api') return `node ${node.name} is an anthropic_api node, which runs from Stage D`;
  if (RANK[node.privacy] > RANK[ctx.cap.max_privacy]) {
    return `${node.privacy} is above ${ctx.cap.by} max_privacy ${ctx.cap.max_privacy}`;
  }
  const allowed = ctx.input.caller.models;
  if (allowed !== undefined && !allowed.some((wanted) => names_model(wanted, model))) {
    return `not in caller ${ctx.input.caller.name}'s models list`;
  }
  // C1: forwarded as it came, so a node that does not speak the format cannot take it.
  if (node.kind !== 'claude_decision' && !node.formats.includes(ctx.input.format)) {
    return `node ${node.name} does not accept the ${ctx.input.format} format`;
  }
  return null;
};

const health_skip = (model: CatalogueModel, node: CatalogueNode): string | null => {
  if (node.state === 'down') return `node ${node.name} is down: ${node.reason ?? 'no reason given'}`;
  if (node.state === 'unknown') return `node ${node.name} has not been probed yet`;
  if (node.breaker !== 'closed') return `node ${node.name}'s breaker is ${node.breaker.replace('_', '-')}`;
  if (model.breaker !== 'closed') return `its breaker is ${model.breaker.replace('_', '-')}`;
  return null;
};

const gb = (bytes: number): string => `${(bytes / GB).toFixed(1)} GB`;

const footprint = (models: readonly CatalogueModel[]): number | null =>
  models.reduce<number | null>(
    (sum, { size_bytes }) => (sum === null || size_bytes === null ? null : sum + size_bytes * (1 + KV_ALLOWANCE)),
    0,
  );

type Fit = { ok: boolean; reason: string };

// D44: a cold load fits beside the node's resident models that are pinned or
// leased, which a load must never evict (D14); an idle unpinned one may go.
const fit_of = (model: CatalogueModel, node: CatalogueNode, ctx: Context): Fit => {
  const resident = ctx.catalogue.models.filter(
    (each) => each.node === model.node && each.ref !== model.ref && is_resident(each, ctx.in_use),
  );
  const kept = resident.filter((each) => each.pinned || held_of(ctx.in_use, each.ref) > 0);
  const idle = resident.filter((each) => !kept.includes(each)).map(({ ref }) => ref);
  const named = kept.map(({ ref }) => ref).join(', ');
  const need = footprint([model]);
  const beside = footprint(kept);
  if (node.memory_gb === null || need === null || beside === null) {
    const unknown = node.memory_gb === null ? `node ${node.name} has no memory_gb` : 'a model size is unknown';
    return kept.length === 0
      ? { ok: true, reason: `nothing pinned or leased is resident (${unknown})` }
      : { ok: false, reason: `${unknown}, so a load could evict pinned or leased ${named}` };
  }
  const room = node.memory_gb * GB;
  const all = footprint(resident);
  const evicts = idle.length > 0 && (all === null || need + all > room) ? `; it may evict idle ${idle.join(', ')}` : '';
  const sizes = `${gb(need)} beside ${gb(beside)} pinned or leased in ${node.memory_gb} GB`;
  return need + beside <= room
    ? { ok: true, reason: `${sizes} fits${evicts}` }
    : { ok: false, reason: `${sizes} does not fit, and ${named || 'nothing'} must stay` };
};

const CLAUDE_MODELS: readonly string[] = ['haiku', 'sonnet', 'opus'] satisfies ClaudeModel[];

const is_claude = (id: string): id is ClaudeModel => CLAUDE_MODELS.includes(id);

// The request's hint when the node offers it, else the candidate's, else medium.
const effort_of = (node: CatalogueNode, wanted: string | null, hint: Effort | undefined): Effort => {
  const offered = (value: string | null | undefined): value is Effort =>
    value !== null && value !== undefined && node.efforts.some((each) => each === value);
  if (offered(hint)) return hint;
  if (offered(wanted)) return wanted;
  return node.efforts.includes('medium') ? 'medium' : (node.efforts[0] ?? 'medium');
};

const decision_option = (model: CatalogueModel, node: CatalogueNode, effort: string | null, ctx: Context): Option | null => {
  if (!is_claude(model.id)) return null;
  const target = { kind: 'claude_decision' as const, model: model.id, effort: effort_of(node, effort, ctx.input.hints.effort) };
  return { ref: model.ref, target, model, ready: true, resident: false, cold: false, loadable: false, fit: null, held: 0, slots: null, free: true };
};

const proxy_option = (model: CatalogueModel, node: CatalogueNode, ctx: Context): Option => {
  const held = held_of(ctx.in_use, model.ref);
  const slots = model.slots ?? 1;
  const resident = is_resident(model, ctx.in_use);
  const cold = !resident && model.residency === 'cold';
  const fit = cold ? fit_of(model, node, ctx) : null;
  return {
    ref: model.ref,
    target: { kind: 'proxy', node: node.name, model: model.id, format: ctx.input.format },
    model,
    ready: !cold,
    resident,
    cold,
    loadable: cold && ctx.cold_load !== 'never' && fit?.ok === true,
    fit: fit?.reason ?? null,
    held,
    slots,
    free: held < slots,
  };
};

type Wanted = { text: string; models: CatalogueModel[]; effort: string | null };

// A profile's candidates in rank order, each the models it names in node order;
// for a named model, the nodes that have exactly it (D6).
const wanted_of = (routed: Exclude<RoutedProfile, { kind: 'refused' }>, catalogue: Catalogue, config: PlaceConfig): Wanted[] => {
  if (routed.kind === 'model') {
    return [{ text: routed.model, models: catalogue.models.filter((each) => names_model(routed.model, each)), effort: null }];
  }
  return (config.profiles[routed.profile]?.candidates ?? []).map((text) => ({
    text,
    models: candidate_models(catalogue, text),
    effort: parse_candidate(text).effort,
  }));
};

const key_of = ({ ref, target }: Option): string => (target.kind === 'claude_decision' ? `${ref}@${target.effort}` : ref);

const options_of = (wanted: readonly Wanted[], ctx: Context, reasons: string[]): Option[] => {
  const nodes = new Map(ctx.catalogue.nodes.map((node) => [node.name, node]));
  const seen = new Set<string>();
  return wanted.flatMap(({ text, models, effort }) => {
    if (models.length === 0) reasons.push(`place: skipped "${text}": no node has it`);
    return models.flatMap((model) => {
      const node = nodes.get(model.node);
      if (node === undefined) return [];
      const skip = policy_skip(model, node, ctx) ?? health_skip(model, node);
      if (skip !== null) {
        reasons.push(`place: skipped ${model.ref}: ${skip}`);
        return [];
      }
      const option = node.kind === 'claude_decision' ? decision_option(model, node, effort, ctx) : proxy_option(model, node, ctx);
      if (option === null || seen.has(key_of(option))) return [];
      seen.add(key_of(option));
      return [option];
    });
  });
};

// ── choosing ──────────────────────────────────────────────────────────────────

const SPEED: Record<string, number> = { fastest: 0, fast: 1, medium: 2, slow: 3 };
const QUALITY: Record<string, number> = { frontier: 0, high: 1, medium: 2, low: 3 };

// `prefer` re-ranks the candidates by the overlay's speed or quality, keeping the
// profile's order between equals and putting a model with no word on it last.
const preferred_order = (options: readonly Option[], prefer: Prefer | undefined): Option[] => {
  if (prefer === undefined) return [...options];
  const rank = (option: Option): number =>
    (prefer === 'speed' ? SPEED[option.model.speed ?? ''] : QUALITY[option.model.quality ?? '']) ?? 4;
  return options.toSorted((a, b) => rank(a) - rank(b));
};

// `allow` takes the candidates in rank order, a cold load as good as a resident
// model; `avoid` takes every ready candidate before any cold load; `never` loads nothing.
const pool_of = (options: readonly Option[], cold_load: Context['cold_load']): Option[] => {
  if (cold_load === 'allow') return options.filter(({ ready, loadable }) => ready || loadable);
  const ready = options.filter((option) => option.ready);
  return cold_load === 'avoid' ? [...ready, ...options.filter(({ loadable }) => loadable)] : ready;
};

const cold_reasons = (options: readonly Option[], cold_load: Context['cold_load']): string[] =>
  options.flatMap((option) => {
    if (!option.cold) return [];
    if (cold_load === 'never') return [`place: skipped ${option.ref}: it is cold, and cold_load is never`];
    if (!option.loadable) return [`place: skipped ${option.ref}: it is cold, and a load ${option.fit ?? 'cannot be sized'}`];
    return [];
  });

const slots_line = ({ held, slots }: Option): string => `${held} of ${slots ?? 0} slots held`;

const describe = (option: Option): string => {
  if (option.target.kind === 'claude_decision') {
    return `${option.ref} at ${option.target.effort}, a decision the caller's client runs`;
  }
  const free = `${(option.slots ?? 0) - option.held} of ${option.slots ?? 0} slots free`;
  if (option.cold) return `${option.ref}, a cold load: ${option.fit ?? ''}; ${free}`;
  return `${option.ref}, ${option.resident ? 'resident' : 'residency unknown'}, ${free}`;
};

type Choice = { option: Option; degraded_from?: string; note?: string } | { refused: string };

// D12 and D15: the first of the pool if it has a slot; when it is busy, `degrade`
// takes the next that has one and `wait` waits for it.
const choose = (pool: readonly Option[], policy: DecisionPolicy): Choice => {
  const first = pool[0];
  if (first === undefined) return { refused: 'no candidate can serve this request' };
  if (first.free) return { option: first };
  const busy = `${first.ref} is busy, ${slots_line(first)}`;
  if (policy.busy === 'wait') return { option: first, note: `${busy}; it waits up to ${policy.wait_ms ?? 0} ms for a slot` };
  const next = pool.find(({ free }) => free);
  if (next === undefined) return { refused: `every candidate is busy: ${busy}, and the rest are full` };
  return { option: next, degraded_from: first.ref, note: `${busy}; degraded to ${next.ref}` };
};

const NO_PLACEMENT: Placement = { resident: false, cold_load: false, waited_ms: 0 };

type Base = Omit<Decision, 'reasons' | 'target' | 'alternatives' | 'placement'>;

const refused = (base: Base, reasons: readonly string[], reason: string): Decision => ({
  ...base,
  reasons: [...reasons],
  target: { kind: 'refused', reason },
  alternatives: [],
  placement: NO_PLACEMENT,
});

export const place = (
  routed: RoutedProfile,
  input: RouteInput,
  catalogue: Catalogue,
  in_use: InUse,
  config: PlaceConfig,
  stamp: Stamp,
): Decision => {
  const profile = routed.kind === 'profile' ? routed.profile : null;
  const policy = policy_of(routed, input, profile, config);
  const { rung, confidence } = routed;
  const base: Base = { ...stamp, request_id: input.request_id, caller: input.caller.name, profile, rung, confidence, policy };
  // The ladder's refusal already closes its reasons.
  if (routed.kind === 'refused') return refused(base, routed.reasons, routed.reason);
  const ctx: Context = { input, catalogue, in_use, cap: cap_of(routed, input), cold_load: config.policy.cold_load };
  const reasons = [...routed.reasons];
  const options = preferred_order(options_of(wanted_of(routed, catalogue, config), ctx, reasons), policy.prefer);
  if (policy.prefer !== undefined) reasons.push(`place: prefer ${policy.prefer} ranks ${options.map(({ ref }) => ref).join(', ') || 'nothing'}`);
  reasons.push(...cold_reasons(options, ctx.cold_load));
  const pool = pool_of(options, ctx.cold_load);
  const choice = choose(pool, policy);
  if ('refused' in choice) return refused(base, [...reasons, `place: refused: ${choice.refused}`], choice.refused);
  const { option, degraded_from, note } = choice;
  return {
    ...base,
    reasons: [...reasons, ...(note === undefined ? [] : [`place: ${note}`]), `place: chose ${describe(option)}`],
    target: option.target,
    alternatives: pool.filter((each) => each !== option).map(({ target }) => target),
    placement: {
      resident: option.resident,
      cold_load: option.cold,
      waited_ms: 0,
      ...(degraded_from === undefined ? {} : { degraded_from }),
    },
  };
};

// ── taking the lease ──────────────────────────────────────────────────────────

export type Claimed = { decision: Decision; lease: Lease | null };

export type ClaimDeps = {
  leases: Leases;
  catalogue: Pick<Catalogue, 'models'>;
  config: PlaceConfig;
  // The client's request: a wait ends when it goes away.
  signal?: AbortSignal;
};

// A refusal after placement keeps the target it could not take as the first alternative.
const refuse = (decision: Decision, reason: string): Decision => ({
  ...decision,
  reasons: [...decision.reasons, `place: refused: ${reason}`],
  target: { kind: 'refused', reason },
  alternatives: decision.target.kind === 'refused' ? decision.alternatives : [decision.target, ...decision.alternatives],
});

// The lease a proxy decision forwards under (D13). A decision for the caller's
// client, or a refusal, takes none. Under `wait` it waits in the model's line up to
// `wait_ms` and records how long; past that, or under `degrade` with no slot, the
// decision is refused with the reason.
export const claim = async (decision: Decision, deps: ClaimDeps): Promise<Claimed> => {
  const { target, policy } = decision;
  if (target.kind !== 'proxy') return { decision, lease: null };
  const ref = `${target.node}/${target.model}`;
  const model = deps.catalogue.models.find((each) => each.ref === ref);
  if (model === undefined) return { decision: refuse(decision, `${ref} is no longer in the catalogue`), lease: null };
  const request: Claim = {
    request_id: decision.request_id,
    decision_id: decision.id,
    caller: decision.caller,
    node: target.node,
    model: target.model,
    slots: model.slots ?? 1,
    deadline_ms: deadline_ms_of(deps.config, decision.profile),
  };
  if (policy.wait_ms === undefined) {
    const lease = deps.leases.acquire(request);
    return lease === null ? { decision: refuse(decision, `${ref} has no free slot`), lease: null } : { decision, lease };
  }
  const waited = await deps.leases.wait(request, policy.wait_ms, deps.signal);
  const placed = { ...decision, placement: { ...decision.placement, waited_ms: waited.waited_ms } };
  if (!waited.ok) return { decision: refuse(placed, waited.reason), lease: null };
  const reasons = waited.waited_ms === 0 ? placed.reasons : [...placed.reasons, `place: waited ${waited.waited_ms} ms for a slot on ${ref}`];
  return { decision: { ...placed, reasons }, lease: waited.lease };
};
