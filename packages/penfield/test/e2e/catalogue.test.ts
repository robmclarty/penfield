import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import type { FakeOllama } from '../helpers/fake_ollama.js';
import { start_fake_ollama } from '../helpers/fake_ollama.js';
import { booted, house_config, serve, TOKENS } from '../helpers/run_serve.js';
import type { Running } from '../helpers/run_serve.js';

// Plan step 7 against the fake Ollama: `serve` boots the house config with searle
// on the fake and the tokens fixture, and `/v1/models` and `/catalogue` answer
// each caller by its policy (D10, D38) once the prober has read searle.

const TOKEN = {
  rob: 'tok_rob_5f2a9c1e',
  night_shift: 'tok_night-shift_1c8e6f2b',
  nurselog: 'tok_nurselog_9a4b7d3c',
};

const ALIASES = ['auto', 'auto/fast', 'auto/private', 'auto/best'];
const PROFILES = ['embed', 'classify', 'extract', 'summarize', 'chat', 'code-light', 'code-heavy', 'reason'];
const TAGS = ['qwen3.8:27b-mlx', 'qwen3.6:35b-mlx', 'gemma4:26b', 'nomic-embed-text:latest'];
const CLAUDE = ['claude/haiku', 'claude/sonnet', 'claude/opus'];

let dir = '';
let ollama: FakeOllama;
let running: Running;
let address = '';

const get = (path: string, token?: string): Promise<Response> =>
  fetch(`${address}${path}`, token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } });

type Listed = { id: string; owned_by: string; penfield: { kind: string } };

const model_ids = async (token: string): Promise<string[]> => {
  const body = (await (await get('/v1/models', token)).json()) as { data: Listed[] };
  return body.data.map(({ id }) => id);
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'penfield-catalogue-'));
  ollama = await start_fake_ollama({ tags: TAGS, resident: ['qwen3.6:35b-mlx', 'qwen3.8:27b-mlx'] });
  running = serve([
    '--config', house_config(dir, ollama.url),
    '--listen', '127.0.0.1:0',
    '--state-dir', join(dir, 'state'),
    '--tokens-file', TOKENS,
  ]);
  address = await booted(running);
  await vi.waitFor(async () => {
    const health = (await (await get('/healthz')).json()) as { nodes: { name: string; state: string }[] };
    expect(health.nodes[0]).toMatchObject({ name: 'searle', state: 'up' });
  });
});

afterAll(async () => {
  await running.stop();
  await ollama.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a caller token (C5, D21)', () => {
  test.each(['/v1/models', '/catalogue', '/nowhere'])('none is a 401 on %s', async (path) => {
    const response = await get(path);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        message: 'penfield needs a caller token: send Authorization: Bearer <token>',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    });
  });

  test('an unknown one is a 401, and so is a known one under the wrong scheme', async () => {
    const unknown = await get('/v1/models', 'tok_rob_00000000');
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toMatchObject({ error: { message: 'penfield does not know that token' } });
    const basic = await fetch(`${address}/v1/models`, { headers: { authorization: `Basic ${TOKEN.rob}` } });
    expect(basic.status).toBe(401);
  });

  test('/healthz needs none', async () => {
    expect((await get('/healthz')).status).toBe(200);
  });
});

describe('GET /v1/models', () => {
  test("lists rob's auto, the aliases, the profiles, then the tags and the claude models", async () => {
    expect(await model_ids(TOKEN.rob)).toEqual([...ALIASES, ...PROFILES, ...TAGS, ...CLAUDE]);
  });

  test('each entry is an OpenAI model with owned_by its node and a penfield object', async () => {
    const response = await get('/v1/models', TOKEN.rob);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { object: string; data: Listed[] };
    expect(body.object).toBe('list');
    const by_id = new Map(body.data.map((entry) => [entry.id, entry]));
    expect(by_id.get('auto')).toEqual({
      id: 'auto',
      object: 'model',
      created: 0,
      owned_by: 'penfield',
      penfield: { kind: 'alias', ladder: 'default' },
    });
    expect(by_id.get('auto/private')?.penfield).toEqual({ kind: 'alias', ladder: 'default', max_privacy: 'lan' });
    expect(by_id.get('chat')).toMatchObject({ owned_by: 'penfield', penfield: { kind: 'profile' } });
    expect(by_id.get('qwen3.6:35b-mlx')).toEqual({
      id: 'qwen3.6:35b-mlx',
      object: 'model',
      created: 0,
      owned_by: 'searle',
      penfield: {
        kind: 'model',
        node: 'searle',
        ref: 'searle/qwen3.6:35b-mlx',
        resident: true,
        pinned: false,
        profiles: ['code-light', 'chat', 'summarize', 'extract'],
      },
    });
    expect(by_id.get('gemma4:26b')?.penfield).toMatchObject({ resident: false, profiles: ['chat', 'summarize', 'classify'] });
    expect(by_id.get('qwen3.8:27b-mlx')?.penfield).toMatchObject({ resident: true, pinned: true });
    expect(by_id.get('claude/opus')).toMatchObject({
      owned_by: 'claude',
      penfield: { kind: 'model', resident: null, profiles: ['code-heavy', 'reason'] },
    });
  });

  test('night-shift, at max_privacy lan, sees no claude/*', async () => {
    expect(await model_ids(TOKEN.night_shift)).toEqual([...ALIASES, ...PROFILES, ...TAGS]);
  });

  test('nurselog sees only its two allowed models, beside the aliases and profiles', async () => {
    expect(await model_ids(TOKEN.nurselog)).toEqual([
      ...ALIASES,
      ...PROFILES,
      'qwen3.8:27b-mlx',
      'nomic-embed-text:latest',
    ]);
  });
});

describe('GET /catalogue', () => {
  test('shows nodes, models, residency, pins, breaker state and slots in use', async () => {
    const response = await get('/catalogue', TOKEN.night_shift);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      nodes: unknown[];
      models: { ref: string; residency: string; pinned: boolean; breaker: string; slots: number | null; slots_in_use: number }[];
      warnings: { candidate: string }[];
    };
    expect(body.nodes).toEqual([
      expect.objectContaining({ name: 'searle', kind: 'ollama', privacy: 'lan', state: 'up', breaker: 'closed' }),
      expect.objectContaining({ name: 'claude', kind: 'claude_decision', privacy: 'cloud', state: 'up', breaker: 'closed' }),
    ]);
    expect(body.models.map(({ ref, residency, pinned, breaker, slots, slots_in_use }) => [ref, residency, pinned, breaker, slots, slots_in_use])).toEqual([
      ['searle/qwen3.8:27b-mlx', 'resident', true, 'closed', 1, 0],
      ['searle/qwen3.6:35b-mlx', 'resident', false, 'closed', 2, 0],
      ['searle/gemma4:26b', 'cold', false, 'closed', 2, 0],
      ['searle/nomic-embed-text:latest', 'cold', false, 'closed', 2, 0],
      ['claude/haiku', 'unknown', false, 'closed', null, 0],
      ['claude/sonnet', 'unknown', false, 'closed', null, 0],
      ['claude/opus', 'unknown', false, 'closed', null, 0],
    ]);
    // The house profiles name models the fake does not have.
    expect(body.warnings.map(({ candidate }) => candidate)).toEqual([
      'qwen3-embedding:0.6b',
      'qwen3:4b-instruct-2507-q4_K_M',
      'gemma4:e4b',
      'qwen3:4b-instruct-2507-q4_K_M',
    ]);
  });
});
