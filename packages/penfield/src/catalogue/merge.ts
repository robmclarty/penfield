import type { Config, Effort, Format, NodeConfig, Privacy } from '../config/index.js';
import { compile_globs, first_match } from './glob.js';
import type { Compiled } from './glob.js';
import type { Discovery, Residency } from './types.js';

// The catalogue's snapshot, and the pure merge that builds it from the config, what
// discovery last saw and the breaker states: every node, every model with its
// `models:` overlay, pin and slots, and a warning for each profile candidate no
// node has (D41). Plain data, read by everything that places or lists a model.

export type BreakerState = 'closed' | 'open' | 'half_open';

type Overlay = Config['models'][string];

export type CatalogueModel = {
  // `node/id`: how a candidate, a target and `/v1/models` name it.
  ref: string;
  id: string;
  node: string;
  residency: Residency;
  pinned: boolean;
  // Leases the model takes at once; null on a node nothing runs on.
  slots: number | null;
  profiles: string[];
  speed: Overlay['speed'] | null;
  quality: Overlay['quality'] | null;
  cost: Overlay['cost'] | null;
  // What the file says the model takes, beside what the node reports the loaded
  // instance runs with (Q1).
  context: number | null;
  context_length: number | null;
  size_bytes: number | null;
  // The `models:` key that matched, or null.
  overlay: string | null;
  breaker: BreakerState;
};

export type CatalogueNode = {
  name: string;
  kind: NodeConfig['kind'];
  privacy: Privacy;
  url: string | null;
  formats: Format[];
  // What a decision node offers; empty elsewhere.
  efforts: Effort[];
  // The memory its models may use and the most it keeps loaded, for placement's
  // cold-load fit (D44, D46); null when the file leaves them out.
  memory_gb: number | null;
  max_loaded: number | null;
  enabled: boolean;
  // `unknown` until the first discovery; a decision node is never contacted, so it is up.
  state: 'up' | 'down' | 'unknown';
  reason: string | null;
  discovered_at: string | null;
  breaker: BreakerState;
};

export type CandidateWarning = { kind: 'candidate_missing'; profile: string; candidate: string; message: string };

export type Catalogue = { nodes: CatalogueNode[]; models: CatalogueModel[]; warnings: CandidateWarning[] };

// What discovery last saw of a node, and when.
export type Seen = { discovery: Discovery; at: string };

export type Breakers = { nodes: Record<string, BreakerState>; models: Record<string, BreakerState> };

export type MergeInput = { seen: Readonly<Record<string, Seen>>; breakers: Breakers };

// ── names ─────────────────────────────────────────────────────────────────────

const LATEST = ':latest';

// Ollama lists `nomic-embed-text:latest` for what the file calls `nomic-embed-text`.
const ids_of = (id: string): string[] => (id.endsWith(LATEST) ? [id, id.slice(0, -LATEST.length)] : [id]);

// Whether `wanted` (a bare model id, or `node/model` when it holds a `/`) names the
// model. The text before the first `/` is always a node, as at load.
export const names_model = (wanted: string, model: { node: string; id: string }): boolean =>
  wanted.includes('/')
    ? ids_of(model.id).some((id) => `${model.node}/${id}` === wanted)
    : ids_of(model.id).includes(wanted);

export type Candidate = { node: string | null; model: string; effort: string | null };

// `node/model@effort`, `model@effort` or `model`; the config checked each at load.
export const parse_candidate = (text: string): Candidate => {
  const at = text.lastIndexOf('@');
  const body = at === -1 ? text : text.slice(0, at);
  const effort = at === -1 ? null : text.slice(at + 1);
  const slash = body.indexOf('/');
  return slash === -1
    ? { node: null, model: body, effort }
    : { node: body.slice(0, slash), model: body.slice(slash + 1), effort };
};

const wanted_of = ({ node, model }: Candidate): string => (node === null ? model : `${node}/${model}`);

// The catalogue's models a candidate names, in node order.
export const candidate_models = (catalogue: Pick<Catalogue, 'models'>, text: string): CatalogueModel[] => {
  const wanted = wanted_of(parse_candidate(text));
  return catalogue.models.filter((model) => names_model(wanted, model));
};

// ── nodes and models ──────────────────────────────────────────────────────────

type Listed = { id: string; residency: Residency; size_bytes: number | null; context_length: number | null };

const hand_listed = (ids: readonly string[]): Listed[] =>
  ids.map((id) => ({ id, residency: 'unknown', size_bytes: null, context_length: null }));

// The models a node has, or undefined while a discovering node has not been read.
const listed = (entry: NodeConfig, seen: Seen | undefined): Listed[] | undefined => {
  if (entry.kind === 'claude_decision' || entry.kind === 'anthropic_api' || !entry.discover) {
    return hand_listed(entry.models);
  }
  return seen?.discovery.models;
};

