import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, expect, test, vi } from 'vitest';

import type { FakeOllama } from '../helpers/fake_ollama.js';
import { start_fake_ollama } from '../helpers/fake_ollama.js';
import { booted, house_config, serve, TOKENS } from '../helpers/run_serve.js';
import type { Running } from '../helpers/run_serve.js';

// Plan step 14 against the fake Ollama: POST /v1/embeddings with `auto` is routed
// by shape to `embed` (D35) and forwarded to its candidate on searle.

const TOKEN = { rob: 'tok_rob_5f2a9c1e', zed: 'tok_zed-native_7b3d0e4a' };

const EMBED = 'nomic-embed-text:latest';

let dir = '';
let ollama: FakeOllama;
let running: Running;
let address = '';

const post = (body: unknown, token = TOKEN.rob): Promise<Response> =>
  fetch(`${address}/v1/embeddings`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'penfield-embeddings-'));
  ollama = await start_fake_ollama({ tags: ['qwen3.6:35b-mlx', EMBED], resident: ['qwen3.6:35b-mlx'], embedding: [EMBED] });
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

test('auto lands on the embed candidate, by shape, and the node answers in its own shape', async () => {
  const sent = { model: 'auto', input: ['penfield routes', 'by shape'] };
  const response = await post(sent);
  expect(response.status).toBe(200);
  expect(response.headers.get('x-penfield-target')).toBe(`searle/${EMBED}`);
  expect(response.headers.get('x-penfield-rung')).toBe('shape');
  expect(await response.json()).toMatchObject({ object: 'list', model: EMBED });
  const upstream = ollama.requests.findLast(({ url }) => url === '/v1/embeddings');
  expect(upstream?.body).toBe(JSON.stringify({ ...sent, model: EMBED }));
  const id = response.headers.get('x-penfield-decision');
  await vi.waitFor(async () => {
    const logged = await fetch(`${address}/decisions?limit=1`, { headers: { authorization: `Bearer ${TOKEN.rob}` } });
    const { decisions } = (await logged.json()) as { decisions: Record<string, unknown>[] };
    expect(decisions[0]).toMatchObject({ id, profile: 'embed', rung: 'shape', outcome: 'ok', upstream_status: 200 });
  });
});

test('a Claude decision on the embeddings endpoint is refused: there is no message to hint in', async () => {
  const response = await post({ model: 'code-heavy', input: 'penfield' }, TOKEN.zed);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: { message: 'penfield decided claude/opus at high, a Claude decision, which answers no embeddings request' },
  });
});
