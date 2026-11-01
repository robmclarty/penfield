import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import { z } from 'zod';

import { send_json, start_fake } from './fake_http.js';
import type { FakeServer, RecordedRequest } from './fake_http.js';

// A fake Ollama: `GET /api/version`, `GET /api/tags` listing `tags`, `GET /api/ps`
// listing the `resident` ones, and `POST /api/generate` with an empty prompt
// (loads a model, or answers as an embedding model or a crashed runner would) or
// `keep_alive: 0` (unloads it), each in Ollama's own shape. `POST
// /v1/chat/completions` streams the chunks captured from searle, or as many as a
// test asks for in their shape, and `POST /v1/embeddings` answers the captured
// embedding. Any other path is a 404. Every request is recorded. `state` is live:
// a test changes it and the next request sees the change.

export type FakeOllamaState = {
  tags: string[];
  resident: string[];
  // What `/api/ps` reports as each resident model's context.
  context_length: number;
  // `error` answers every request 500; `hang` answers none.
  fail: 'none' | 'error' | 'hang';
  // Models whose `/api/generate` never answers: resident but wedged.
  hung: string[];
  // Models that only embed, whose `/api/generate` Ollama answers 400.
  embedding: string[];
  // Models whose runner has died, whose `/api/generate` answers 500.
  crashed: string[];
  // Whether an unload frees a hung model, so the reload after it answers.
  unload_clears_hang: boolean;
  // Content chunks a stream sends, each `chunk_text`; unset replays searle's own.
  chunks: number | undefined;
  chunk_text: string;
  // Real milliseconds before a stream's first byte, and between its chunks.
  first_byte_delay_ms: number;
  chunk_delay_ms: number;
  // Models whose answer goes quiet after this many content chunks, for good: at 0
  // nothing is sent, not even headers, as Ollama does while it loads a model.
  stall_after: Record<string, number>;
};

// One `/v1/chat/completions` stream, as it went.
export type FakeStream = {
  model: string;
  // Content chunks written.
  sent: number;
  finished: boolean;
  // `Date.now()` when the gateway's side closed it before it finished.
  closed_at: number | null;
};

export type FakeOllama = FakeServer & { state: FakeOllamaState; streams: FakeStream[] };

const SIZE = 1_000_000_000;

const details = { format: 'gguf', family: 'qwen3', parameter_size: '4B', quantization_level: 'Q4_K_M' };

const tag = (name: string, index: number) => ({
  name,
  model: name,
  modified_at: '2026-10-01T00:00:00Z',
  size: SIZE * (index + 1),
  digest: `sha256:${String(index).padStart(64, '0')}`,
  details,
});

const loaded = (name: string, index: number, context_length: number) => ({
  ...tag(name, index),
  expires_at: '2026-10-31T23:59:59Z',
  size_vram: SIZE * (index + 1),
  context_length,
});

const generate_body = (body: string): { model: string; keep_alive?: unknown } => {
  const parsed: unknown = JSON.parse(body === '' ? '{}' : body);
  const fields = typeof parsed === 'object' && parsed !== null ? parsed : {};
  const model = 'model' in fields && typeof fields.model === 'string' ? fields.model : '';
  return 'keep_alive' in fields ? { model, keep_alive: fields.keep_alive } : { model };
};