const slots_of = (entry: NodeConfig, model: { node: string; id: string }): number | null => {
  if (entry.kind !== 'ollama' && entry.kind !== 'openai_compatible') return null;
  const own = Object.entries(entry.slots).find(([key]) => key !== 'default' && names_model(key, model));
  return own?.[1] ?? entry.slots.default;
};

const pinned_on = (entry: NodeConfig, model: { node: string; id: string }): boolean =>
  (entry.kind === 'ollama' || entry.kind === 'openai_compatible') &&
  entry.pinned.some((pin) => names_model(pin, model));

const to_model = (
  node: string,
  entry: NodeConfig,
  item: Listed,
  overlays: readonly Compiled<Overlay>[],
  breakers: Breakers,
): CatalogueModel => {
  const key = { node, id: item.id };
  const ref = `${node}/${item.id}`;
  // A key matches a model's id or its `node/id`.
  const match = first_match(overlays, ids_of(item.id).flatMap((id) => [id, `${node}/${id}`]));
  return {
    ref,
    id: item.id,
    node,
    residency: item.residency,
    pinned: pinned_on(entry, key),
    slots: slots_of(entry, key),
    profiles: [...(match?.value.profiles ?? [])],
    speed: match?.value.speed ?? null,
    quality: match?.value.quality ?? null,
    cost: match?.value.cost ?? null,
    context: match?.value.context ?? null,
    context_length: item.context_length,
    size_bytes: item.size_bytes,
    overlay: match?.key ?? null,
    breaker: breakers.models[ref] ?? 'closed',
  };
};

const state_of = (entry: NodeConfig, seen: Seen | undefined): Pick<CatalogueNode, 'state' | 'reason' | 'discovered_at'> => {
  if (entry.kind === 'claude_decision') return { state: 'up', reason: null, discovered_at: null };
  if (seen === undefined) return { state: 'unknown', reason: null, discovered_at: null };
  const { discovery, at } = seen;
  return discovery.state === 'up'
    ? { state: 'up', reason: null, discovered_at: at }
    : { state: 'down', reason: discovery.reason, discovered_at: at };
};

const to_node = (name: string, entry: NodeConfig, seen: Seen | undefined, breakers: Breakers): CatalogueNode => {
  const served = entry.kind === 'ollama' || entry.kind === 'openai_compatible';
  return {
    name,
    kind: entry.kind,
    privacy: entry.privacy,
    url: served ? entry.url : null,
    formats: entry.kind === 'claude_decision' ? [] : [...entry.formats],
    efforts: entry.kind === 'claude_decision' ? [...entry.efforts] : [],
    memory_gb: served ? (entry.memory_gb ?? null) : null,
    max_loaded: served ? (entry.max_loaded ?? null) : null,
    enabled: entry.kind === 'anthropic_api' ? entry.enabled : true,
    ...state_of(entry, seen),
    breaker: breakers.nodes[name] ?? 'closed',
  };
};

// ── warnings (D41) ────────────────────────────────────────────────────────────

const missing_message = (candidate: Candidate, down: readonly CatalogueNode[]): string => {
  const reasons = down.map(({ name, reason }) => `${name} is down: ${reason ?? 'no reason given'}`);
  const base =
    candidate.node === null
      ? `no node has "${candidate.model}"`
      : `node "${candidate.node}" has no model "${candidate.model}"`;
  return reasons.length === 0 ? base : `${base} (${reasons.join('; ')})`;
};

// A candidate is missing once every node that could have it has been read and
// none does; before a discovering node's first read it may yet appear.
const warnings_of = (
  config: Config,
  nodes: readonly CatalogueNode[],
  models: readonly CatalogueModel[],
  known: ReadonlySet<string>,
): CandidateWarning[] =>
  Object.entries(config.profiles).flatMap(([profile, { candidates }]) =>
    candidates.flatMap((text) => {
      const candidate = parse_candidate(text);
      const wanted = wanted_of(candidate);
      if (models.some((model) => names_model(wanted, model))) return [];
      const could = nodes.filter(({ name }) => candidate.node === null || candidate.node === name);
      if (could.some(({ name }) => !known.has(name))) return [];
      const down = could.filter(({ state }) => state === 'down');
      return [{ kind: 'candidate_missing' as const, profile, candidate: text, message: missing_message(candidate, down) }];
    }),
  );

export const merge_catalogue = (config: Config, { seen, breakers }: MergeInput): Catalogue => {
  const overlays = compile_globs(config.models);
  const entries = Object.entries(config.nodes);
  const nodes = entries.map(([name, entry]) => to_node(name, entry, seen[name], breakers));
  const lists = entries.map(([name, entry]) => ({ name, entry, items: listed(entry, seen[name]) }));
  const models = lists.flatMap(({ name, entry, items }) =>
    (items ?? []).map((item) => to_model(name, entry, item, overlays, breakers)),
  );
  const known = new Set(lists.filter(({ items }) => items !== undefined).map(({ name }) => name));
  return { nodes, models, warnings: warnings_of(config, nodes, models, known) };
};
