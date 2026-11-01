import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import type { FakeOllama } from '../helpers/fake_ollama.js';
import { start_fake_ollama } from '../helpers/fake_ollama.js';
import { booted, house_config, serve, TOKENS } from '../helpers/run_serve.js';
import type { Running } from '../helpers/run_serve.js';

// Plan step 15: Zed's native agent as an `openai_compatible` provider. The test
// replays the request shapes Zed sends (every request streamed with
// `stream_options.include_usage`, the agent's tools, the model's
// `reasoning_effort`, and a later turn carrying a tool call and its result) for
// `auto` and for a concrete tag, against the fake Ollama with the 35B resident.
// It also holds `deploy/zed.settings.example.json` to the gateway and to the
// playbook's §5.

const ZED = 'tok_zed-native_7b3d0e4a';

const SETTINGS_FILE = fileURLToPath(new URL('../../../../deploy/zed.settings.example.json', import.meta.url));

const PLAYBOOK = fileURLToPath(new URL('../../../../docs/specs/first-spec/playbook.md', import.meta.url));

type Settings = { language_models: { openai_compatible: { penfield: { api_url: string; available_models: { name: string }[] } } } };

const SETTINGS = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Settings;

const PROVIDER = SETTINGS.language_models.openai_compatible.penfield;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Reads the content of the given file in the project.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    },
  },
];

const SYSTEM = { role: 'system', content: 'You are a highly skilled software engineer with extensive knowledge in many programming languages.' };

const ASK = { role: 'user', content: [{ type: 'text', text: 'What does packages/penfield/src/wire/proxy.ts do?' }] };

// A first turn, as Zed's agent sends it.
const first_turn = (model: string) => ({
  model,
  messages: [SYSTEM, ASK],
  stream: true,
  stream_options: { include_usage: true },
  parallel_tool_calls: false,
  tools: TOOLS,
  reasoning_effort: 'medium',
});

// The turn after the model called a tool: its call, then what the tool gave back.
const tool_turn = (model: string) => ({
  ...first_turn(model),
  messages: [
    SYSTEM,
    ASK,
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"packages/penfield/src/wire/proxy.ts"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '// The streaming proxy (spec §6, §7): the only code that touches a node’s socket.' },
  ],
});

let dir = '';
let ollama: FakeOllama;
let running: Running;
let address = '';

const authorized = { authorization: `Bearer ${ZED}` };

const post = (body: unknown): Promise<Response> =>
  fetch(`${address}/v1/chat/completions`, { method: 'POST', headers: { ...authorized, 'content-type': 'application/json' }, body: JSON.stringify(body) });

const events = (text: string): string[] => text.split('\n\n').filter((each) => each !== '');

const data_of = (event: string | undefined): Record<string, unknown> => JSON.parse((event ?? '').replace(/^data: /, '')) as Record<string, unknown>;

const last_upstream = (): string | undefined => ollama.requests.findLast(({ url }) => url === '/v1/chat/completions')?.body;

type Row = { id: string; profile: string | null; rung: string; target: Record<string, unknown>; outcome: string | null; upstream_prompt_tokens: number | null };

const row_of = (id: string | null): Promise<Row> =>
  vi.waitFor(async () => {
    const response = await fetch(`${address}/decisions?caller=zed-native&limit=100`, { headers: authorized });
    const { decisions } = (await response.json()) as { decisions: Row[] };
    const row = decisions.find((each) => each.id === id);
    expect(row?.outcome ?? null).not.toBeNull();
    return row as Row;
  });

