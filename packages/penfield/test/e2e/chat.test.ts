import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import type { FakeOllama } from '../helpers/fake_ollama.js';
import { start_fake_ollama } from '../helpers/fake_ollama.js';
import { booted, house_config, serve, TOKENS } from '../helpers/run_serve.js';
import type { Running } from '../helpers/run_serve.js';

// Plan step 14 against the fake Ollama with the 35B resident: POST
// /v1/chat/completions routes `auto`, forwards a named tag as it came, and turns a
// Claude decision into what the caller's `on_claude_for_proxy` says (D19). The
// house file gains two callers for the modes no house caller uses.

const TOKEN = {
  rob: 'tok_rob_5f2a9c1e',
  zed: 'tok_zed-native_7b3d0e4a',
  nurselog: 'tok_nurselog_9a4b7d3c',
  downgrade: 'tok_curl-downgrade_3e9f1a7c',
  api_key: 'tok_curl-api-key_8d2c5b0e',
};

const CALLERS = [
  '  curl-downgrade: { max_privacy: cloud, claude: downgrade }',
  '  curl-api-key:   { max_privacy: cloud, claude: api_key }',
];

const TAGS = ['qwen3.8:27b-mlx', 'qwen3.6:35b-mlx', 'gemma4:26b', 'nomic-embed-text:latest'];

const MESSAGES = [{ role: 'user', content: 'what is the capital of France?' }];

const STREAMED = { model: 'auto', messages: MESSAGES, stream: true, stream_options: { include_usage: true } };

let dir = '';
let ollama: FakeOllama;
let running: Running;
let address = '';

const post = (body: unknown, token: string): Promise<Response> =>
  fetch(`${address}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

type Row = {
  id: string;
  caller: string;
  rung: string;
  target: Record<string, unknown>;
  alternatives: Record<string, unknown>[];
  placement: Record<string, unknown>;
  reasons: string[];
  outcome: string | null;
  upstream_prompt_tokens: number | null;
};

// The decision's row, once its outcome is written.
const row_of = (id: string | null): Promise<Row> =>
  vi.waitFor(async () => {
    const response = await fetch(`${address}/decisions?limit=100`, { headers: { authorization: `Bearer ${TOKEN.rob}` } });
    const { decisions } = (await response.json()) as { decisions: Row[] };
    const row = decisions.find((each) => each.id === id);
    expect(row?.outcome ?? null).not.toBeNull();
    return row as Row;
  });

const chat_requests = (): { model: string; body: string }[] =>
  ollama.requests
    .filter(({ method, url }) => method === 'POST' && url === '/v1/chat/completions')
    .map(({ body }) => ({ model: (JSON.parse(body) as { model: string }).model, body }));

const events = (text: string): string[] => text.split('\n\n').filter((each) => each !== '');

const data_of = (event: string | undefined): Record<string, unknown> => JSON.parse((event ?? '').replace(/^data: /, '')) as Record<string, unknown>;

const no_lease_held = (): Promise<void> =>
  vi.waitFor(async () => {
    const response = await fetch(`${address}/catalogue`, { headers: { authorization: `Bearer ${TOKEN.rob}` } });
    const { models } = (await response.json()) as { models: { slots_in_use: number }[] };
    expect(models.filter(({ slots_in_use }) => slots_in_use > 0)).toEqual([]);
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'penfield-chat-'));
  ollama = await start_fake_ollama({ tags: TAGS, resident: ['qwen3.6:35b-mlx'] });
  const config = house_config(dir, ollama.url);
  writeFileSync(config, `${readFileSync(config, 'utf8').trimEnd()}\n${CALLERS.join('\n')}\n`);
  const tokens = join(dir, 'tokens');
  writeFileSync(tokens, `${readFileSync(TOKENS, 'utf8')}curl-downgrade: ${TOKEN.downgrade}\ncurl-api-key: ${TOKEN.api_key}\n`);
  running = serve(['--config', config, '--listen', '127.0.0.1:0', '--state-dir', join(dir, 'state'), '--tokens-file', tokens]);
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

describe('POST /v1/chat/completions forwards', () => {
  test('auto streams from the resident chat model, with the request, decision, target and rung headers', async () => {
    const response = await post(STREAMED, TOKEN.rob);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(response.headers.get('x-penfield-request')).toMatch(/^[\da-f-]{36}$/);
    expect(response.headers.get('x-penfield-target')).toBe('searle/qwen3.6:35b-mlx');
    expect(response.headers.get('x-penfield-rung')).toBe('rule');
    const text = await response.text();
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
    expect(data_of(events(text).at(-2))).toMatchObject({ usage: { prompt_tokens: 18 } });
    const row = await row_of(response.headers.get('x-penfield-decision'));
    expect(row).toMatchObject({ caller: 'rob', rung: 'rule', target: { node: 'searle', model: 'qwen3.6:35b-mlx' }, outcome: 'ok', upstream_prompt_tokens: 18 });
    expect(chat_requests().at(-1)?.model).toBe('qwen3.6:35b-mlx');
    await no_lease_held();
  });

  test('a named tag forwards verbatim, rung explicit', async () => {
    const sent = { model: 'qwen3.8:27b-mlx', messages: MESSAGES, temperature: 0.2, stream: false };
    const response = await post(sent, TOKEN.rob);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-penfield-target')).toBe('searle/qwen3.8:27b-mlx');
    expect(response.headers.get('x-penfield-rung')).toBe('explicit');
    expect(await response.json()).toMatchObject({ object: 'chat.completion', model: 'qwen3.8:27b-mlx' });
    expect(chat_requests().at(-1)?.body).toBe(JSON.stringify(sent));
    expect(await row_of(response.headers.get('x-penfield-decision'))).toMatchObject({ rung: 'explicit', outcome: 'ok' });
    await no_lease_held();
  });

  test('a model the gateway does not know is a 404 naming it, and nothing is forwarded', async () => {
    const before = chat_requests().length;
    const response = await post({ model: 'nope', messages: MESSAGES }, TOKEN.rob);
    expect(response.status).toBe(404);
    const { error } = (await response.json()) as { error: Record<string, unknown> };
    expect(error).toMatchObject({ code: 'model_not_found', message: '"nope" is no alias, profile or model in the catalogue' });
    expect(response.headers.get('x-penfield-decision')).toBe(error['decision_id']);
    expect(chat_requests()).toHaveLength(before);
  });

  test("a named model outside the caller's models list is a 403, never another model (C11)", async () => {
    const response = await post({ model: 'qwen3.6:35b-mlx', messages: MESSAGES }, TOKEN.nurselog);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: 'forbidden', message: `caller nurselog may not use "qwen3.6:35b-mlx": it is not in the caller's models list` },
    });
  });
});

