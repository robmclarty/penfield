import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import type { FastifyReply } from 'fastify';

import type { Catalogue, CatalogueNode } from '../catalogue/index.js';
import type { Clock } from '../clock.js';
import type { Config } from '../config/index.js';
import type { Incident, LoggedOutcome } from '../log/index.js';
import { claim } from '../place/index.js';
import type { Decision, Lease, Leases, Outcome } from '../place/index.js';
import { DECISION_HEADER, error_body, send_error } from './errors.js';
import { create_usage_reader, is_event_stream, sse_event } from './sse.js';

// The streaming proxy (spec §6, §7): the only code that touches a node's socket.
// It forwards the body as it arrived with `model` rewritten and nothing else (C1),
// pipes the node's answer back as the client pulls it (C4), and ends every forward
// through one `finish`, which releases the lease once and writes the outcome on the
// decision's row. A forward ends on the last byte, or early on the first of: the
// client going away, the node going quiet past `stall_ms`, the lease's
// `deadline_at`. A stall before the first byte retries once on the next candidate;
// nothing else is retried.

const TARGET_HEADER = 'x-penfield-target';

export const RUNG_HEADER = 'x-penfield-rung';

// `last_byte_at` is stamped at most this often, so a long stream is not a write per chunk.
const TOUCH_EVERY_MS = 1_000;

// Built here, never copied from the request (C2): no inbound `Authorization` or
// `x-penfield-*` header reaches a node. `identity` keeps the node's bytes as sent.
const UPSTREAM_HEADERS = { 'content-type': 'application/json', 'accept-encoding': 'identity' };

// What of the node's response headers the client gets, beside penfield's own.
const PASSED_HEADERS = ['content-type', 'cache-control'];

// An Ollama node's url is its root; an OpenAI-compatible one's is its base, `/v1` included.
const PATHS = { chat: '/chat/completions', embeddings: '/embeddings' } as const;

export type ProxyDeps = {
  config: Pick<Config, 'profiles' | 'policy'>;
  snapshot: () => Catalogue;
  leases: Leases;
  clock: Clock;
  // `log.decision` for a retry's own row, bound to the request's RouteInput.
  log_decision: (decision: Decision) => void;
  log_outcome: (decision_id: string, outcome: LoggedOutcome) => void;
  incident: (incident: Incident) => void;
};

export type Forward = {
  // A decision with a node to forward to, and the lease `claim` took for it.
  decision: Decision;
  lease: Lease;
  // The body as it arrived, parsed once (C4).
  body: Readonly<Record<string, unknown>>;
  endpoint: keyof typeof PATHS;
};

type ProxyTarget = Extract<Decision['target'], { kind: 'proxy' }>;

type Forwardable = Decision & { target: ProxyTarget };

// Why a forward was cut short; `upstream_error` is the node failing on its own.
type Ending = 'stalled' | 'deadline' | 'client_gone';

type Chunks = AsyncIterator<Uint8Array>;

const NOTHING = (): void => undefined;

const ref_of = ({ node, model }: { node: string; model: string }): string => `${node}/${model}`;

const iso = (ms: number): string => new Date(ms).toISOString();

const is_proxy = (target: Decision['target']): target is ProxyTarget => target.kind === 'proxy';

const forwardable = (decision: Decision): Forwardable => {
  const { target } = decision;
  if (!is_proxy(target)) throw new Error(`decision ${decision.id} has no node to forward to`);
  return { ...decision, target };
};

const message_of = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
};

// ── timings ───────────────────────────────────────────────────────────────────

// The profile's own `stall_ms`, else the default.
const stall_ms_of = (policy: Config['policy'], profile: string | null): number => {
  const { stall_ms } = policy;
  const own = profile === null || profile === 'default' || profile === 'first_token_cold' || !Object.hasOwn(stall_ms, profile) ? undefined : stall_ms[profile];
  return own ?? stall_ms.default;
};

// Before the first byte of a cold load the node loads the model too, so the window
// is `first_token_cold` unless the profile's own is longer.
const first_stall_ms = (policy: Config['policy'], decision: Decision): number => {
  const stall_ms = stall_ms_of(policy, decision.profile);
  return decision.placement.cold_load ? Math.max(policy.stall_ms.first_token_cold, stall_ms) : stall_ms;
};

// ── one forward, under one lease ──────────────────────────────────────────────