// What Zed reads: an OpenAI event stream ending in `[DONE]`, the usage in the last chunk before it.
const expect_zed_stream = async (response: Response): Promise<void> => {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
  const all = events(await response.text());
  expect(all.at(-1)).toBe('data: [DONE]');
  expect(data_of(all.at(-2))).toMatchObject({ object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 18, completion_tokens: 8 } });
  expect(data_of(all[0])).toMatchObject({ choices: [{ delta: { role: 'assistant' } }] });
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'penfield-zed-'));
  ollama = await start_fake_ollama({ tags: ['qwen3.8:27b-mlx', 'qwen3.6:35b-mlx', 'nomic-embed-text:latest'], resident: ['qwen3.6:35b-mlx'] });
  running = serve(['--config', house_config(dir, ollama.url), '--listen', '127.0.0.1:0', '--state-dir', join(dir, 'state'), '--tokens-file', TOKENS]);
  address = await booted(running);
  await vi.waitFor(async () => {
    const body = (await (await fetch(`${address}/healthz`)).json()) as { nodes: unknown[] };
    expect(body.nodes[0]).toMatchObject({ name: 'searle', state: 'up' });
  });
});

afterAll(async () => {
  await running.stop();
  await ollama.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('deploy/zed.settings.example.json', () => {
  test('names the gateway as an openai_compatible provider at its /v1', () => {
    expect(PROVIDER.api_url).toMatch(/^http:\/\/[^/]+:7777\/v1$/);
    expect(PROVIDER.available_models.map(({ name }) => name)).toEqual(['auto', 'auto/fast', 'auto/private', 'auto/best', 'qwen3.8:27b-mlx', 'qwen3.6:35b-mlx']);
  });

  test("names only models /v1/models lists for zed-native, so every pick in Zed's picker is one the gateway takes", async () => {
    const response = await fetch(`${address}/v1/models`, { headers: authorized });
    const { data } = (await response.json()) as { data: { id: string }[] };
    const listed = new Set(data.map(({ id }) => id));
    expect(PROVIDER.available_models.filter(({ name }) => !listed.has(name))).toEqual([]);
  });

  test("is the playbook's §5 block, word for word", () => {
    const playbook = readFileSync(PLAYBOOK, 'utf8');
    const section = playbook.slice(playbook.indexOf('## 5. Wire Zed'), playbook.indexOf('## 6.'));
    const block = /```json\n([\s\S]*?)\n```/.exec(section)?.[1];
    expect(JSON.parse(block ?? 'null')).toEqual(SETTINGS);
  });
});

describe("Zed's requests", () => {
  test('auto with tools streams from the resident 35B as code-light, every field of the body forwarded but model', async () => {
    const sent = first_turn('auto');
    const response = await post(sent);
    expect(response.headers.get('x-penfield-target')).toBe('searle/qwen3.6:35b-mlx');
    expect(response.headers.get('x-penfield-rung')).toBe('rule');
    await expect_zed_stream(response);
    expect(last_upstream()).toBe(JSON.stringify({ ...sent, model: 'qwen3.6:35b-mlx' }));
    expect(await row_of(response.headers.get('x-penfield-decision'))).toMatchObject({
      profile: 'code-light',
      rung: 'rule',
      outcome: 'ok',
      // Zed asks for usage on every stream, so its rows carry Q4's sample.
      upstream_prompt_tokens: 18,
    });
  });

  test('a turn carrying a tool call and its result routes the same way', async () => {
    const response = await post(tool_turn('auto'));
    expect(response.headers.get('x-penfield-target')).toBe('searle/qwen3.6:35b-mlx');
    await expect_zed_stream(response);
  });

  test('a concrete tag picked in the picker forwards verbatim, rung explicit', async () => {
    const sent = tool_turn('qwen3.8:27b-mlx');
    const response = await post(sent);
    expect(response.headers.get('x-penfield-target')).toBe('searle/qwen3.8:27b-mlx');
    expect(response.headers.get('x-penfield-rung')).toBe('explicit');
    await expect_zed_stream(response);
    expect(last_upstream()).toBe(JSON.stringify(sent));
    expect(await row_of(response.headers.get('x-penfield-decision'))).toMatchObject({ profile: null, rung: 'explicit', outcome: 'ok', upstream_prompt_tokens: 18 });
  });
});
