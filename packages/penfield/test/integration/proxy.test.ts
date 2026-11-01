import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { fastify } from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { create_catalogue, discover_ollama } from '../../src/catalogue/index.js';
import { system_clock } from '../../src/clock.js';
import type { Clock } from '../../src/clock.js';
import { load_config } from '../../src/config/index.js';
import { log_decision, log_incident, log_outcome, open_db, read_decisions } from '../../src/log/index.js';
import type { Db, DecisionRow } from '../../src/log/index.js';
import { claim, create_leases, create_reaper } from '../../src/place/index.js';
import type { Decision, Leases } from '../../src/place/index.js';
import { proxy } from '../../src/wire/index.js';
import type { ProxyDeps } from '../../src/wire/index.js';
import { fake_clock } from '../helpers/fake_clock.js';
import { start_fake_ollama } from '../helpers/fake_ollama.js';
import type { FakeOllama, FakeOllamaState } from '../helpers/fake_ollama.js';
import { EXAMPLE } from '../helpers/run_serve.js';

// Plan step 13 against the fake Ollama: the proxy behind a bare Fastify route that
// claims a hand-made decision the way placement would, so every path of the pipe,
// its abort and its one release is driven here before plan step 14 wires the
// endpoints. The house file supplies the policy: chat's `stall_ms` of 30 s,
// `first_token_cold` of 90 s, a `deadline_ms` of 600 s.

const QWEN35 = 'qwen3.6:35b-mlx';
const QWEN27 = 'qwen3.8:27b-mlx';
const EMBED = 'nomic-embed-text:latest';

const MB = 1024 * 1024;

const on_searle = (model: string) => ({ kind: 'proxy', node: 'searle', model, format: 'openai' }) as const;

const SONNET = { kind: 'claude_decision', model: 'sonnet', effort: 'low' } as const;

const CHAT = { model: 'auto', messages: [{ role: 'user', content: 'what is the capital of France?' }], stream: true };

// What a decision row keeps of the request; the proxy reads none of it.
const INPUT = { text: '', system_text: '', format: 'openai', caller: { keep_prompts: false } };

type Choice = { model: string; alternatives: Decision['alternatives']; policy?: Decision['policy'] };

type Options = {
  clock?: Clock;
  ollama?: Partial<FakeOllamaState>;
  // An edit to the house file's text.
  config?: (text: string) => string;
  reaper_every_ms?: number;
};

type Harness = {
  url: string;
  ollama: FakeOllama;
  db: Db;
  // The proxy's leases, every release counted by lease id.
  leases: Leases;
  releases: Map<string, number>;
  // What the next request is decided to.
  choice: Choice;
  // Oldest first.
  rows: () => DecisionRow[];
  close: () => Promise<void>;
};

let open_harnesses: Harness[] = [];

const decided = (clock: Clock, { model, alternatives, policy = { max_privacy: 'cloud', busy: 'degrade' } }: Choice, request_id: string): Decision => ({
  id: randomUUID(),
  request_id,
  at: new Date(clock.now()).toISOString(),
  caller: 'rob',
  profile: model === EMBED ? 'embed' : 'chat',
  rung: 'rule',
  confidence: 1,
  reasons: ['rule 8 (chat): chat', `place: chose searle/${model}, resident`],
  target: on_searle(model),
  alternatives,
  placement: { resident: true, cold_load: false, waited_ms: 0 },
  policy,
});

const counting = (leases: Leases, releases: Map<string, number>): Leases => ({
  ...leases,
  release: (id, outcome) => {
    releases.set(id, (releases.get(id) ?? 0) + 1);
    return leases.release(id, outcome);
  },
});

