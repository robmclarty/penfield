import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { fake_clock } from '../../../test/helpers/fake_clock.js';
import type { FakeServer } from '../../../test/helpers/fake_http.js';
import { start_fake_ollama } from '../../../test/helpers/fake_ollama.js';
import type { FakeOllamaState } from '../../../test/helpers/fake_ollama.js';
import { start_fake_openai } from '../../../test/helpers/fake_openai.js';
import { create_catalogue } from '../../catalogue/index.js';
import type { Catalogue } from '../../catalogue/index.js';
import { format_issues, load_config } from '../../config/index.js';
import type { Config } from '../../config/index.js';
import { log_incident, open_db } from '../../log/index.js';
import type { Db, Incident } from '../../log/index.js';
import { create_prober } from '../index.js';

const EVERY_MS = 10_000;
const HALF_OPEN_MS = 30_000;
// Healthy requests get a generous timeout, so a loaded test run cannot time them
// out; a test that waits on a hang uses the short one.
const TIMEOUT_MS = 2_000;
const HANG_MS = 300;

let dir = '';
let db: Db;
let fakes: FakeServer[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'penfield-probe-'));
  db = open_db(dir);
});

afterEach(async () => {
  await Promise.all(fakes.map((fake) => fake.close()));
  fakes = [];
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const loaded = (text: string): Config => {
  const result = load_config(text);
  if (!result.ok) throw new Error(format_issues('penfield.yaml', result.issues));
  return result.config;
};

type Options = { ready?: boolean; unload?: boolean; timeout_ms?: number; incident?: (incident: Incident) => void };

const QWEN = 'qwen3.6:35b-mlx';
const GEMMA = 'gemma4:26b';
const NOMIC = 'nomic-embed-text:latest';

// searle on a fake Ollama, its incidents into a real penfield.db, on a fake clock.
const searle = async (initial: Partial<FakeOllamaState> = {}, options: Options = {}) => {
  const timeout_ms = options.timeout_ms ?? TIMEOUT_MS;
  const ollama = await start_fake_ollama({ tags: [QWEN, GEMMA, NOMIC], resident: [QWEN], ...initial });
  fakes.push(ollama);
  const config = loaded(`version: 1
nodes:
  searle:
    kind: ollama
    url: "${ollama.url}"
    privacy: lan
    probe: { every_ms: ${EVERY_MS}, timeout_ms: ${timeout_ms}, open_after: 3, half_open_ms: ${HALF_OPEN_MS}, ready_prompt: ${options.ready === true} }
    recover: { unload_on_hang: ${options.unload === true} }
policy: { stall_ms: { first_token_cold: ${timeout_ms * 2} } }
profiles:
  chat: { candidates: [${QWEN}] }
`);
  const clock = fake_clock();
  const catalogue = create_catalogue(config);
  const errors: unknown[] = [];
  const prober = create_prober({
    config,
    env: {},
    catalogue,
    clock,
    incident: options.incident ?? ((incident) => void log_incident(db, incident)),
    on_error: (error) => void errors.push(error),
  });
  return { ollama, clock, catalogue, prober, errors };
};

const incidents = (): string[] =>
  db
    .all('select node, model, kind, detail from incidents order by rowid')
    .map(({ node, model, kind, detail }) => `${String(kind)} ${String(model ?? node)}: ${String(detail)}`);

const generates = (fake: FakeServer): unknown[] =>
  fake.requests.filter(({ url }) => url === '/api/generate').map(({ body }): unknown => JSON.parse(body));

const searle_node = (catalogue: Catalogue) => catalogue.nodes.find(({ name }) => name === 'searle');

describe('the node breaker', () => {
  test('three failed liveness probes open it, and one success in half-open closes it', async () => {
    const { ollama, clock, catalogue, prober } = await searle();
    await prober.tick();
    expect(incidents()).toEqual([]);

    ollama.state.fail = 'error';
    const version = `GET ${ollama.url}/api/version: HTTP 500`;
    await prober.tick();
    clock.advance(EVERY_MS);
    // Below the threshold the node keeps its models, so placement may still use it.
    expect(searle_node(catalogue.snapshot())).toMatchObject({ state: 'up', breaker: 'closed' });
    expect(catalogue.snapshot().models.map(({ ref }) => ref)).toContain(`searle/${QWEN}`);
    await prober.tick();
    clock.advance(EVERY_MS);
    await prober.tick();
    expect(incidents()).toEqual([
      `probe_fail searle: 1 of 3: ${version}`,
      `probe_fail searle: 2 of 3: ${version}`,
      `breaker_open searle: 3 failed in a row; last: ${version}`,
      `candidate_missing ${QWEN}: profile "chat": no node has "${QWEN}" (searle is down: ${version})`,
    ]);
    expect(searle_node(catalogue.snapshot())).toMatchObject({ state: 'down', breaker: 'open', reason: version });
    expect(catalogue.snapshot().models).toEqual([]);

    // While open, nothing is sent until half_open_ms has passed.
    const sent = ollama.requests.length;
    clock.advance(HALF_OPEN_MS - 1);
    await prober.tick();
    expect(ollama.requests.length).toBe(sent);

    ollama.state.fail = 'none';
    clock.advance(1);
    await prober.tick();
    expect(incidents().slice(4)).toEqual(['recovered searle: the half-open probe succeeded']);
    expect(searle_node(catalogue.snapshot())).toMatchObject({ state: 'up', breaker: 'closed', reason: null });
    expect(catalogue.snapshot().warnings).toEqual([]);
  });

  test('a failed half-open probe opens it again for another half_open_ms, with no new incident', async () => {
    const { ollama, clock, catalogue, prober } = await searle({ fail: 'error' });
    for (let tick = 0; tick < 3; tick += 1) {
      await prober.tick();
      clock.advance(EVERY_MS);
    }
    const before = incidents();
    clock.advance(HALF_OPEN_MS);
    await prober.tick();
    expect(incidents()).toEqual(before);
    const sent = ollama.requests.length;
    clock.advance(HALF_OPEN_MS - 1);
    await prober.tick();
    expect(ollama.requests.length).toBe(sent);
    expect(searle_node(catalogue.snapshot())).toMatchObject({ breaker: 'open' });
  });

  test('a node that never answers is down from its first probe, and its candidates are missing', async () => {
    const { catalogue, prober } = await searle({ fail: 'hang' }, { timeout_ms: HANG_MS });
    await prober.tick();
    expect(searle_node(catalogue.snapshot())).toMatchObject({ state: 'down', breaker: 'closed' });
    expect(incidents()[0]).toMatch(/^probe_fail searle: 1 of 3: GET .*\/api\/version: no answer in 300 ms$/);
    expect(incidents()[1]).toMatch(/^candidate_missing qwen3\.6:35b-mlx: /);
  });

  test('each tick refreshes the snapshot', async () => {
    const { ollama, catalogue, prober } = await searle();
    await prober.tick();
    const residency = () => catalogue.snapshot().models.map(({ id, residency: each }) => [id, each]);
    expect(residency()).toEqual([
      [QWEN, 'resident'],
      [GEMMA, 'cold'],
      [NOMIC, 'cold'],
    ]);
    ollama.state.resident = [GEMMA];
    await prober.tick();
    expect(residency()).toEqual([
      [QWEN, 'cold'],
      [GEMMA, 'resident'],
      [NOMIC, 'cold'],
    ]);
  });
});

describe('readiness (Q2)', () => {
  test('pings only the models /api/ps lists, and loads none', async () => {
    const { ollama, prober } = await searle({ resident: [QWEN, NOMIC] }, { ready: true });
    await prober.tick();
    expect(generates(ollama)).toEqual([
      { model: QWEN, prompt: '', stream: false },
      { model: NOMIC, prompt: '', stream: false },
    ]);
    expect(ollama.state.resident).toEqual([QWEN, NOMIC]);
    expect(incidents()).toEqual([]);
  });

  test('is off unless ready_prompt is on', async () => {
    const { ollama, prober } = await searle();
    await prober.tick();
    expect(generates(ollama)).toEqual([]);
  });

  test('runs every sixth interval, and at once after a failed probe', async () => {
    const { ollama, clock, prober } = await searle({}, { ready: true });
    const pinged = (): number => generates(ollama).length;
    await prober.tick();
    clock.advance(EVERY_MS * 5);
    await prober.tick();
    expect(pinged()).toBe(1);
    clock.advance(EVERY_MS);
    await prober.tick();
    expect(pinged()).toBe(2);
    ollama.state.fail = 'error';
    clock.advance(EVERY_MS);
    await prober.tick();
    ollama.state.fail = 'none';
    clock.advance(EVERY_MS);
    await prober.tick();
    expect(pinged()).toBe(3);
  });

  test('a hung resident model under unload_on_hang is unloaded once and re-pinged; success is recovered', async () => {
    const { ollama, catalogue, prober } = await searle({ hung: [QWEN] }, { ready: true, unload: true, timeout_ms: HANG_MS });
    await prober.tick();
    expect(generates(ollama)).toEqual([
      { model: QWEN, prompt: '', stream: false },
      { model: QWEN, keep_alive: 0 },
      { model: QWEN, prompt: '', stream: false },
    ]);
    expect(incidents()).toEqual([
      `probe_fail ${QWEN}: readiness: POST ${ollama.url}/api/generate: no answer in ${HANG_MS} ms; unloading it to reload`,
      `recovered ${QWEN}: unloaded and reloaded in 0 ms`,
    ]);
    expect(catalogue.snapshot().models.map(({ breaker }) => breaker)).toEqual(['closed', 'closed', 'closed']);
  });

  test("when the reload fails too, that model's breaker opens and the node's stays closed", async () => {
    const { ollama, catalogue, prober } = await searle(
      { hung: [QWEN], unload_clears_hang: false },
      { ready: true, unload: true, timeout_ms: HANG_MS },
    );
    await prober.tick();
    expect(generates(ollama)).toHaveLength(3);
    expect(incidents()).toEqual([
      `probe_fail ${QWEN}: readiness: POST ${ollama.url}/api/generate: no answer in ${HANG_MS} ms; unloading it to reload`,
      `breaker_open ${QWEN}: 1 failed in a row; last: reload: POST ${ollama.url}/api/generate: no answer in ${HANG_MS * 2} ms`,
    ]);
    const snapshot = catalogue.snapshot();
    expect(searle_node(snapshot)).toMatchObject({ state: 'up', breaker: 'closed' });
    expect(snapshot.models.map(({ id, breaker }) => [id, breaker])).toEqual([
      [QWEN, 'open'],
      [GEMMA, 'closed'],
      [NOMIC, 'closed'],
    ]);
  });

  test("without unload_on_hang, readiness failures count toward the model's breaker and nothing is unloaded", async () => {
    const { ollama, clock, catalogue, prober } = await searle({ hung: [QWEN] }, { ready: true, timeout_ms: HANG_MS });
    await prober.tick();
    for (let tick = 1; tick < 3; tick += 1) {
      clock.advance(EVERY_MS * 6);
      await prober.tick();
    }
    expect(incidents().map((line) => line.slice(0, line.indexOf(': ')))).toEqual([
      `probe_fail ${QWEN}`,
      `probe_fail ${QWEN}`,
      `breaker_open ${QWEN}`,
    ]);
    expect(generates(ollama)).not.toContainEqual({ model: QWEN, keep_alive: 0 });
    expect(catalogue.snapshot().models[0]?.breaker).toBe('open');

    // Past half_open_ms the next readiness ping is the half-open probe; one success closes it.
    ollama.state.hung = [];
    clock.advance(EVERY_MS * 6);
    await prober.tick();
    expect(incidents().at(-1)).toBe(`recovered ${QWEN}: the half-open probe succeeded`);
    expect(catalogue.snapshot().models[0]?.breaker).toBe('closed');
  });
});

describe('other nodes', () => {
  test('an OpenAI-compatible node is probed through /models with its key; a hand-listed one keeps its list', async () => {
    const openai = await start_fake_openai({ models: ['glm-4.7-flash'], api_key: 'key_fake_0123' });
    fakes.push(openai);
    const config = loaded(`version: 1
nodes:
  lab: { kind: openai_compatible, url: "${openai.url}/v1", privacy: lan, discover: false, models: [gemma4:26b], api_key_env: LAB_KEY }
  claude: { kind: claude_decision, models: [opus] }
`);
    const catalogue = create_catalogue(config);
    const prober = create_prober({
      config,
      env: { LAB_KEY: 'key_fake_0123' },
      catalogue,
      clock: fake_clock(),
      incident: (incident) => void log_incident(db, incident),
      on_error: () => undefined,
    });
    await prober.tick();
    expect(openai.requests.map(({ url }) => url)).toEqual(['/v1/models']);
    expect(catalogue.snapshot().nodes.map(({ name, state }) => [name, state])).toEqual([
      ['lab', 'up'],
      ['claude', 'up'],
    ]);
    expect(catalogue.snapshot().models.map(({ ref }) => ref)).toEqual(['lab/gemma4:26b', 'claude/opus']);
  });
});

describe('start and stop', () => {
  test('start probes at once, then every every_ms on the clock; stop cancels the next', async () => {
    const { ollama, clock, prober } = await searle();
    prober.start();
    await vi.waitFor(() => expect(clock.pending()).toBe(1));
    expect(ollama.requests).toHaveLength(3);
    clock.advance(EVERY_MS);
    await vi.waitFor(() => expect(ollama.requests).toHaveLength(6));
    await vi.waitFor(() => expect(clock.pending()).toBe(1));
    prober.stop();
    expect(clock.pending()).toBe(0);
    clock.advance(EVERY_MS * 10);
    expect(ollama.requests).toHaveLength(6);
  });

  test('a probe that throws goes to on_error, and probing goes on', async () => {
    const { clock, prober, errors } = await searle(
      { fail: 'error' },
      {
        incident: () => {
          throw new Error('disk full');
        },
      },
    );
    prober.start();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    await vi.waitFor(() => expect(clock.pending()).toBe(1));
    expect(errors[0]).toEqual(new Error('disk full'));
    prober.stop();
  });
});

describe('incidents', () => {
  test('land in the incidents table with an id and the clock time', async () => {
    const { prober } = await searle({ fail: 'error' });
    await prober.tick();
    expect(db.all('select * from incidents order by rowid')[0]).toEqual({
      id: expect.stringMatching(/^[\da-f-]{36}$/),
      at: '2026-10-31T12:00:00.000Z',
      node: 'searle',
      model: null,
      kind: 'probe_fail',
      detail: expect.stringContaining('1 of 3'),
    });
  });
});