type Leg = {
  decision: Forwardable;
  lease: Lease;
  signal: AbortSignal;
  // The first reason the forward was cut short, or null.
  ending: () => Ending | null;
  // Cuts the forward short as stalled `ms` from now, unless the returned function runs first.
  stall_after: (ms: number) => () => void;
  answered: (status: number, event_stream: boolean) => void;
  status: () => number | null;
  event_stream: () => boolean;
  // The node's bytes, on their way to the client.
  passed: (chunk: Uint8Array) => void;
  // The forward's one end: the lease released, the incident and the outcome written.
  finish: (outcome: Outcome) => void;
};

const stall_detail = (lease: Lease, first_byte_ms: number | null, bytes: number): string =>
  `lease ${lease.id} for ${lease.caller} (request ${lease.request_id}) went quiet ` +
  (first_byte_ms === null ? 'before its first byte' : `after ${bytes} bytes`);

const start_leg = (deps: ProxyDeps, decision: Forwardable, lease: Lease, client: AbortSignal): Leg => {
  const { clock } = deps;
  const started = clock.now();
  const controller = new AbortController();
  const usage = create_usage_reader();
  let ending: Ending | null = null;
  let finished = false;
  let event_stream = false;
  let upstream_status: number | null = null;
  let first_byte_ms: number | null = null;
  let bytes_out = 0;
  let touched = Number.NEGATIVE_INFINITY;
  let cancel_deadline = NOTHING;
  const cut = (why: Ending): void => {
    if (ending !== null || finished) return;
    ending = why;
    controller.abort(new Error(`penfield cut the forward short: ${why}`));
  };
  const on_client = (): void => cut('client_gone');
  const finish = (outcome: Outcome): void => {
    if (finished) return;
    finished = true;
    cancel_deadline();
    client.removeEventListener('abort', on_client);
    // Whatever is still open upstream closes with it.
    controller.abort();
    deps.leases.release(lease.id, outcome);
    if (outcome === 'stalled') {
      const { node, model } = decision.target;
      deps.incident({ at: iso(clock.now()), node, model, kind: 'stall', detail: stall_detail(lease, first_byte_ms, bytes_out) });
    }
    deps.log_outcome(decision.id, {
      outcome,
      first_byte_ms,
      total_ms: clock.now() - started,
      bytes_out,
      upstream_status,
      upstream_prompt_tokens: event_stream ? usage.end() : null,
    });
  };
  client.addEventListener('abort', on_client, { once: true });
  if (client.aborted) cut('client_gone');
  // D47: the deadline ends the lease itself, even under a client too slow to pull
  // the error event that ends its stream.
  cancel_deadline = clock.after(Date.parse(lease.deadline_at) - started, () => {
    cut('deadline');
    finish('deadline');
  });
  return {
    decision,
    lease,
    signal: controller.signal,
    ending: () => ending,
    stall_after: (ms) => clock.after(ms, () => cut('stalled')),
    answered: (status, is_stream) => {
      upstream_status = status;
      event_stream = is_stream;
    },
    status: () => upstream_status,
    event_stream: () => event_stream,
    passed: (chunk) => {
      const now = clock.now();
      first_byte_ms ??= now - started;
      bytes_out += chunk.byteLength;
      if (event_stream) usage.push(chunk);
      if (now - touched < TOUCH_EVERY_MS) return;
      touched = now;
      deps.leases.touch(lease.id);
    },
    finish,
  };
};

// ── up to the first byte ──────────────────────────────────────────────────────

type Opened =
  | { ok: true; response: Response; chunks: Chunks | null; first: Uint8Array | null }
  | { ok: false; why: Ending | 'upstream_error'; detail: string };

const upstream_url = (nodes: readonly CatalogueNode[], target: ProxyTarget, endpoint: Forward['endpoint']): string => {
  const node = nodes.find(({ name }) => name === target.node);
  const base = node?.url ?? null;
  if (node === undefined || base === null) throw new Error(`node ${target.node} has no url to forward to`);
  return `${base.replace(/\/+$/, '')}${node.kind === 'ollama' ? '/v1' : ''}${PATHS[endpoint]}`;
};

// The node's answer up to its first byte, inside one stall window, so a node that
// never answers and one that answers headers but no body are the same stall.
const open = async (leg: Leg, url: () => string, body: string, stall_ms: number): Promise<Opened> => {
  const cancel = leg.stall_after(stall_ms);
  try {
    const response = await fetch(url(), { method: 'POST', headers: UPSTREAM_HEADERS, body, signal: leg.signal });
    leg.answered(response.status, is_event_stream(response.headers.get('content-type')));
    const chunks = response.body?.[Symbol.asyncIterator]() ?? null;
    const read = chunks === null ? null : await chunks.next();
    return { ok: true, response, chunks, first: read === null || read.done === true ? null : read.value };
  } catch (error) {
    return { ok: false, why: leg.ending() ?? 'upstream_error', detail: message_of(error) };
  } finally {
    cancel();
  }
};

