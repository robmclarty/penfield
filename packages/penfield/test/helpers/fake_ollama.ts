import { send_json, start_fake } from './fake_http.js';
import type { FakeServer } from './fake_http.js';

// A fake Ollama: `GET /api/tags` lists `tags`, `GET /api/ps` the `resident` ones,
// each in Ollama's own shape. Any other path is a 404. Every request is recorded.
// `state` is live: a test changes it and the next request sees the change.

export type FakeOllamaState = {
  tags: string[];
  resident: string[];
  // What `/api/ps` reports as each resident model's context.
  context_length: number;
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

export const start_fake_ollama = async (initial: Partial<FakeOllamaState> = {}): Promise<FakeOllama> => {
  const state: FakeOllamaState = { tags: [], resident: [], context_length: 65_536, ...initial };
  const server = await start_fake((request, response) => {
    if (request.method === 'GET' && request.url === '/api/tags') {
      send_json(response, 200, { models: state.tags.map((name, index) => tag(name, index)) });
    } else if (request.method === 'GET' && request.url === '/api/ps') {
      send_json(response, 200, {
        models: state.resident.map((name, index) => loaded(name, index, state.context_length)),
      });
    } else {
      send_json(response, 404, { error: `fake ollama: no route for ${request.method} ${request.url}` });
    }
  });
  return { ...server, state };
};
