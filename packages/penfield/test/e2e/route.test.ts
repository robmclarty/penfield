import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { DB_FILE } from '../../src/index.js';
import type { FakeOllama } from '../helpers/fake_ollama.js';
import { start_fake_ollama } from '../helpers/fake_ollama.js';
import { booted, house_config, serve, TOKENS } from '../helpers/run_serve.js';
import type { Running } from '../helpers/run_serve.js';

// Plan step 12 against the fake Ollama, with one chat model resident: POST /route
// decides dry and logs the row, and GET /decisions reads it back as it was sent.

const TOKEN = {
  rob: 'tok_rob_5f2a9c1e',
  night_shift: 'tok_night-shift_1c8e6f2b',
};

const TAGS = ['qwen3.8:27b-mlx', 'qwen3.6:35b-mlx', 'gemma4:26b', 'nomic-embed-text:latest'];

const QUESTION = { model: 'auto', messages: [{ role: 'user', content: 'what is the capital of France?' }] };

let dir = '';
let ollama: FakeOllama;
let running: Running;
let address = '';

const authorized = (token: string) => ({ authorization: `Bearer ${token}` });

const post = (body: unknown, token: string): Promise<Response> =>
  fetch(`${address}/route`, {
    method: 'POST',
    headers: { ...authorized(token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const get = async (path: string, token = TOKEN.rob): Promise<{ status: number; body: unknown }> => {
  const response = await fetch(`${address}${path}`, { headers: authorized(token) });
  return { status: response.status, body: await response.json() };
};

type Decision = { id: string; request_id: string; at: string; caller: string; policy: unknown };

const decided = async (body: unknown, token: string): Promise<Decision> => {
  const response = await post(body, token);
  expect(response.status).toBe(200);
  return (await response.json()) as Decision;
};

const logged = async (query: string): Promise<Decision[]> => {
  const { status, body } = await get(`/decisions?${query}`);
  expect(status).toBe(200);
  return (body as { decisions: Decision[] }).decisions;
};

// What a dry decision's row adds to it: the outcome columns, all still empty.
const DRY = { outcome: null, first_byte_ms: null, total_ms: null, bytes_out: null, upstream_status: null, upstream_prompt_tokens: null };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'penfield-route-'));
  ollama = await start_fake_ollama({ tags: TAGS, resident: ['qwen3.6:35b-mlx'] });
  running = serve([
    '--config', house_config(dir, ollama.url),
    '--listen', '127.0.0.1:0',
    '--state-dir', join(dir, 'state'),
    '--tokens-file', TOKENS,
  ]);
  address = await booted(running);
  await vi.waitFor(async () => {
    const { body } = await get('/healthz');
    expect((body as { nodes: unknown[] }).nodes[0]).toMatchObject({ name: 'searle', state: 'up' });
  });
});

afterAll(async () => {
  await running.stop();
  await ollama.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /route decides dry', () => {
  test('auto with a short question: rule, chat, the resident model, its ranked alternatives and reasons', async () => {
    const response = await post(QUESTION, TOKEN.rob);
    const decision = (await response.json()) as Decision;
    expect(response.headers.get('x-penfield-decision')).toBe(decision.id);
    expect(response.headers.get('x-penfield-request')).toBe(decision.request_id);
    expect(decision).toMatchObject({
      caller: 'rob',
      profile: 'chat',
      rung: 'rule',
      confidence: 1,
      target: { kind: 'proxy', node: 'searle', model: 'qwen3.6:35b-mlx', format: 'openai' },
      // Under the house's `cold_load: avoid`, a Claude decision ranks before a cold load.
      alternatives: [
        { kind: 'claude_decision', model: 'sonnet', effort: 'low' },
        { kind: 'proxy', node: 'searle', model: 'qwen3.8:27b-mlx', format: 'openai' },
      ],
      placement: { resident: true, cold_load: false, waited_ms: 0 },
      policy: { max_privacy: 'cloud', busy: 'degrade' },
      reasons: ['alias: "auto" runs the ladder', 'rule 8 (chat): chat', 'place: chose searle/qwen3.6:35b-mlx, resident, 2 of 2 slots free'],
    });
  });

  test('code-heavy for rob is opus at high, a decision his own client runs', async () => {
    const decision = await decided({ ...QUESTION, model: 'code-heavy' }, TOKEN.rob);
    expect(decision).toMatchObject({ profile: 'code-heavy', target: { kind: 'claude_decision', model: 'opus', effort: 'high' } });
  });

  test('code-heavy for night-shift is the local candidate, the cloud ones refused in its reasons', async () => {
    const decision = await decided({ ...QUESTION, model: 'code-heavy' }, TOKEN.night_shift);
    expect(decision).toMatchObject({
      profile: 'code-heavy',
      target: { kind: 'proxy', node: 'searle', model: 'qwen3.8:27b-mlx' },
      policy: { max_privacy: 'lan', busy: 'wait', wait_ms: 120_000 },
    });
    const { reasons } = decision as Decision & { reasons: string[] };
    expect(reasons).toContain("place: skipped claude/opus: cloud is above caller night-shift's max_privacy lan");
    expect(reasons).toContain("place: skipped claude/sonnet: cloud is above caller night-shift's max_privacy lan");
  });

  test('an embeddings body is read as one, and shape routes it to embed (D35)', async () => {
    const decision = await decided({ model: 'auto', input: 'penfield' }, TOKEN.rob);
    expect(decision).toMatchObject({ profile: 'embed', rung: 'shape', target: { kind: 'proxy', model: 'nomic-embed-text:latest' } });
  });

  test('no lease is held after the call', async () => {
    await decided(QUESTION, TOKEN.rob);
    const { body } = await get('/catalogue');
    const models = (body as { models: { ref: string; slots_in_use: number }[] }).models;
    expect(models.filter(({ slots_in_use }) => slots_in_use > 0)).toEqual([]);
  });
});

