import { describe, expect, test } from 'vitest';

import { load_config } from '../../config/index.js';
import { check_bind, create_server, unknown_states } from '../index.js';

const CONFIG = `version: 1
nodes:
  searle: { kind: ollama, url: http://192.168.1.90:11434, privacy: lan }
  claude: { kind: claude_decision, models: [opus] }
`;

describe('/healthz', () => {
  test('answers 200 with every configured node, unknown until the prober reports', async () => {
    const loaded = load_config(CONFIG);
    if (!loaded.ok) throw new Error('the config should load');
    const app = create_server({ node_states: () => unknown_states(loaded.config) });
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      nodes: [
        { name: 'searle', kind: 'ollama', state: 'unknown' },
        { name: 'claude', kind: 'claude_decision', state: 'unknown' },
      ],
    });
    await app.close();
  });

  test('reads the node states on every request', async () => {
    let state = 'unknown';
    const app = create_server({ node_states: () => [{ name: 'searle', kind: 'ollama', state }] });
    state = 'up';
    expect((await app.inject({ url: '/healthz' })).json()).toMatchObject({ nodes: [{ state: 'up' }] });
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
