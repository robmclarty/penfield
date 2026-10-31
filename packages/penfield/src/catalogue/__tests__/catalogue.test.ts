import { afterEach, describe, expect, test } from 'vitest';

import { start_fake } from '../../../test/helpers/fake_http.js';
import type { FakeServer } from '../../../test/helpers/fake_http.js';
import { start_fake_ollama } from '../../../test/helpers/fake_ollama.js';
import { start_fake_openai } from '../../../test/helpers/fake_openai.js';
import { format_issues, load_config } from '../../config/index.js';
import type { Config } from '../../config/index.js';
import { create_catalogue, discover_all } from '../index.js';

const AT = '2026-10-31T12:00:00.000Z';

let fakes: FakeServer[] = [];

afterEach(async () => {
  await Promise.all(fakes.map((fake) => fake.close()));
  fakes = [];
});

const loaded = (text: string): Config => {
  const result = load_config(text);
  if (!result.ok) throw new Error(format_issues('penfield.yaml', result.issues));
  return result.config;
};

// searle on the fake Ollama, lab on the fake OpenAI server behind a key, closet
// hand-listed and claude a decision: one of each way a node lists its models.
const house = async (): Promise<Config> => {
  const ollama = await start_fake_ollama({
    tags: ['qwen3.6:35b-mlx', 'nomic-embed-text:latest'],
    resident: ['qwen3.6:35b-mlx'],
  });
  const openai = await start_fake_openai({ models: ['glm-4.7-flash'], api_key: 'key_fake_0123' });
  fakes.push(ollama, openai);
  return loaded(`version: 1
nodes:
  searle: { kind: ollama, url: "${ollama.url}", privacy: lan }
  lab: { kind: openai_compatible, url: "${openai.url}/v1", privacy: lan, api_key_env: LAB_KEY }
  closet: { kind: openai_compatible, url: http://closet.test/v1, privacy: lan, discover: false, models: [gemma4:26b] }
  claude: { kind: claude_decision, models: [opus] }
profiles:
  embed: { candidates: [nomic-embed-text, qwen3-embedding:0.6b] }
`);
};

describe('discover_all', () => {
  test('reads each node that discovers, once, with its key, and no other', async () => {
    const config = await house();
    const discoveries = await discover_all(config, { LAB_KEY: 'key_fake_0123' });
    expect(discoveries.map(({ node, state }) => [node, state])).toEqual([
      ['searle', 'up'],
      ['lab', 'up'],
    ]);
    const [ollama, openai] = fakes;
    expect(ollama?.requests.map(({ url }) => url).toSorted()).toEqual(['/api/ps', '/api/tags']);
    expect(openai?.requests.map(({ url, headers }) => [url, headers.authorization])).toEqual([
      ['/v1/models', 'Bearer key_fake_0123'],
    ]);
  });

  test('a node whose api_key_env is not set is down without a request', async () => {
    const config = await house();
    const discoveries = await discover_all(config, {});
    expect(discoveries[1]).toEqual({ node: 'lab', state: 'down', models: [], reason: 'LAB_KEY is not set' });
    expect(fakes[1]?.requests).toEqual([]);
  });
});

describe('the store', () => {
  test('the snapshot merges what discovery saw', async () => {
    const config = await house();
    const store = create_catalogue(config);
    expect(store.snapshot().nodes.map(({ name, state }) => [name, state])).toEqual([
      ['searle', 'unknown'],
      ['lab', 'unknown'],
      ['closet', 'unknown'],
      ['claude', 'up'],
    ]);
    for (const discovery of await discover_all(config, { LAB_KEY: 'key_fake_0123' })) {
      store.record_discovery(discovery, AT);
    }
    const snapshot = store.snapshot();
    expect(snapshot.nodes.map(({ name, state }) => [name, state])).toEqual([
      ['searle', 'up'],
      ['lab', 'up'],
      ['closet', 'unknown'],
      ['claude', 'up'],
    ]);
    expect(snapshot.models.map(({ ref, residency }) => [ref, residency])).toEqual([
      ['searle/qwen3.6:35b-mlx', 'resident'],
      ['searle/nomic-embed-text:latest', 'cold'],
      ['lab/glm-4.7-flash', 'unknown'],
      ['closet/gemma4:26b', 'unknown'],
      ['claude/opus', 'unknown'],
    ]);
    expect(snapshot.warnings).toEqual([
      {
        kind: 'candidate_missing',
        profile: 'embed',
        candidate: 'qwen3-embedding:0.6b',
        message: 'no node has "qwen3-embedding:0.6b"',
      },
    ]);
  });

  test('a refused node is down in the snapshot, not a throw', async () => {
    const gone = await start_fake(() => undefined);
    await gone.close();
    const config = loaded(`version: 1
nodes:
  searle: { kind: ollama, url: "${gone.url}", privacy: lan }
`);
    const store = create_catalogue(config);
    for (const discovery of await discover_all(config, {})) store.record_discovery(discovery, AT);
    expect(store.snapshot().nodes[0]).toMatchObject({
      name: 'searle',
      state: 'down',
      reason: expect.stringContaining('ECONNREFUSED'),
      discovered_at: AT,
    });
    expect(store.snapshot().models).toEqual([]);
  });

  test('a snapshot is plain data that a later record does not change', async () => {
    const config = await house();
    const store = create_catalogue(config);
    const before = store.snapshot();
    const copy = structuredClone(before);
    store.record_discovery({ node: 'searle', state: 'down', models: [], reason: 'gone' }, AT);
    store.record_breakers({ nodes: { searle: 'open' }, models: {} });
    expect(before).toEqual(copy);
    expect(store.snapshot().nodes[0]).toMatchObject({ state: 'down', breaker: 'open' });
  });

  test('a discovery for a node the config does not name is ignored', async () => {
    const store = create_catalogue(await house());
    const before = store.snapshot();
    store.record_discovery({ node: 'elsewhere', state: 'up', models: [] }, AT);
    expect(store.snapshot()).toBe(before);
  });
});
