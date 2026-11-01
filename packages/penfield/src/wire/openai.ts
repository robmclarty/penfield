import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Catalogue } from '../catalogue/index.js';
import type { Config } from '../config/index.js';
import { claim } from '../place/index.js';
import type { Decision } from '../place/index.js';
import type { InputContext } from '../route/index.js';
import type { Caller } from './auth.js';
import { hint_completion, hint_events } from './claude_hint.js';
import { DECISION_HEADER, send_error } from './errors.js';
import { bar_of } from './policy.js';
import { client_signal, proxy, RUNG_HEADER } from './proxy.js';
import type { ProxyDeps } from './proxy.js';
import { decide } from './route_endpoint.js';
import type { Decided, RouteDeps } from './route_endpoint.js';

// The OpenAI endpoints (spec §5.4).

// ── GET /v1/models ────────────────────────────────────────────────────────────

// `auto` and the other aliases, the profile names, then the catalogue's models
// this caller may reach, in OpenAI's list shape. A model is listed by its tag, as
// a client sends it, and a decision node's as `node/model` (`claude/opus`); a tag
// two nodes share is listed as `node/tag` on both. Each entry carries a `penfield`
// object saying what it is.

type Alias = Config['aliases'][string];

type Penfield =
  | ({ kind: 'alias' } & Alias)
  | { kind: 'profile' }
  | {
      kind: 'model';
      node: string;
      ref: string;
      // null when the node cannot say.
      resident: boolean | null;
      pinned: boolean;
      profiles: string[];
    };

type Entry = { id: string; object: 'model'; created: number; owned_by: string; penfield: Penfield };

export type ModelList = { object: 'list'; data: Entry[] };

const entry = (id: string, owned_by: string, penfield: Penfield): Entry => ({
  id,
  object: 'model',
  created: 0,
  owned_by,
  penfield,
});

const model_entries = (catalogue: Catalogue, caller: Caller): Entry[] => {
  const nodes = new Map(catalogue.nodes.map((node) => [node.name, node]));
  const visible = catalogue.models.flatMap((model) => {
    const node = nodes.get(model.node);
    // Over the caller's max_privacy (D10), or outside its `models:` list (D38), is not listed.
    return node?.enabled === true && bar_of(model, node, caller) === null ? [{ model, decision: node.kind === 'claude_decision' }] : [];
  });
  const tags = new Map<string, number>();
  for (const { model, decision } of visible) if (!decision) tags.set(model.id, (tags.get(model.id) ?? 0) + 1);
  return visible.map(({ model, decision }) =>
    entry(decision || (tags.get(model.id) ?? 0) > 1 ? model.ref : model.id, model.node, {
      kind: 'model',
      node: model.node,
      ref: model.ref,
      resident: model.residency === 'unknown' ? null : model.residency === 'resident',
      pinned: model.pinned,
      profiles: model.profiles,
    }),
  );
};

export const models_list = (catalogue: Catalogue, config: Config, caller: Caller): ModelList => {
  const aliases = Object.entries(config.aliases).toSorted(([a], [b]) => Number(b === 'auto') - Number(a === 'auto'));
  return {
    object: 'list',
    data: [
      ...aliases.map(([id, alias]) => entry(id, 'penfield', { kind: 'alias', ...alias })),
      ...Object.keys(config.profiles).map((id) => entry(id, 'penfield', { kind: 'profile' })),
      ...model_entries(catalogue, caller),
    ],
  };
};

// ── POST /v1/chat/completions and /v1/embeddings ──────────────────────────────

// The request is decided the way `/route` decides it, claimed under its busy
// policy (D15), and forwarded by the proxy, which pipes the node's answer back
// with the decision's headers. A Claude decision has no node to go to, so the
// caller's policy says what it becomes (D19). Each request logs one decision, the
// one carried out, and its row's outcome says how it ended.

export type ChatDeps = RouteDeps & Pick<ProxyDeps, 'leases' | 'log_outcome' | 'incident'>;

type Endpoint = InputContext['endpoint'];

type Target = Decision['target'];

type ClaudeTarget = Extract<Target, { kind: 'claude_decision' }>;

type ProxyTarget = Extract<Target, { kind: 'proxy' }>;

type Claimed = Awaited<ReturnType<typeof claim>>;

type Body = Readonly<Record<string, unknown>>;

