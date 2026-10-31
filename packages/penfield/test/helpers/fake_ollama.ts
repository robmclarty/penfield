import type { ServerResponse } from 'node:http';

import { send_json, start_fake } from './fake_http.js';
import type { FakeServer, RecordedRequest } from './fake_http.js';

// A fake Ollama: `GET /api/version`, `GET /api/tags` listing `tags`, `GET /api/ps`
// listing the `resident` ones, and `POST /api/generate` with an empty prompt
// (loads a model) or `keep_alive: 0` (unloads it), each in Ollama's own shape. Any
// other path is a 404. Every request is recorded. `state` is live: a test changes
// it and the next request sees the change.

export type FakeOllamaState = {
  tags: string[];
  resident: string[];
  // What `/api/ps` reports as each resident model's context.
  context_length: number;
  // `error` answers every request 500; `hang` answers none.
  fail: 'none' | 'error' | 'hang';
  // Models whose `/api/generate` never answers: resident but wedged.
  hung: string[];
  // Whether an unload frees a hung model, so the reload after it answers.
  unload_clears_hang: boolean;
};

export type FakeOllama = FakeServer & { state: FakeOllamaState };

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
    unload_clears_hang: true,
    ...initial,
  };
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
    } else {
      send_json(response, 404, { error: `fake ollama: no route for ${route}` });
    }
  });
  return { ...server, state };
};