const harness = async ({ clock = system_clock, ollama: initial = {}, config: edit = (text) => text, reaper_every_ms }: Options = {}): Promise<Harness> => {
  const dir = mkdtempSync(join(tmpdir(), 'penfield-proxy-'));
  const ollama = await start_fake_ollama({ tags: [QWEN35, QWEN27, EMBED], resident: [QWEN35], ...initial });
  const loaded = load_config(edit(readFileSync(EXAMPLE, 'utf8').replace('http://192.168.1.90:11434', ollama.url)));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  const { config } = loaded;
  const catalogue = create_catalogue(config);
  catalogue.record_discovery(await discover_ollama({ name: 'searle', url: ollama.url, timeout_ms: 2_000 }), new Date(clock.now()).toISOString());
  const db = open_db(join(dir, 'state'));
  const releases = new Map<string, number>();
  const leases = counting(create_leases({ db, clock }), releases);
  const incident = (each: Parameters<ProxyDeps['incident']>[0]): void => void log_incident(db, each);
  const reaper = reaper_every_ms === undefined ? null : create_reaper({ leases, clock, instance_id: db.instance_id, incident, every_ms: reaper_every_ms });
  reaper?.start();
  const deps: ProxyDeps = {
    config,
    snapshot: catalogue.snapshot,
    leases,
    clock,
    log_decision: (decision) => log_decision(db, decision, INPUT),
    log_outcome: (id, outcome) => log_outcome(db, id, outcome),
    incident,
  };
  const app = fastify({ logger: false });
  const h: Harness = {
    url: '',
    ollama,
    db,
    leases,
    releases,
    choice: { model: QWEN35, alternatives: [on_searle(QWEN27), SONNET] },
    rows: () => read_decisions(db, { limit: 100 }).toReversed(),
    close: async () => {
      reaper?.stop();
      await app.close();
      await ollama.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  for (const [path, endpoint] of [['/v1/chat/completions', 'chat'], ['/v1/embeddings', 'embeddings']] as const) {
    app.post(path, async (request, reply) => {
      const claimed = await claim(decided(clock, h.choice, request.id), { leases, catalogue: catalogue.snapshot(), config });
      deps.log_decision(claimed.decision);
      if (claimed.lease === null) return reply.code(503).send(claimed.decision.target);
      return proxy(deps, { decision: claimed.decision, lease: claimed.lease, body: request.body as Record<string, unknown>, endpoint }, reply);
    });
  }
  h.url = await app.listen({ host: '127.0.0.1', port: 0 });
  open_harnesses.push(h);
  return h;
};

// Every path ends with no lease active and each one released exactly once.
afterEach(async () => {
  for (const h of open_harnesses) {
    await vi.waitFor(() => expect(h.db.all("select id from leases where state = 'active'")).toEqual([]));
    const ids = h.db.all('select id from leases').map(({ id }) => String(id));
    expect(ids.map((id) => [id, h.releases.get(id)])).toEqual(ids.map((id) => [id, 1]));
    await h.close();
  }
  open_harnesses = [];
});

const post = (h: Harness, body: unknown, more: { headers?: Record<string, string>; signal?: AbortSignal; path?: string } = {}): Promise<Response> =>
  fetch(`${h.url}${more.path ?? '/v1/chat/completions'}`, {
    method: 'POST',
    headers: { authorization: 'Bearer tok_rob_5f2a9c1e', 'content-type': 'application/json', ...more.headers },
    body: JSON.stringify(body),
    ...(more.signal === undefined ? {} : { signal: more.signal }),
  });

const events = (text: string): string[] => text.split('\n\n').filter((each) => each !== '');

// Reads the stream until it holds `count` events, and hands back the reader with the text so far.
const read_events = async (response: Response, count: number): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; text: string }> => {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('no body');
  const decoder = new TextDecoder();
  let text = '';
  while (events(text).length < count || !text.endsWith('\n\n')) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`the stream ended after ${events(text).length} events`);
    text += decoder.decode(value, { stream: true });
  }
  return { reader, text };
};

const rest_of = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const decoder = new TextDecoder();
  let text = '';
  for (let read = await reader.read(); !read.done; read = await reader.read()) text += decoder.decode(read.value, { stream: true });
  return text;
};

const error_of = (event: string | undefined): unknown => JSON.parse((event ?? '').replace(/^data: /, ''));

const incidents = (db: Db): unknown[] => db.all('select node, model, kind from incidents order by rowid');

const lease_states = (db: Db): unknown[] => db.all('select model, state from leases order by rowid');

// The V8 heap and the buffers it points at, once nothing unreachable is left: a
// buffer's memory is freed only by the collection after the one that finds it dead.
setFlagsFromString('--expose-gc');
const collect = runInNewContext('gc') as () => void;
const heap = (): number => {
  collect();
  collect();
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return heapUsed + arrayBuffers;
};

