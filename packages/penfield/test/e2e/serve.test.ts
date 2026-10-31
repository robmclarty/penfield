import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { run_cli } from '../../src/cli.js';
import type { FakeOllama } from '../helpers/fake_ollama.js';
import { start_fake_ollama } from '../helpers/fake_ollama.js';
import { booted, collector, EXAMPLE, house_config, serve, TOKENS } from '../helpers/run_serve.js';
import type { Running } from '../helpers/run_serve.js';

// `penfield serve` and `check-config` through the bin's own entry, in-process. A
// boot runs the house config with searle on a fake Ollama, so no test reaches the
// real one, and the tokens fixture as its tokens file.

const instance = (running: Running): string => /instance {5}(\S+)/.exec(running.out.text())?.[1] ?? '';

const run = async (argv: string[], env: Record<string, string> = {}) => {
  const out = collector();
  const err = collector();
  const code = await run_cli(argv, { env, out, err });
  return { code, out: out.text(), err: err.text() };
};

let dir = '';
let state_dir = '';
let house = '';
let ollama: FakeOllama;
let servers: Running[] = [];

const start = (args: string[], env: Record<string, string> = {}): Running => {
  const running = serve(args, env);
  servers.push(running);
  return running;
};

const write_config = (name: string, text: string): string => {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
};

// What every boot on the laptop passes, D29's overrides.
const laptop = (): string[] => ['--listen', '127.0.0.1:0', '--state-dir', state_dir, '--tokens-file', TOKENS];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'penfield-serve-'));
  state_dir = join(dir, 'state');
  servers = [];
  ollama = await start_fake_ollama({ tags: ['qwen3.8:27b-mlx'], resident: ['qwen3.8:27b-mlx'] });
  house = house_config(dir, ollama.url);
});

