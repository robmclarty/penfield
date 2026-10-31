import { afterEach, describe, expect, test } from 'vitest';

import { start_fake } from '../../../test/helpers/fake_http.js';
import type { FakeServer } from '../../../test/helpers/fake_http.js';
import { start_fake_ollama } from '../../../test/helpers/fake_ollama.js';
import { start_fake_openai } from '../../../test/helpers/fake_openai.js';
import { discover_ollama, discover_openai } from '../index.js';

let fakes: FakeServer[] = [];

const track = <T extends FakeServer>(fake: T): T => {
  fakes.push(fake);
  return fake;
};

afterEach(async () => {
  await Promise.all(fakes.map((fake) => fake.close()));
  fakes = [];
});

// A URL nothing listens on: a fake's, after it has closed.
const refused_url = async (): Promise<string> => {
  const gone = await start_fake(() => undefined);
  await gone.close();
  return gone.url;
};

const target = (url: string) => ({ name: 'searle', url, timeout_ms: 1_000 });

describe('discover_ollama', () => {
  test('three tags and one resident yield three models with the right residency', async () => {
    const fake = track(
      await start_fake_ollama({
        tags: ['qwen3.8:27b-mlx', 'qwen3.6:35b-mlx', 'nomic-embed-text:latest'],
        resident: ['qwen3.6:35b-mlx'],
      }),
    );
    expect(await discover_ollama(target(fake.url))).toEqual({
      node: 'searle',
      state: 'up',
      models: [
        { id: 'qwen3.8:27b-mlx', node: 'searle', residency: 'cold', size_bytes: 1e9, context_length: null },
        { id: 'qwen3.6:35b-mlx', node: 'searle', residency: 'resident', size_bytes: 2e9, context_length: 65_536 },
        { id: 'nomic-embed-text:latest', node: 'searle', residency: 'cold', size_bytes: 3e9, context_length: null },
      ],
    });
    expect(fake.requests.map(({ method, url }) => `${method} ${url}`).toSorted()).toEqual([
      'GET /api/ps',
      'GET /api/tags',
    ]);
  });

  test('a model still loaded after its tag was removed is listed, resident', async () => {
    const fake = track(await start_fake_ollama({ tags: ['gemma4:26b'], resident: ['qwen3:4b-instruct-2507'] }));
    const discovery = await discover_ollama(target(fake.url));
    expect(discovery.models.map(({ id, residency }) => [id, residency])).toEqual([
      ['gemma4:26b', 'cold'],
      ['qwen3:4b-instruct-2507', 'resident'],
    ]);
  });

  test('the fake is live: a change to its state shows on the next discovery', async () => {
    const fake = track(await start_fake_ollama({ tags: ['gemma4:26b'] }));
    expect((await discover_ollama(target(fake.url))).models[0]?.residency).toBe('cold');
    fake.state.resident = ['gemma4:26b'];
    expect((await discover_ollama(target(fake.url))).models[0]?.residency).toBe('resident');
  });

  test('a connection refusal is an empty node marked down, not a throw', async () => {
    const url = await refused_url();
    expect(await discover_ollama(target(url))).toEqual({
      node: 'searle',
      state: 'down',
      models: [],
      reason: expect.stringMatching(new RegExp(`^GET ${url}/api/tags: connect ECONNREFUSED`)),
    });
  });

  test('a server that is not Ollama is down with the status', async () => {
    const fake = track(await start_fake_openai({ models: ['m'] }));
    expect(await discover_ollama(target(fake.url))).toMatchObject({
      state: 'down',
      reason: `GET ${fake.url}/api/tags: HTTP 404`,
    });
  });

  test('a body in the wrong shape is down with where it went wrong', async () => {
    const fake = track(
      await start_fake((request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(request.url === '/api/ps' ? '{"models":[{"size":1}]}' : '{"models":[]}');
      }),
    );
    expect(await discover_ollama(target(fake.url))).toMatchObject({
      state: 'down',
      reason: expect.stringMatching(/\/api\/ps: unexpected body at models\.0\.name: /),
    });
  });

  test('a node that never answers is down once the timeout passes', async () => {
    const fake = track(await start_fake(() => undefined));
    expect(await discover_ollama({ ...target(fake.url), timeout_ms: 50 })).toMatchObject({
      state: 'down',
      reason: `GET ${fake.url}/api/tags: no answer in 50 ms`,
    });
  });
});

describe('discover_openai', () => {
  test('/v1/models yields models with residency unknown', async () => {
    const fake = track(await start_fake_openai({ models: ['openrouter/auto', 'anthropic/claude-sonnet-5.5'] }));
    expect(await discover_openai({ name: 'openrouter', url: `${fake.url}/v1/`, timeout_ms: 1_000 })).toEqual({
      node: 'openrouter',
      state: 'up',
      models: [
        { id: 'openrouter/auto', node: 'openrouter', residency: 'unknown', size_bytes: null, context_length: null },
        {
          id: 'anthropic/claude-sonnet-5.5',
          node: 'openrouter',
          residency: 'unknown',
          size_bytes: null,
          context_length: null,
        },
      ],
    });
    expect(fake.requests.map(({ method, url }) => `${method} ${url}`)).toEqual(['GET /v1/models']);
  });

  test("sends the node's api key as a bearer, and is down without it", async () => {
    const fake = track(await start_fake_openai({ models: ['m'], api_key: 'key_fake_0123' }));
    const base = { name: 'cloud', url: `${fake.url}/v1`, timeout_ms: 1_000 };
    expect(await discover_openai({ ...base, api_key: 'key_fake_0123' })).toMatchObject({ state: 'up' });
    expect(fake.requests[0]?.headers.authorization).toBe('Bearer key_fake_0123');
    expect(await discover_openai(base)).toMatchObject({ state: 'down', reason: `GET ${fake.url}/v1/models: HTTP 401` });
    expect(fake.requests[1]?.headers.authorization).toBeUndefined();
  });

  test('a connection refusal is an empty node marked down, not a throw', async () => {
    const url = await refused_url();
    expect(await discover_openai({ name: 'cloud', url: `${url}/v1`, timeout_ms: 1_000 })).toMatchObject({
      node: 'cloud',
      state: 'down',
      models: [],
    });
  });

  test('a body that is not JSON is down with the parse error', async () => {
    const fake = track(
      await start_fake((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<html>login</html>');
      }),
    );
    expect(await discover_openai({ name: 'cloud', url: fake.url, timeout_ms: 1_000 })).toMatchObject({
      state: 'down',
      reason: expect.stringMatching(new RegExp(`^GET ${fake.url}/models: .*JSON`)),
    });
  });
});