describe('the pipe', () => {
  test('a 50 k-chunk stream reaches the client as the node makes it, with heap growth under 32 MB (C4)', async () => {
    const h = await harness({ ollama: { chunks: 50_000, chunk_text: 'x'.repeat(1_000) } });
    const before = heap();
    const response = await post(h, CHAT);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('no body');
    const decoder = new TextDecoder();
    let received = 0;
    let sent_at_first: number | null = null;
    let peak = 0;
    let sample_at = 10 * MB;
    let tail = '';
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      sent_at_first ??= h.ollama.streams[0]?.sent ?? 0;
      received += read.value.byteLength;
      tail = (tail + decoder.decode(read.value, { stream: true })).slice(-64);
      if (received < sample_at) continue;
      peak = Math.max(peak, heap() - before);
      sample_at += 10 * MB;
    }
    expect(received).toBeGreaterThan(50 * MB);
    expect(sent_at_first).toBeLessThan(50_000);
    expect(peak).toBeLessThan(32 * MB);
    expect(tail.endsWith('data: [DONE]\n\n')).toBe(true);
    expect(h.ollama.streams).toEqual([{ model: QWEN35, sent: 50_000, finished: true, closed_at: null }]);
    expect(h.rows()).toMatchObject([{ outcome: 'ok', bytes_out: received, upstream_status: 200 }]);
  }, 60_000);

  test('the body goes up as it came except `model`, with no inbound Authorization or x-penfield-* header (C1, C2)', async () => {
    const h = await harness();
    const body = {
      ...CHAT,
      model: 'auto',
      temperature: 0.2,
      stream_options: { include_usage: true },
      tools: [{ type: 'function', function: { name: 'look', parameters: { type: 'object', properties: {} } } }],
      metadata: { penfield: { profile: 'chat' } },
    };
    const response = await post(h, body, { headers: { 'x-penfield-profile': 'chat', 'x-penfield-max-privacy': 'lan' } });
    const text = await response.text();
    const [row] = h.rows();
    const upstream = h.ollama.requests.find(({ url }) => url === '/v1/chat/completions');
    expect(upstream?.body).toBe(JSON.stringify({ ...body, model: QWEN35 }));
    expect(Object.keys(upstream?.headers ?? {}).filter((name) => name === 'authorization' || name.startsWith('x-penfield-'))).toEqual([]);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-penfield-decision')).toBe(row?.id);
    expect(response.headers.get('x-penfield-target')).toBe(`searle/${QWEN35}`);
    expect(response.headers.get('x-penfield-rung')).toBe('rule');
    expect(events(text).at(-1)).toBe('data: [DONE]');
    expect(row).toMatchObject({
      outcome: 'ok',
      bytes_out: Buffer.byteLength(text),
      upstream_status: 200,
      // The last chunk's `usage.prompt_tokens`, as searle counted it.
      upstream_prompt_tokens: 18,
    });
  });

  test('a stream asked for without include_usage logs no prompt count; first_byte_ms and total_ms run from dispatch', async () => {
    const h = await harness({ ollama: { first_byte_delay_ms: 60, chunk_delay_ms: 2 } });
    const text = await (await post(h, CHAT)).text();
    const [row] = h.rows();
    expect(text).not.toContain('prompt_tokens');
    expect(row).toMatchObject({ outcome: 'ok', upstream_prompt_tokens: null, upstream_status: 200 });
    expect(row?.first_byte_ms).toBeGreaterThanOrEqual(50);
    expect(row?.total_ms).toBeGreaterThan(row?.first_byte_ms ?? 0);
    expect(h.db.get('select last_byte_at from leases')?.['last_byte_at']).toEqual(expect.any(String));
  });

  test("an embeddings body passes whole from the node's /v1/embeddings", async () => {
    const h = await harness();
    h.choice = { model: EMBED, alternatives: [] };
    const response = await post(h, { model: 'auto', input: 'hello' }, { path: '/v1/embeddings' });
    const text = await response.text();
    expect(h.ollama.requests.at(-1)).toMatchObject({ url: '/v1/embeddings', body: JSON.stringify({ model: EMBED, input: 'hello' }) });
    expect(JSON.parse(text)).toMatchObject({ object: 'list', model: EMBED });
    expect(h.rows()).toMatchObject([{ outcome: 'ok', bytes_out: Buffer.byteLength(text), upstream_status: 200, upstream_prompt_tokens: null }]);
  });
});