const DOWNGRADED_HEADER = 'x-penfield-downgraded';

// The router read the body as a JSON object before anything here does.
const is_body = (value: unknown): value is Body => typeof value === 'object' && value !== null && !Array.isArray(value);

const is_proxy = (target: Target): target is ProxyTarget => target.kind === 'proxy';

// The caller's own word, else the house's. `decision` names a client that runs the
// decision itself, which it can do only from `/route`, so here the house's applies.
const claude_mode = (caller: Caller, config: Config): Config['policy']['on_claude_for_proxy'] =>
  caller.claude === undefined || caller.claude === 'decision' ? config.policy.on_claude_for_proxy : caller.claude;

// A refusal leaves as the error it is: the policy's is a 403 (C11), a model the
// gateway does not know is a 404, any other refusal of the ladder's a 400, and one
// made placing or claiming, when no candidate can take the request now, a 503.
const send_refusal = (reply: FastifyReply, decided: Extract<Decided, { ok: true }>, refused: Decision): FastifyReply => {
  const reason = refused.target.kind === 'refused' ? refused.target.reason : 'it took no lease';
  if (decided.forbidden) return send_error(reply, 'forbidden', reason, refused.id);
  if (decided.routed.kind !== 'refused') return send_error(reply, 'unavailable', reason, refused.id);
  return send_error(reply, decided.routed.rung === 'explicit' ? 'model_not_found' : 'bad_request', reason, refused.id);
};

// How the claude node names the target in a decision's reasons (`claude/opus`).
const claude_ref = (catalogue: Catalogue, { model }: ClaudeTarget): string => {
  const decision_nodes = new Set(catalogue.nodes.filter(({ kind }) => kind === 'claude_decision').map(({ name }) => name));
  return catalogue.models.find(({ node, id }) => decision_nodes.has(node) && id === model)?.ref ?? model;
};

// One request on its way through the handler.
type Handled = {
  deps: ChatDeps;
  reply: FastifyReply;
  decided: Extract<Decided, { ok: true }>;
  body: Body;
  endpoint: Endpoint;
  // When the handler took it, for the outcome's `total_ms`.
  started: number;
  // Closes when the client goes away, which ends a wait for a slot.
  client: AbortSignal;
};

// An outcome no node wrote: penfield answered, or refused, on its own.
const close_row = ({ deps, started }: Handled, decision: Decision, outcome: 'hinted' | 'refused', bytes_out: number): void =>
  deps.log_outcome(decision.id, { outcome, first_byte_ms: null, total_ms: deps.clock.now() - started, bytes_out, upstream_status: null, upstream_prompt_tokens: null });

const log = ({ deps, decided }: Handled, decision: Decision): void => deps.log_decision(decision, decided.input);

const claim_deps = ({ deps, client }: Handled): Parameters<typeof claim>[1] => ({
  leases: deps.leases,
  catalogue: deps.snapshot(),
  config: deps.config,
  signal: client,
});

// `hint`: one assistant message naming the model and effort, as the request asked
// for it. An embeddings request has no message to carry it, so it is refused.
const send_hint = (handled: Handled, decision: Decision, target: ClaudeTarget): FastifyReply => {
  const { deps, reply, body, decided } = handled;
  log(handled, decision);
  if (handled.endpoint === 'embeddings') {
    close_row(handled, decision, 'refused', 0);
    const named = `${claude_ref(deps.snapshot(), target)} at ${target.effort}`;
    return send_error(reply, 'bad_request', `penfield decided ${named}, a Claude decision, which answers no embeddings request`, decision.id);
  }
  const hint = { decision_id: decision.id, model: decided.input.model, profile: decision.profile, target, created: Math.floor(deps.clock.now() / 1000) };
  const streamed = body['stream'] === true;
  const options = body['stream_options'];
  const usage = is_body(options) && options['include_usage'] === true;
  const text = streamed ? hint_events(hint, usage) : hint_completion(hint);
  close_row(handled, decision, 'hinted', Buffer.byteLength(text));
  return reply
    .headers({
      [DECISION_HEADER]: decision.id,
      [RUNG_HEADER]: decision.rung,
      'content-type': streamed ? 'text/event-stream' : 'application/json; charset=utf-8',
      ...(streamed ? { 'cache-control': 'no-cache' } : {}),
    })
    .send(text);
};