// ── the OpenAI-compatible endpoints ───────────────────────────────────────────

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/ollama/${name}`, import.meta.url), 'utf8');

// A chunk as searle sent it: what the fake reads of one, and the rest kept as sent.
const chunk_shape = z.looseObject({
  choices: z.array(
    z.looseObject({
      index: z.number(),
      delta: z.record(z.string(), z.unknown()).optional(),
      finish_reason: z.string().nullable(),
    }),
  ),
  usage: z.unknown().optional(),
});

type Chunk = z.output<typeof chunk_shape>;

const CAPTURED: Chunk[] = fixture('chat_stream.sse')
  .split('\n')
  .filter((line) => line.startsWith('data: {'))
  .map((line) => chunk_shape.parse(JSON.parse(line.slice('data: '.length))));

const is_usage = (chunk: Chunk): boolean => chunk.usage !== undefined;

const is_finish = (chunk: Chunk): boolean => chunk.choices.some(({ finish_reason }) => finish_reason !== null);

const CAPTURED_CONTENT = CAPTURED.filter((chunk) => !is_usage(chunk) && !is_finish(chunk));

const CAPTURED_FINISH = CAPTURED.filter(is_finish);

const CAPTURED_USAGE = CAPTURED.filter(is_usage);

const content_template = CAPTURED_CONTENT[0];

const content_chunk = (index: number, text: string): Chunk => ({
  ...content_template,
  choices: [{ index: 0, delta: index === 0 ? { role: 'assistant', content: text } : { content: text }, finish_reason: null }],
});

const event = (chunk: Chunk, model: string): string => `data: ${JSON.stringify({ ...chunk, model })}\n\n`;

type ChatBody = { model: string; stream: boolean; include_usage: boolean };

const chat_shape = z.object({
  model: z.string().catch(''),
  stream: z.boolean().catch(false),
  stream_options: z.object({ include_usage: z.boolean().catch(false) }).catch({ include_usage: false }),
});

const chat_body = (body: string): ChatBody => {
  const parsed = chat_shape.parse(JSON.parse(body === '' ? '{}' : body));
  return { model: parsed.model, stream: parsed.stream, include_usage: parsed.stream_options.include_usage };
};

const not_found = (response: ServerResponse, model: string): void =>
  send_json(response, 404, {
    error: { message: `model "${model}" not found, try pulling it first`, type: 'api_error', param: null, code: null },
  });

// A write the socket is not ready for waits for it to drain, so the fake streams
// no faster than the gateway pulls (C4's test reads the heap with it running).
const write = async (response: ServerResponse, text: string): Promise<boolean> => {
  if (response.destroyed) return false;
  if (response.write(text)) return true;
  await new Promise<void>((ready) => {
    const done = (): void => {
      response.off('drain', done);
      response.off('close', done);
      ready();
    };
    response.on('drain', done);
    response.on('close', done);
  });
  return !response.destroyed;
};

// Made one at a time, so a 50 k-chunk stream is never held whole by the fake either.
function* generated(count: number, text: string): Generator<Chunk> {
  for (let index = 0; index < count; index += 1) yield content_chunk(index, text);
}

const contents = (state: FakeOllamaState): Iterable<Chunk> =>
  state.chunks === undefined ? CAPTURED_CONTENT : generated(state.chunks, state.chunk_text);

const stream_chat = async (state: FakeOllamaState, body: ChatBody, response: ServerResponse, record: FakeStream): Promise<void> => {
  const stall = state.stall_after[body.model];
  response.once('close', () => {
    if (!record.finished) record.closed_at = Date.now();
  });
  if (stall === 0) return;
  await sleep(state.first_byte_delay_ms);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of contents(state)) {
    if (stall !== undefined && record.sent >= stall) return;
    if (record.sent > 0 && state.chunk_delay_ms > 0) await sleep(state.chunk_delay_ms);
    if (!(await write(response, event(chunk, body.model)))) return;
    record.sent += 1;
  }
  const tail = [...CAPTURED_FINISH, ...(body.include_usage ? CAPTURED_USAGE : [])];
  for (const chunk of tail) if (!(await write(response, event(chunk, body.model)))) return;
  record.finished = true;
  response.end('data: [DONE]\n\n');
};

const answer_chat = (body: ChatBody, response: ServerResponse): void => {
  const content = CAPTURED_CONTENT.map((chunk) => {
    const text = chunk.choices[0]?.delta?.['content'];
    return typeof text === 'string' ? text : '';
  }).join('');
  send_json(response, 200, {
    id: 'chatcmpl-526',
    object: 'chat.completion',
    created: 1_793_496_742,
    model: body.model,
    system_fingerprint: 'fp_ollama',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: CAPTURED_USAGE[0]?.usage,
  });
};

const chat = (state: FakeOllamaState, request: RecordedRequest, response: ServerResponse, streams: FakeStream[]): void => {
  const body = chat_body(request.body);
  if (!state.tags.includes(body.model)) {
    not_found(response, body.model);
    return;
  }
  if (!body.stream) {
    if (state.stall_after[body.model] === undefined) answer_chat(body, response);
    return;
  }
  const record: FakeStream = { model: body.model, sent: 0, finished: false, closed_at: null };
  streams.push(record);
  void stream_chat(state, body, response, record);
};

const EMBEDDING = z.record(z.string(), z.unknown()).parse(JSON.parse(fixture('embeddings.json')));

const embed = (state: FakeOllamaState, request: RecordedRequest, response: ServerResponse): void => {
  const { model } = chat_body(request.body);
  if (!state.tags.includes(model)) not_found(response, model);
  else if (state.stall_after[model] === undefined) send_json(response, 200, { ...EMBEDDING, model });
};

// ── the native API ────────────────────────────────────────────────────────────

const generate = (state: FakeOllamaState, request: RecordedRequest, response: ServerResponse): void => {
  const { model, keep_alive } = generate_body(request.body);
  const at = { model, created_at: '2026-10-31T12:00:00Z', response: '', done: true };
  if (keep_alive === 0) {
    state.resident = state.resident.filter((name) => name !== model);
    if (state.unload_clears_hang) state.hung = state.hung.filter((name) => name !== model);
    send_json(response, 200, { ...at, done_reason: 'unload' });
    return;
  }
  if (state.hung.includes(model)) return;
  if (state.embedding.includes(model)) {
    send_json(response, 400, { error: `"${model}" does not support generate` });
    return;
  }
  if (state.crashed.includes(model)) {
    send_json(response, 500, { error: 'llama runner process has terminated: signal: killed' });
    return;
  }
  if (!state.tags.includes(model)) {
    send_json(response, 404, { error: `model "${model}" not found, try pulling it first` });
    return;
  }
  if (!state.resident.includes(model)) state.resident = [...state.resident, model];
  send_json(response, 200, { ...at, done_reason: 'load' });
};

export const start_fake_ollama = async (initial: Partial<FakeOllamaState> = {}): Promise<FakeOllama> => {
  const state: FakeOllamaState = {
    tags: [],
    resident: [],
    context_length: 65_536,
    fail: 'none',
    hung: [],
    embedding: [],
    crashed: [],
    unload_clears_hang: true,
    chunks: undefined,
    chunk_text: ' word',
    first_byte_delay_ms: 0,
    chunk_delay_ms: 0,
    stall_after: {},
    ...initial,
  };
  const streams: FakeStream[] = [];
  const server = await start_fake((request, response) => {
    const route = `${request.method} ${request.url}`;
    if (state.fail === 'hang') return;
    if (state.fail === 'error') {
      send_json(response, 500, { error: 'fake ollama: failing on purpose' });
    } else if (route === 'GET /api/version') {
      send_json(response, 200, { version: '0.13.0' });
    } else if (route === 'GET /api/tags') {
      send_json(response, 200, { models: state.tags.map((name, index) => tag(name, index)) });
    } else if (route === 'GET /api/ps') {
      send_json(response, 200, {
        models: state.resident.map((name, index) => loaded(name, index, state.context_length)),
      });
    } else if (route === 'POST /api/generate') {
      generate(state, request, response);
    } else if (route === 'POST /v1/chat/completions') {
      chat(state, request, response, streams);
    } else if (route === 'POST /v1/embeddings') {
      embed(state, request, response);
    } else {
      send_json(response, 404, { error: `fake ollama: no route for ${route}` });
    }
  });
  return { ...server, state, streams };
};