describe('the client going away', () => {
  test('mid-stream, upstream is aborted within 100 ms, as client_gone', async () => {
    const h = await harness({ ollama: { chunks: 10_000, chunk_delay_ms: 5 } });
    const leave = new AbortController();
    const { text } = await read_events(await post(h, CHAT, { signal: leave.signal }), 2);
    expect(events(text)).toHaveLength(2);
    const left = Date.now();
    leave.abort();
    await vi.waitFor(() => expect(h.ollama.streams[0]?.closed_at).not.toBeNull());
    expect((h.ollama.streams[0]?.closed_at ?? Number.POSITIVE_INFINITY) - left).toBeLessThan(100);
    await vi.waitFor(() => expect(h.rows()[0]?.outcome).toBe('client_gone'));
    expect(h.rows()[0]?.first_byte_ms).toEqual(expect.any(Number));
    expect(lease_states(h.db)).toEqual([{ model: QWEN35, state: 'released' }]);
    expect(incidents(h.db)).toEqual([]);
  });

  test('before the first byte, upstream is aborted within 100 ms, as client_gone', async () => {
    const h = await harness({ ollama: { stall_after: { [QWEN35]: 0 } } });
    const leave = new AbortController();
    const answer = post(h, CHAT, { signal: leave.signal }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(h.ollama.streams).toHaveLength(1));
    const left = Date.now();
    leave.abort();
    await vi.waitFor(() => expect(h.ollama.streams[0]?.closed_at).not.toBeNull());
    expect((h.ollama.streams[0]?.closed_at ?? Number.POSITIVE_INFINITY) - left).toBeLessThan(100);
    expect(await answer).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(h.rows()).toMatchObject([{ outcome: 'client_gone', first_byte_ms: null, upstream_status: null }]));
  });
});

