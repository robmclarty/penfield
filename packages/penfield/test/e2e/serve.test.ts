import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { run_cli } from '../../src/cli.js';

// `penfield serve` and `check-config` through the bin's own entry, in-process: the
// arguments, environment and streams are values, so no build is needed and the
// CLI's lines count toward coverage.

const EXAMPLE = fileURLToPath(new URL('../../../../deploy/penfield.example.yaml', import.meta.url));

type Collector = { text: () => string; write: (chunk: string) => boolean; until: (pattern: RegExp) => Promise<string> };

// A stream that keeps what was written, and resolves `until` with a pattern's first
// group once the text matches it.
const collector = (): Collector => {
  let text = '';
  let waiting: (() => void)[] = [];
  const until = (pattern: RegExp): Promise<string> =>
    new Promise((found) => {
      const look = (): void => {
        const match = pattern.exec(text);
        if (match === null) waiting.push(look);
        else found(match[1] ?? match[0]);
      };
      look();
    });
  return {
    text: () => text,
    write: (chunk) => {
      text += chunk;
      const woken = waiting;
      waiting = [];
      for (const look of woken) look();
      return true;
    },
    until,
  };
};

type Running = { out: Collector; err: Collector; exit: Promise<number>; stop: () => Promise<number> };

const serve = (args: string[], env: Record<string, string> = {}): Running => {
  const out = collector();
  const err = collector();
  const control = new AbortController();
  const exit = run_cli(['serve', ...args], { env, out, err, signal: control.signal });
  return {
    out,
    err,
    exit,
    stop: () => {
      control.abort();
      return exit;
    },
  };
};

const LISTENING = /^penfield listening on (\S+)$/m;

// The bound address from the banner, or the exit code and stderr if serve gave up.
const booted = (running: Running): Promise<string> => {
  const gave_up = running.exit.then((code) => {
    throw new Error(`serve exited ${code}: ${running.err.text()}`);
  });
  return Promise.race([running.out.until(LISTENING), gave_up]);
};

const instance = (running: Running): string => /instance {5}(\S+)/.exec(running.out.text())?.[1] ?? '';

const run = async (argv: string[], env: Record<string, string> = {}) => {
  const out = collector();
  const err = collector();
  const code = await run_cli(argv, { env, out, err });
  return { code, out: out.text(), err: err.text() };
};

let dir = '';
let state_dir = '';
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'penfield-serve-'));
  state_dir = join(dir, 'state');
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((running) => running.stop()));
  rmSync(dir, { recursive: true, force: true });
});

describe('serve', () => {
  test("boots on the laptop from the house config, D29's overrides applied, and answers /healthz", async () => {
    const tokens_file = join(dir, 'tokens');
    const running = start([
      '--config', EXAMPLE,
      '--listen', '127.0.0.1:0',
      '--state-dir', state_dir,
      '--tokens-file', tokens_file,
    ]);
    const address = await booted(running);
    expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(running.out.text()).toMatch(
      new RegExp(
        [
          `^penfield listening on ${address}`,
          `  config       ${resolve(EXAMPLE)}`,
          '  instance     [\\da-f]{8}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{12}',
          `  state_dir    ${state_dir}`,
          `  tokens_file  ${tokens_file}`,
          '$',
        ].join('\\n'),
      ),
    );

    const response = await fetch(`${address}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      nodes: [
        { name: 'searle', kind: 'ollama', state: 'unknown' },
        { name: 'claude', kind: 'claude_decision', state: 'unknown' },
      ],
    });
    expect(existsSync(join(state_dir, 'penfield.db'))).toBe(true);

    expect(await running.stop()).toBe(0);
    await expect(fetch(`${address}/healthz`)).rejects.toThrow();
  });

  test('reads the config path from PENFIELD_CONFIG', async () => {
    const running = start(['--listen', '127.0.0.1:0', '--state-dir', state_dir], { PENFIELD_CONFIG: EXAMPLE });
    expect(await booted(running)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test('--config beats PENFIELD_CONFIG', async () => {
    const running = start(['--config', EXAMPLE, '--listen', '127.0.0.1:0', '--state-dir', state_dir], {
      PENFIELD_CONFIG: join(dir, 'missing.yaml'),
    });
    await booted(running);
    expect(running.out.text()).toContain(`config       ${resolve(EXAMPLE)}`);
  });

  test('a new boot mints a new instance id over the same state dir', async () => {
    const first = start(['--config', EXAMPLE, '--listen', '127.0.0.1:0', '--state-dir', state_dir]);
    await booted(first);
    await first.stop();
    const second = start(['--config', EXAMPLE, '--listen', '127.0.0.1:0', '--state-dir', state_dir]);
    await booted(second);
    expect(instance(second)).not.toBe(instance(first));
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