describe('the decisions row', () => {
  test('equals the response, policy included (D43)', async () => {
    const decision = await decided(QUESTION, TOKEN.rob);
    expect(await logged('caller=rob&limit=1')).toEqual([{ ...decision, ...DRY }]);
    const db = new DatabaseSync(join(dir, 'state', DB_FILE), { readOnly: true });
    const row = db.prepare('select policy, prompt, input from decisions where id = ?').get(decision.id);
    db.close();
    expect(JSON.parse(String(row?.['policy']))).toEqual(decision.policy);
    // rob keeps prompts; the input keeps the rest of the request without its text (D31).
    expect(JSON.parse(String(row?.['prompt']))).toEqual({ text: 'what is the capital of France?', system_text: '' });
    expect(JSON.parse(String(row?.['input']))).not.toHaveProperty('text');
  });

  test("a refusal reads back with its reason: the ladder's, and the policy's 403", async () => {
    const unknown = await decided({ ...QUESTION, model: 'nope' }, TOKEN.rob);
    expect(unknown).toMatchObject({ target: { kind: 'refused' } });
    expect(await logged('caller=rob&limit=1')).toEqual([{ ...unknown, ...DRY, outcome: 'refused' }]);

    const forbidden = await post({ ...QUESTION, model: 'claude/opus' }, TOKEN.night_shift);
    expect(forbidden.status).toBe(403);
    const reason = 'caller night-shift may not use "claude/opus": node claude is cloud, above its max_privacy lan';
    const { error } = (await forbidden.json()) as { error: { message: string; decision_id: string } };
    expect(error).toMatchObject({ message: reason, code: 'forbidden' });
    const [row] = await logged('caller=night-shift&limit=1');
    expect(row).toMatchObject({ id: error.decision_id, target: { kind: 'refused', reason }, alternatives: [], outcome: 'refused' });
  });

  test('a body the router cannot read is a 400 and no row', async () => {
    const before = await logged('limit=1000');
    const response = await post({ messages: [] }, TOKEN.rob);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { message: 'penfield cannot route this body: the body names no model', code: 'invalid_request' } });
    expect(await logged('limit=1000')).toHaveLength(before.length);
  });
});

describe('GET /decisions?caller=&since=&limit=', () => {
  test('returns rows newest first, by caller, since a time, up to a limit', async () => {
    const first = await decided(QUESTION, TOKEN.rob);
    const second = await decided(QUESTION, TOKEN.night_shift);
    const third = await decided(QUESTION, TOKEN.rob);
    expect((await logged('limit=3')).map(({ id }) => id)).toEqual([third.id, second.id, first.id]);
    const night = await logged('caller=night-shift');
    expect(night[0]?.id).toBe(second.id);
    expect(night.every(({ caller }) => caller === 'night-shift')).toBe(true);
    const since = await logged(`since=${encodeURIComponent(second.at)}`);
    expect(since.map(({ id }) => id).slice(0, 2)).toEqual([third.id, second.id]);
    expect(since.every(({ at }) => at >= second.at)).toBe(true);
    expect(await logged('caller=rob&limit=2')).toHaveLength(2);
  });

  test('a query it cannot read is a 400 in the envelope', async () => {
    const { status, body } = await get('/decisions?limit=0');
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: 'invalid_request', message: expect.stringMatching(/^penfield cannot read this query: limit: /) } });
    expect((await get('/decisions?since=yesterday-ish')).status).toBe(400);
  });
});