afterEach(async () => {
  await Promise.all(servers.map((running) => running.stop()));
  await ollama.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('serve', () => {
  test("boots on the laptop from the house config, D29's overrides applied, and answers /healthz", async () => {
    const running = start(['--config', house, ...laptop()]);
    const address = await booted(running);
    expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(running.out.text()).toMatch(
      new RegExp(
        [
          `^penfield listening on ${address}`,
          `  config       ${resolve(house)}`,
          '  instance     [\\da-f]{8}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{12}',
          `  state_dir    ${state_dir}`,
          `  tokens_file  ${TOKENS}`,
          '  callers      night-shift, nurselog, rob, zed-native',
          '$',
        ].join('\\n'),
      ),
    );

    // The prober reads searle at boot; until then it is unknown.
    await vi.waitFor(async () => {
      const response = await fetch(`${address}/healthz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: 'ok',
        nodes: [
          { name: 'searle', kind: 'ollama', state: 'up', breaker: 'closed' },
          { name: 'claude', kind: 'claude_decision', state: 'up', breaker: 'closed' },
        ],
      });
    });
    expect(ollama.requests.map(({ url }) => url)).toContain('/api/version');
    expect(existsSync(join(state_dir, 'penfield.db'))).toBe(true);

    expect(await running.stop()).toBe(0);
    await expect(fetch(`${address}/healthz`)).rejects.toThrow();
  });

  test('reads the config path from PENFIELD_CONFIG', async () => {
    const running = start(laptop(), { PENFIELD_CONFIG: house });
    expect(await booted(running)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test('--config beats PENFIELD_CONFIG', async () => {
    const running = start(['--config', house, ...laptop()], { PENFIELD_CONFIG: join(dir, 'missing.yaml') });
    await booted(running);
    expect(running.out.text()).toContain(`config       ${resolve(house)}`);
  });

  test('a new boot mints a new instance id over the same state dir', async () => {
    const first = start(['--config', house, ...laptop()]);
    await booted(first);
    await first.stop();
    const second = start(['--config', house, ...laptop()]);
    await booted(second);
    expect(instance(second)).not.toBe(instance(first));
  });

  test('an empty tokens file boots, and says every request but /healthz is refused', async () => {
    const running = start(['--config', house, ...laptop(), '--tokens-file', write_config('tokens', '# none yet\n')]);
    await booted(running);
    expect(running.out.text()).toContain('  callers      none: every request but /healthz is refused\n');
  });
});

describe('serve refuses', () => {
  test('a config that listens on 0.0.0.0, with the C5 reason', async () => {
    const file = write_config(
      'any.yaml',
      'version: 1\nserver: { listen: 0.0.0.0:7777 }\nnodes:\n  searle: { kind: ollama, url: http://192.168.1.90:11434, privacy: lan }\n',
    );
    const running = start(['--config', file, '--state-dir', state_dir]);
    expect(await running.exit).toBe(1);
    expect(running.err.text()).toBe(
      'penfield: refusing to listen on 0.0.0.0, every interface (C5): name the LAN address, or pass --allow-any-interface\n',
    );
    expect(existsSync(state_dir)).toBe(false);
  });

  test.each(['0.0.0.0:0', '[::]:0'])('--listen %s', async (listen) => {
    const running = start(['--config', EXAMPLE, '--listen', listen, '--state-dir', state_dir]);
    expect(await running.exit).toBe(1);
    expect(running.err.text()).toMatch(/\(C5\)/);
  });

  test('a --listen that is not host:port', async () => {
    const running = start(['--config', EXAMPLE, '--listen', 'plato', '--state-dir', state_dir]);
    expect(await running.exit).toBe(1);
    expect(running.err.text()).toBe('penfield: listen "plato" is not host:port\n');
  });

  test('no config at all', async () => {
    const running = start(['--listen', '127.0.0.1:0']);
    expect(await running.exit).toBe(1);
    expect(running.err.text()).toBe('penfield: no config: pass --config, or set PENFIELD_CONFIG\n');
  });

  test('a config that does not load, with its line and column', async () => {
    const file = write_config('bad.yaml', 'version: 1\nnodes:\n  searle: { kind: ollama, url: http://x:1, privacy: lan, slot: 2 }\n');
    const running = start(['--config', file]);
    expect(await running.exit).toBe(1);
    expect(running.err.text()).toBe(`${file}:3:58 nodes.searle.slot: unknown key "slot"\n`);
  });

  test('a tokens file that is missing, before it opens the state dir', async () => {
    const running = start(['--config', house, '--listen', '127.0.0.1:0', '--state-dir', state_dir, '--tokens-file', join(dir, 'nope')]);
    expect(await running.exit).toBe(1);
    expect(running.err.text()).toMatch(new RegExp(`^${join(dir, 'nope')} cannot read the tokens file: ENOENT`));
    expect(existsSync(state_dir)).toBe(false);
  });

  test('a tokens file naming a caller penfield.yaml lacks, with its line', async () => {
    const tokens = write_config('tokens', 'rob: tok_rob_5f2a9c1e\nbob: tok_bob_0d1e2f3a\n');
    const running = start(['--config', house, '--listen', '127.0.0.1:0', '--state-dir', state_dir, '--tokens-file', tokens]);
    expect(await running.exit).toBe(1);
    expect(running.err.text()).toBe(`${tokens}:2 caller "bob" is not in penfield.yaml's callers\n`);
  });

  test('an option it does not know', async () => {
    const running = start(['--config', EXAMPLE, '--port', '7777']);
    expect(await running.exit).toBe(1);
    expect(running.err.text()).toMatch(/^penfield: .*--port/);
  });
});

describe('the rest of the bin', () => {
  test('check-config prints the house config with its defaults', async () => {
    const result = await run(['check-config', EXAMPLE]);
    expect(result).toMatchObject({ code: 0, err: '' });
    expect(result.out).toContain('listen: 192.168.1.89:7777');
    expect(result.out).toContain('open_after: 3');
  });

  test('check-config reads PENFIELD_CONFIG, and says so when there is none', async () => {
    expect((await run(['check-config'], { PENFIELD_CONFIG: EXAMPLE })).code).toBe(0);
    expect(await run(['check-config'])).toEqual({
      code: 1,
      out: '',
      err: 'penfield: no config: pass --config, or set PENFIELD_CONFIG\n',
    });
  });

  test('help prints the usage; an unknown command or none is a usage error', async () => {
    expect(await run(['help'])).toMatchObject({ code: 0, out: expect.stringMatching(/^usage: penfield/) });
    expect(await run(['serv'])).toMatchObject({ code: 2, err: expect.stringMatching(/^penfield: unknown command "serv"/) });
    expect(await run([])).toMatchObject({ code: 2, err: expect.stringMatching(/^usage: penfield/) });
  });
});
