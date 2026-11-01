import { describe, expect, test } from 'vitest';

import { create_catalogue } from '../../catalogue/index.js';
import { system_clock } from '../../clock.js';
import { format_issues, load_config } from '../../config/index.js';
import type { Config } from '../../config/index.js';
import type { Leases } from '../../place/index.js';
import { check_bind, create_server } from '../index.js';

const CONFIG = `version: 1
nodes:
  searle: { kind: ollama, url: http://192.168.1.90:11434, privacy: lan }
  claude: { kind: claude_decision, models: [opus] }
`;

const loaded = (text: string): Config => {
  const result = load_config(text);
  if (!result.ok) throw new Error(format_issues('penfield.yaml', result.issues));
  return result.config;
};

// The chat routes are not reached here, so they get no lease table.
const NO_LEASES = {} as Leases;

const server = (config: Config, snapshot: ReturnType<typeof create_catalogue>['snapshot']) =>
  create_server({
    config,
    tokens: new Map(),
    snapshot,
    in_use: () => ({}),
    leases: NO_LEASES,
    clock: system_clock,
    log_decision: () => undefined,
    log_outcome: () => undefined,
    incident: () => undefined,
    read_decisions: () => [],
  });

describe('/healthz', () => {
  test('answers 200 with no token and every configured node, unknown until the prober reports', async () => {
    const config = loaded(CONFIG);
    const app = server(config, create_catalogue(config).snapshot);
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      nodes: [
        { name: 'searle', kind: 'ollama', state: 'unknown', breaker: 'closed' },
        { name: 'claude', kind: 'claude_decision', state: 'up', breaker: 'closed' },
      ],
    });
    await app.close();
  });

  test('reads the catalogue on every request', async () => {
    const config = loaded(CONFIG);
    const catalogue = create_catalogue(config);
    const app = server(config, catalogue.snapshot);
    catalogue.record_discovery({ node: 'searle', state: 'up', models: [] }, '2026-10-31T12:00:00.000Z');
    catalogue.record_breakers({ nodes: { searle: 'half_open' }, models: {} });
    expect((await app.inject({ url: '/healthz' })).json()).toMatchObject({
      nodes: [{ name: 'searle', state: 'up', breaker: 'half_open' }, { name: 'claude' }],
    });
    await app.close();
  });
});

describe('check_bind (C5)', () => {
  test.each(['0.0.0.0', '::', '0:0:0:0:0:0:0:0'])('refuses %s, every interface', (host) => {
    expect(check_bind(host, false)).toMatch(/^refusing to listen on .+ \(C5\): .+--allow-any-interface$/);
  });

  test.each(['0.0.0.0', '::'])('allows %s with --allow-any-interface', (host) => {
    expect(check_bind(host, true)).toBeUndefined();
  });

  test.each(['192.168.1.89', '127.0.0.1', '::1', 'localhost', 'plato.lan'])('allows %s', (host) => {
    expect(check_bind(host, false)).toBeUndefined();
  });
});