// `api_key` runs Claude through an API key, which arrives in Stage D; until then it
// is an error saying so, never a local answer in its place (C11).
const send_api_key = (handled: Handled, decision: Decision, target: ClaudeTarget): FastifyReply => {
  log(handled, decision);
  close_row(handled, decision, 'refused', 0);
  const named = `${claude_ref(handled.deps.snapshot(), target)} at ${target.effort}`;
  const message =
    `penfield decided ${named}, and caller ${decision.caller}'s on_claude_for_proxy is api_key, ` +
    'which runs Claude through an API key from Stage D; until then set it to hint or downgrade';
  return send_error(handled.reply, 'not_implemented', message, decision.id);
};

// `downgrade`: the best alternative on a node takes the Claude target's place,
// which goes first among the alternatives and is named in `degraded_from`.
const downgrade_to = (decision: Decision, next: ProxyTarget, from: string, catalogue: Catalogue): Decision => {
  const ref = `${next.node}/${next.model}`;
  const model = catalogue.models.find((each) => each.ref === ref);
  return {
    ...decision,
    reasons: [...decision.reasons, `wire: downgraded to ${ref}`],
    target: next,
    alternatives: decision.alternatives.filter((each) => each !== next),
    placement: { resident: model?.residency === 'resident', cold_load: model?.residency === 'cold', waited_ms: 0, degraded_from: from },
  };
};

// The alternatives on a node, in rank order, each claimed in turn: under `degrade`
// a busy one gives way to the next, and under `wait` the first waits for its slot.
const downgrade = async (handled: Handled, decision: Decision, target: ClaudeTarget, from: string): Promise<Claimed> => {
  const catalogue = handled.deps.snapshot();
  const said = `wire: caller ${decision.caller}'s on_claude_for_proxy is downgrade, so ${from} at ${target.effort} gives way to the best alternative on a node`;
  let base: Decision = { ...decision, reasons: [...decision.reasons, said], alternatives: [target, ...decision.alternatives] };
  for (const next of base.alternatives.filter(is_proxy)) {
    const claimed = await claim(downgrade_to(base, next, from, catalogue), claim_deps(handled));
    if (claimed.lease !== null || decision.policy.busy === 'wait') return claimed;
    base = { ...base, reasons: claimed.decision.reasons };
  }
  const reason = `no alternative on a node can take the place of ${from}`;
  return { decision: { ...base, reasons: [...base.reasons, `wire: refused: ${reason}`], target: { kind: 'refused', reason } }, lease: null };
};

// `downgraded` names the Claude target a downgrade replaced, for its header.
const forward = (handled: Handled, { decision, lease }: Claimed, downgraded?: string): Promise<FastifyReply> | FastifyReply => {
  const { deps, reply, decided, body, endpoint } = handled;
  log(handled, decision);
  if (lease === null) return send_refusal(reply, decided, decision);
  if (downgraded !== undefined) void reply.header(DOWNGRADED_HEADER, downgraded);
  const proxied: ProxyDeps = { ...deps, log_decision: (each) => log(handled, each) };
  return proxy(proxied, { decision, lease, body, endpoint }, reply);
};

export const post_openai = async (deps: ChatDeps, caller: Caller, request: FastifyRequest, reply: FastifyReply, endpoint: Endpoint): Promise<FastifyReply> => {
  const started = deps.clock.now();
  const decided = await decide(deps, caller, request, endpoint);
  const { body } = request;
  if (!decided.ok || !is_body(body)) {
    const reason = decided.ok ? 'the body is not a JSON object' : decided.reason;
    return send_error(reply, 'bad_request', `penfield cannot route this body: ${reason}`);
  }
  const { decision } = decided;
  const { target } = decision;
  const handled: Handled = { deps, reply, decided, body, endpoint, started, client: client_signal(reply) };
  if (target.kind === 'refused') {
    log(handled, decision);
    return send_refusal(reply, decided, decision);
  }
  if (target.kind === 'proxy') return forward(handled, await claim(decision, claim_deps(handled)));
  const mode = claude_mode(caller, deps.config);
  if (mode === 'hint') return send_hint(handled, decision, target);
  if (mode === 'api_key') return send_api_key(handled, decision, target);
  const from = claude_ref(deps.snapshot(), target);
  return forward(handled, await downgrade(handled, decision, target, from), from);
};