// ── after it ──────────────────────────────────────────────────────────────────

const cut_message = (leg: Leg, why: Outcome, stall_ms: number): string => {
  const ref = ref_of(leg.decision.target);
  if (why === 'stalled') return `${ref} sent nothing for ${stall_ms} ms; penfield ended the stream`;
  if (why === 'deadline') {
    const deadline_ms = Date.parse(leg.lease.deadline_at) - Date.parse(leg.lease.started_at);
    return `the forward to ${ref} ran past its deadline_ms of ${deadline_ms}; penfield ended the stream`;
  }
  return `the connection to ${ref} broke; penfield ended the stream`;
};

// An event stream cut short ends on an OpenAI error event the client can show.
const error_event = (leg: Leg, why: Outcome, stall_ms: number, request_id: string): Uint8Array => {
  const kind = why === 'upstream_error' ? 'bad_gateway' : 'gateway_timeout';
  const ids = { request_id, decision_id: leg.decision.id };
  return Buffer.from(sse_event(error_body(kind, cut_message(leg, why, stall_ms), ids)));
};

type Relay = { leg: Leg; chunks: Chunks | null; first: Uint8Array | null; stall_ms: number; request_id: string };

// Every byte the node sends, as the client pulls it (C4). The stall window runs
// only while it waits on the node, from each pull to the chunk that answers it, so
// a client slow to read is never the node's stall. Cut short once bytes have gone,
// an event stream ends on an error event and any other body is broken off, so a
// client never takes half a JSON body for the whole of one.
async function* relayed({ leg, chunks, first, stall_ms, request_id }: Relay): AsyncGenerator<Uint8Array> {
  // What it ends as if the client stops pulling.
  let outcome: Outcome = 'client_gone';
  let waiting = NOTHING;
  try {
    if (first !== null) {
      leg.passed(first);
      yield first;
    }
    waiting = leg.stall_after(stall_ms);
    for await (const chunk of { [Symbol.asyncIterator]: () => chunks ?? EMPTY }) {
      waiting();
      leg.passed(chunk);
      yield chunk;
      waiting = leg.stall_after(stall_ms);
    }
    outcome = (leg.status() ?? 200) >= 400 ? 'upstream_error' : 'ok';
  } catch (error) {
    outcome = leg.ending() ?? 'upstream_error';
    if (outcome === 'client_gone') return;
    if (!leg.event_stream()) throw error;
    yield error_event(leg, outcome, stall_ms, request_id);
  } finally {
    waiting();
    leg.finish(outcome);
  }
}

const EMPTY: Chunks = { next: () => Promise.resolve({ done: true, value: undefined }) };

const passed_headers = (response: Response, decision: Forwardable): Record<string, string> => ({
  ...Object.fromEntries(
    PASSED_HEADERS.flatMap((name) => {
      const value = response.headers.get(name);
      return value === null ? [] : [[name, value]];
    }),
  ),
  [DECISION_HEADER]: decision.id,
  [TARGET_HEADER]: ref_of(decision.target),
  [RUNG_HEADER]: decision.rung,
});

const relay = (leg: Leg, opened: Extract<Opened, { ok: true }>, stall_ms: number, reply: FastifyReply): FastifyReply => {
  const { response, chunks, first } = opened;
  const body = Readable.from(relayed({ leg, chunks, first, stall_ms, request_id: reply.request.id }), { objectMode: false });
  // A body the client left before it began never runs, so its close is the backstop.
  body.once('close', () => leg.finish(leg.ending() ?? 'client_gone'));
  return reply.code(response.status).headers(passed_headers(response, leg.decision)).send(body);
};

// ── the forward, and its one retry ────────────────────────────────────────────

// Aborts when the client's connection closes before the response has ended.
export const client_signal = (reply: FastifyReply): AbortSignal => {
  const gone = new AbortController();
  const response = reply.raw;
  if (response.destroyed || response.socket?.destroyed === true) gone.abort();
  response.once('close', () => {
    if (!response.writableFinished) gone.abort();
  });
  return gone.signal;
};