describe('a stall', () => {
  test('before the first byte retries once on the next candidate, with degraded_from', async () => {
    const clock = fake_clock();
    const h = await harness({ clock, ollama: { stall_after: { [QWEN35]: 0 } } });
    const answer = post(h, { ...CHAT, stream_options: { include_usage: true } });
    await vi.waitFor(() => expect(h.ollama.streams).toHaveLength(1));
    clock.advance(30_000);
    const response = await answer;
    const text = await response.text();
    const [first, retried] = h.rows();
    expect(response.headers.get('x-penfield-decision')).toBe(retried?.id);
    expect(response.headers.get('x-penfield-target')).toBe(`searle/${QWEN27}`);
    expect(events(text).at(-1)).toBe('data: [DONE]');
    expect(first).toMatchObject({ target: on_searle(QWEN35), outcome: 'stalled', first_byte_ms: null, total_ms: 30_000, bytes_out: 0 });
    expect(retried).toMatchObject({
      request_id: first?.request_id,
      target: on_searle(QWEN27),
      alternatives: [SONNET],
      // The 27B is on disk, not loaded.
      placement: { resident: false, cold_load: true, waited_ms: 0, degraded_from: `searle/${QWEN35}` },
      outcome: 'ok',
      upstream_prompt_tokens: 18,
    });
    expect(retried?.reasons.at(-1)).toBe(`proxy: searle/${QWEN35} sent nothing for 30000 ms before its first byte; retried on searle/${QWEN27}`);
    expect(h.ollama.requests.filter(({ url }) => url === '/v1/chat/completions').map(({ body }) => JSON.parse(body) as unknown)).toEqual([
      { ...CHAT, stream_options: { include_usage: true }, model: QWEN35 },
      { ...CHAT, stream_options: { include_usage: true }, model: QWEN27 },
    ]);
    expect(lease_states(h.db)).toEqual([
      { model: QWEN35, state: 'stalled' },
      { model: QWEN27, state: 'released' },
    ]);
    expect(incidents(h.db)).toEqual([{ node: 'searle', model: QWEN35, kind: 'stall' }]);
  });

  test('on the retry too is a 504 naming it, with its decision id, and no third try', async () => {
    const clock = fake_clock();
    const h = await harness({ clock, ollama: { stall_after: { [QWEN35]: 0, [QWEN27]: 0 } } });
    const answer = post(h, CHAT);
    await vi.waitFor(() => expect(h.ollama.streams).toHaveLength(1));
    clock.advance(30_000);
    await vi.waitFor(() => expect(h.ollama.streams).toHaveLength(2));
    // The 27B is a cold load, so its first byte has `first_token_cold`.
    clock.advance(90_000);
    const response = await answer;
    const [first, retried] = h.rows();
    expect(response.status).toBe(504);
    expect(response.headers.get('x-penfield-decision')).toBe(retried?.id);
    expect(await response.json()).toMatchObject({
      error: { type: 'server_error', code: 'upstream_timeout', decision_id: retried?.id, message: `searle/${QWEN27} sent nothing for 90000 ms` },
    });
    expect([first?.outcome, retried?.outcome]).toEqual(['stalled', 'stalled']);
    expect(h.ollama.streams).toHaveLength(2);
    expect(incidents(h.db)).toEqual([
      { node: 'searle', model: QWEN35, kind: 'stall' },
      { node: 'searle', model: QWEN27, kind: 'stall' },
    ]);
  });

  test('before the first byte with the next candidate busy is a 504 with the refused retry logged', async () => {
    const clock = fake_clock();
    const h = await harness({ clock, ollama: { stall_after: { [QWEN35]: 0 } } });
    // The 27B's one slot, held by another request.
    const other = h.leases.acquire({ request_id: 'other', decision_id: 'other', caller: 'nurselog', node: 'searle', model: QWEN27, slots: 1, deadline_ms: 600_000 });
    const answer = post(h, CHAT);
    await vi.waitFor(() => expect(h.ollama.streams).toHaveLength(1));
    clock.advance(30_000);
    const response = await answer;
    const [, retried] = h.rows();
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      error: {
        decision_id: retried?.id,
        message: `searle/${QWEN35} sent nothing for 30000 ms, and the retry was refused: searle/${QWEN27} has no free slot`,
      },
    });
    expect(retried).toMatchObject({ outcome: 'refused', target: { kind: 'refused' }, placement: { degraded_from: `searle/${QWEN35}` } });
    if (other !== null) h.leases.release(other.id, 'ok');
  });

  test('before the first byte, a client that leaves while the retry waits for a slot is let go, the wait logged', async () => {
    const clock = fake_clock();
    const h = await harness({ clock, ollama: { stall_after: { [QWEN35]: 0 } } });
    h.choice = { model: QWEN35, alternatives: [on_searle(QWEN27)], policy: { max_privacy: 'cloud', busy: 'wait', wait_ms: 5_000 } };
    const other = h.leases.acquire({ request_id: 'other', decision_id: 'other', caller: 'nurselog', node: 'searle', model: QWEN27, slots: 1, deadline_ms: 600_000 });
    const leave = new AbortController();
    const answer = post(h, CHAT, { signal: leave.signal }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(h.ollama.streams).toHaveLength(1));
    clock.advance(30_000);
    // The retry is in the 27B's line once the first row has its outcome.
    await vi.waitFor(() => expect(h.rows()[0]?.outcome).toBe('stalled'));
    leave.abort();
    expect(await answer).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(h.rows()).toHaveLength(2));
    expect(h.rows()[1]).toMatchObject({ outcome: 'refused', target: { kind: 'refused', reason: 'the client went away while it waited' } });
    expect(h.ollama.streams).toHaveLength(1);
    if (other !== null) h.leases.release(other.id, 'ok');
  });

  test('before the first byte with no other candidate on a node is a 504 with the first decision id', async () => {
    const clock = fake_clock();
    const h = await harness({ clock, ollama: { stall_after: { [QWEN35]: 0 } } });
    h.choice = { model: QWEN35, alternatives: [SONNET] };
    const answer = post(h, CHAT);
    await vi.waitFor(() => expect(h.ollama.streams).toHaveLength(1));
    clock.advance(30_000);
    const response = await answer;
    const [row] = h.rows();
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      error: { decision_id: row?.id, message: `searle/${QWEN35} sent nothing for 30000 ms, and no other candidate is on a node` },
    });
    expect(h.rows()).toHaveLength(1);
  });

  test('after bytes ends the stream with an error event, as stalled, and is not retried', async () => {
    const clock = fake_clock();
    const h = await harness({ clock, ollama: { stall_after: { [QWEN35]: 3 } } });
    const response = await post(h, CHAT);
    const { reader, text } = await read_events(response, 3);
    // The deadline's timer, and the stall window over the read that never answers.
    await vi.waitFor(() => expect(clock.pending()).toBe(2));
    clock.advance(30_000);
    const all = events(text + (await rest_of(reader)));
    const [row] = h.rows();
    expect(all).toHaveLength(4);
    expect(error_of(all[3])).toEqual({
      error: {
        message: `searle/${QWEN35} sent nothing for 30000 ms; penfield ended the stream`,
        type: 'server_error',
        param: null,
        code: 'upstream_timeout',
        request_id: row?.request_id,
        decision_id: row?.id,
      },
    });
    expect(row).toMatchObject({ outcome: 'stalled', first_byte_ms: 0, total_ms: 30_000, bytes_out: Buffer.byteLength(text), upstream_status: 200 });
    expect(h.ollama.streams).toHaveLength(1);
    expect(lease_states(h.db)).toEqual([{ model: QWEN35, state: 'stalled' }]);
    expect(incidents(h.db)).toEqual([{ node: 'searle', model: QWEN35, kind: 'stall' }]);
  });
});

