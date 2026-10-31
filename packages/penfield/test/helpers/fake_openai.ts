import { send_json, start_fake } from './fake_http.js';
import type { FakeServer } from './fake_http.js';

// A fake OpenAI-compatible server: `GET /v1/models` lists `models` in OpenAI's list
// shape. With `api_key` set it answers 401 to any request without that bearer.
// Any other path is a 404. Every request is recorded; `state` is live.

export type FakeOpenAiState = { models: string[]; api_key?: string };

export type FakeOpenAi = FakeServer & { state: FakeOpenAiState };

export const start_fake_openai = async (initial: FakeOpenAiState): Promise<FakeOpenAi> => {
  const state: FakeOpenAiState = { ...initial };
  const server = await start_fake((request, response) => {
    if (state.api_key !== undefined && request.headers.authorization !== `Bearer ${state.api_key}`) {
      send_json(response, 401, { error: { message: 'invalid api key', type: 'invalid_request_error' } });
    } else if (request.method === 'GET' && request.url === '/v1/models') {
      send_json(response, 200, {
        object: 'list',
        data: state.models.map((id) => ({ id, object: 'model', created: 1_790_000_000, owned_by: 'fake' })),
      });
    } else {
      send_json(response, 404, { error: { message: `fake openai: no route for ${request.method} ${request.url}` } });
    }
  });
  return { ...server, state };
};