// Nothing is left to answer: Fastify is told the response is handled.
const hang_up = (reply: FastifyReply): FastifyReply => {
  reply.hijack();
  reply.raw.destroy();
  return reply;
};

type Run = { deps: ProxyDeps; forward: Forward; reply: FastifyReply; client: AbortSignal };

// D9's "choice one is stuck, use choice two": the first alternative on a node, as
// a decision of its own carrying `degraded_from`, or null when there is none.
const retry_decision = (deps: ProxyDeps, stalled: Forwardable, stall_ms: number): Decision | null => {
  const next = stalled.alternatives.find(is_proxy);
  if (next === undefined) return null;
  const from = ref_of(stalled.target);
  const model = deps.snapshot().models.find(({ ref }) => ref === ref_of(next));
  return {
    ...stalled,
    id: randomUUID(),
    at: iso(deps.clock.now()),
    reasons: [...stalled.reasons, `proxy: ${from} sent nothing for ${stall_ms} ms before its first byte; retried on ${ref_of(next)}`],
    target: next,
    alternatives: stalled.alternatives.filter((each) => each !== next),
    placement: { resident: model?.residency === 'resident', cold_load: model?.residency === 'cold', waited_ms: 0, degraded_from: from },
  };
};

const stalled_message = (stalled: Forwardable, stall_ms: number): string =>
  `${ref_of(stalled.target)} sent nothing for ${stall_ms} ms`;

// Claimed the way the first was (D15), and logged whether or not it gets a slot.
const retry = async (run: Run, stalled: Forwardable, stall_ms: number): Promise<FastifyReply> => {
  const { deps, reply } = run;
  const decision = retry_decision(deps, stalled, stall_ms);
  if (decision === null) {
    return send_error(reply, 'gateway_timeout', `${stalled_message(stalled, stall_ms)}, and no other candidate is on a node`, stalled.id);
  }
  const claimed = await claim(decision, { leases: deps.leases, catalogue: deps.snapshot(), config: deps.config, signal: run.client });
  deps.log_decision(claimed.decision);
  // A lease taken as the client left is the leg's to release, as client_gone.
  if (claimed.lease === null) {
    if (run.client.aborted) return hang_up(reply);
    const reason = claimed.decision.target.kind === 'refused' ? claimed.decision.target.reason : 'it took no lease';
    return send_error(reply, 'gateway_timeout', `${stalled_message(stalled, stall_ms)}, and the retry was refused: ${reason}`, claimed.decision.id);
  }
  return forward_once({ ...run, forward: { ...run.forward, decision: claimed.decision, lease: claimed.lease } }, true);
};

const failed_message = (decision: Forwardable, why: Exclude<Opened, { ok: true }>, stall_ms: number, lease: Lease): string => {
  if (why.why === 'stalled') return stalled_message(decision, stall_ms);
  if (why.why === 'deadline') {
    const deadline_ms = Date.parse(lease.deadline_at) - Date.parse(lease.started_at);
    return `the forward to ${ref_of(decision.target)} ran past its deadline_ms of ${deadline_ms}`;
  }
  return `penfield could not reach ${ref_of(decision.target)}: ${why.detail}`;
};

const forward_once = async (run: Run, retried: boolean): Promise<FastifyReply> => {
  const { deps, forward, reply } = run;
  const decision = forwardable(forward.decision);
  const leg = start_leg(deps, decision, forward.lease, run.client);
  const first_ms = first_stall_ms(deps.config.policy, decision);
  const url = (): string => upstream_url(deps.snapshot().nodes, decision.target, forward.endpoint);
  const opened = await open(leg, url, JSON.stringify({ ...forward.body, model: decision.target.model }), first_ms);
  if (opened.ok) return relay(leg, opened, stall_ms_of(deps.config.policy, decision.profile), reply);
  leg.finish(opened.why);
  if (opened.why === 'client_gone') return hang_up(reply);
  if (opened.why === 'stalled' && !retried) return retry(run, decision, first_ms);
  const kind = opened.why === 'upstream_error' ? 'bad_gateway' : 'gateway_timeout';
  return send_error(reply, kind, failed_message(decision, opened, first_ms, forward.lease), decision.id);
};

// `proxy(decision, request, reply, lease)` of spec §7: the forward a claimed
// decision makes, answered on `reply`.
export const proxy = (deps: ProxyDeps, forward: Forward, reply: FastifyReply): Promise<FastifyReply> =>
  forward_once({ deps, forward, reply, client: client_signal(reply) }, false);