const twenty_seconds = (text: string): string => text.replace('deadline_ms: { default: 600000 }', 'deadline_ms: { default: 20000 }');

describe('the deadline', () => {
  test('mid-stream is the proxy\'s: the lease ends as deadline at deadline_at with no incident, and the reaper beside it takes nothing (D47)', async () => {
    const clock = fake_clock();
    const h = await harness({ clock, config: twenty_seconds, reaper_every_ms: 5_000, ollama: { stall_after: { [QWEN35]: 2 } } });
    const { reader, text } = await read_events(await post(h, CHAT), 2);
    // The reaper's tick, the deadline, and the stall window.
    await vi.waitFor(() => expect(clock.pending()).toBe(3));
    clock.advance(20_000);
    const all = events(text + (await rest_of(reader)));
    const [row] = h.rows();
    expect(error_of(all.at(-1))).toMatchObject({
      error: { code: 'upstream_timeout', decision_id: row?.id, message: `the forward to searle/${QWEN35} ran past its deadline_ms of 20000; penfield ended the stream` },
    });
    expect(row).toMatchObject({ outcome: 'deadline', total_ms: 20_000 });
    expect(lease_states(h.db)).toEqual([{ model: QWEN35, state: 'released' }]);
    clock.advance(60_000);
    expect(incidents(h.db)).toEqual([]);
  });

  test('before the first byte is a 504 and is never retried', async () => {
    const clock = fake_clock();
    const h = await harness({ clock, config: twenty_seconds, ollama: { stall_after: { [QWEN35]: 0 } } });
    const answer = post(h, CHAT);
    await vi.waitFor(() => expect(h.ollama.streams).toHaveLength(1));
    clock.advance(20_000);
    const response = await answer;
    const [row] = h.rows();
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      error: { code: 'upstream_timeout', decision_id: row?.id, message: `the forward to searle/${QWEN35} ran past its deadline_ms of 20000` },
    });
    expect(h.rows()).toMatchObject([{ outcome: 'deadline', first_byte_ms: null }]);
    expect(h.ollama.streams).toHaveLength(1);
    expect(incidents(h.db)).toEqual([]);
  });
});

describe('the node failing on its own', () => {
  test("an error status passes through as the node sent it, as upstream_error", async () => {
    const h = await harness();
    h.ollama.state.tags = [QWEN35];
    h.choice = { model: QWEN27, alternatives: [] };
    const response = await post(h, CHAT);
    const [row] = h.rows();
    expect(response.status).toBe(404);
    expect(response.headers.get('x-penfield-decision')).toBe(row?.id);
    expect(await response.json()).toMatchObject({ error: { message: `model "${QWEN27}" not found, try pulling it first` } });
    expect(h.rows()).toMatchObject([{ outcome: 'upstream_error', upstream_status: 404 }]);
  });

  test('a refused connection is a 502 with the decision id, as upstream_error', async () => {
    const h = await harness();
    await h.ollama.close();
    const response = await post(h, CHAT);
    const [row] = h.rows();
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string; decision_id: string; message: string } };
    expect(body.error).toMatchObject({ code: 'upstream_error', decision_id: row?.id });
    expect(body.error.message).toMatch(new RegExp(`^penfield could not reach searle/${QWEN35}: fetch failed`));
    expect(h.rows()).toMatchObject([{ outcome: 'upstream_error', upstream_status: null, first_byte_ms: null }]);
  });
});