describe('a Claude decision on a proxy endpoint (D19)', () => {
  test('hint, for zed-native: one JSON chat completion naming the model and effort', async () => {
    const before = chat_requests().length;
    const response = await post({ model: 'code-heavy', messages: MESSAGES }, TOKEN.zed);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    const id = response.headers.get('x-penfield-decision');
    const completion = (await response.json()) as { id: string; object: string; choices: { message: { role: string; content: string } }[] };
    expect(completion).toMatchObject({ id: `chatcmpl-${id}`, object: 'chat.completion', model: 'code-heavy' });
    expect(completion.choices).toHaveLength(1);
    expect(completion.choices[0]?.message.role).toBe('assistant');
    expect(completion.choices[0]?.message.content).toMatch(/Claude opus at high effort/);
    expect(chat_requests()).toHaveLength(before);
    expect(await row_of(id)).toMatchObject({ caller: 'zed-native', target: { kind: 'claude_decision', model: 'opus', effort: 'high' }, outcome: 'hinted' });
  });

  test('hint, asked for as a stream: the same message as SSE, its usage, then [DONE]', async () => {
    const response = await post({ ...STREAMED, model: 'code-heavy' }, TOKEN.zed);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(response.headers.get('x-penfield-decision')).toMatch(/^[\da-f-]{36}$/);
    const [message, finish, usage, done, ...rest] = events(await response.text());
    expect(rest).toEqual([]);
    expect(data_of(message)).toMatchObject({
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: expect.stringMatching(/Claude opus at high effort/) }, finish_reason: null }],
    });
    expect(data_of(finish)).toMatchObject({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    expect(data_of(usage)).toMatchObject({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    expect(done).toBe('data: [DONE]');
  });

  test("hint is the house's word for rob, whose own `decision` only /route can carry out", async () => {
    const response = await post({ model: 'code-heavy', messages: MESSAGES }, TOKEN.rob);
    expect(response.status).toBe(200);
    expect(await row_of(response.headers.get('x-penfield-decision'))).toMatchObject({ outcome: 'hinted' });
  });

  test('downgrade: the best local candidate answers, with x-penfield-downgraded naming the Claude target', async () => {
    const response = await post({ model: 'code-heavy', messages: MESSAGES, stream: true }, TOKEN.downgrade);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-penfield-downgraded')).toBe('claude/opus');
    expect(response.headers.get('x-penfield-target')).toBe('searle/qwen3.8:27b-mlx');
    expect((await response.text()).endsWith('data: [DONE]\n\n')).toBe(true);
    expect(chat_requests().at(-1)?.model).toBe('qwen3.8:27b-mlx');
    const row = await row_of(response.headers.get('x-penfield-decision'));
    expect(row).toMatchObject({
      caller: 'curl-downgrade',
      target: { kind: 'proxy', node: 'searle', model: 'qwen3.8:27b-mlx' },
      alternatives: [
        { kind: 'claude_decision', model: 'opus', effort: 'high' },
        { kind: 'claude_decision', model: 'sonnet', effort: 'high' },
      ],
      placement: { cold_load: true, degraded_from: 'claude/opus' },
      outcome: 'ok',
    });
    expect(row.reasons.at(-1)).toBe('wire: downgraded to searle/qwen3.8:27b-mlx');
    await no_lease_held();
  });

  test('api_key: an error naming Stage D, never a local answer in its place', async () => {
    const before = chat_requests().length;
    const response = await post({ model: 'code-heavy', messages: MESSAGES }, TOKEN.api_key);
    expect(response.status).toBe(501);
    const { error } = (await response.json()) as { error: { message: string; code: string; decision_id: string } };
    expect(error.code).toBe('not_implemented');
    expect(error.message).toMatch(/claude\/opus at high.*api_key.*Stage D/);
    expect(response.headers.get('x-penfield-decision')).toBe(error.decision_id);
    expect(chat_requests()).toHaveLength(before);
    expect(await row_of(error.decision_id)).toMatchObject({ target: { kind: 'claude_decision' }, outcome: 'refused' });
  });
});
