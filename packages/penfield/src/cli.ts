#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { check_config, format_issues, parse_listen, read_config } from './config/index.js';
import type { Config, Listen } from './config/index.js';
import { open_db } from './log/index.js';
import { check_bind, create_server, start_server, unknown_states } from './wire/index.js';

// The `penfield` bin. `run_cli` takes its arguments, environment, output streams and
// stop signal as values, so tests drive it in-process; the guard at the bottom wires
// the process.

export type CliWriter = { write: (text: string) => unknown };

export type CliContext = {
  env: Record<string, string | undefined>;
  out: CliWriter;
  err: CliWriter;
  // Aborting it shuts `serve` down; the bin aborts it on SIGINT and SIGTERM.
  signal?: AbortSignal;
};

const USAGE = `usage: penfield <command> [options]

commands:
  serve                 run the gateway
    --config <path>         penfield.yaml
    --listen <host:port>    overrides server.listen
    --state-dir <dir>       overrides server.state_dir
    --tokens-file <path>    overrides server.tokens_file
    --allow-any-interface   permits a listen address of 0.0.0.0 or ::
  check-config [path]   validate penfield.yaml and print it with every default applied

The config path is the argument, else --config, else PENFIELD_CONFIG.
`;

const NO_CONFIG = 'penfield: no config: pass --config, or set PENFIELD_CONFIG\n';

const config_path = (
  positional: string | undefined,
  flag: string | undefined,
  env: CliContext['env'],
): string | undefined => positional ?? flag ?? env['PENFIELD_CONFIG'];

const run_check_config = async (args: string[], ctx: CliContext): Promise<number> => {
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' } },
    allowPositionals: true,
  });
  const file = config_path(positionals[0], values.config, ctx.env);
  if (file === undefined) {
    ctx.err.write(NO_CONFIG);
    return 1;
  }
  const result = await check_config(file);
  ctx.out.write(result.out);
  ctx.err.write(result.err);
  return result.code;
};

const SERVE_OPTIONS = {
  config: { type: 'string' },
  listen: { type: 'string' },
  'state-dir': { type: 'string' },
  'tokens-file': { type: 'string' },
  'allow-any-interface': { type: 'boolean' },
} as const;

type ServeFlags = ReturnType<typeof parseArgs<{ args: string[]; options: typeof SERVE_OPTIONS }>>['values'];

// D29: the flags override the file, so the laptop can run plato's config.
const with_overrides = (config: Config, flags: ServeFlags): Config => ({
  ...config,
  server: {
    ...config.server,
    listen: flags.listen ?? config.server.listen,
    state_dir: flags['state-dir'] ?? config.server.state_dir,
    tokens_file: flags['tokens-file'] ?? config.server.tokens_file,
  },
});

const banner = (address: string, file: string, config: Config, instance_id: string): string =>
  [
    `penfield listening on ${address}`,
    `  config       ${resolve(file)}`,
    `  instance     ${instance_id}`,
    `  state_dir    ${config.server.state_dir}`,
    `  tokens_file  ${config.server.tokens_file}`,
    '',
  ].join('\n');

const stopped = (signal: AbortSignal | undefined): Promise<void> =>
  new Promise((done) => {
    if (signal?.aborted === true) done();
    signal?.addEventListener('abort', () => done(), { once: true });
  });

// Everything `serve` checks before it opens a file or a socket: the config, the
// overrides and the C5 bind. A string is the refusal to print.
const resolve_serve = async (
  flags: ServeFlags,
  ctx: CliContext,
): Promise<{ file: string; config: Config; listen: Listen } | string> => {
  const file = config_path(undefined, flags.config, ctx.env);
  if (file === undefined) return NO_CONFIG;
  const loaded = await read_config(file);
  if (!loaded.ok) return format_issues(file, loaded.issues);
  const config = with_overrides(loaded.config, flags);
  const listen = parse_listen(config.server.listen);
  if (listen === undefined) return `penfield: listen "${config.server.listen}" is not host:port\n`;
  const refusal = check_bind(listen.host, flags['allow-any-interface'] === true);
  return refusal === undefined ? { file, config, listen } : `penfield: ${refusal}\n`;
};

const run_serve = async (args: string[], ctx: CliContext): Promise<number> => {
  const { values } = parseArgs({ args, options: SERVE_OPTIONS });
  const resolved = await resolve_serve(values, ctx);
  if (typeof resolved === 'string') {
    ctx.err.write(resolved);
    return 1;
  }
  const { file, config, listen } = resolved;
  const db = open_db(config.server.state_dir);
  const app = create_server({ node_states: () => unknown_states(config) });
  try {
    const address = await start_server(app, listen);
    ctx.out.write(banner(address, file, config, db.instance_id));
    await stopped(ctx.signal);
    return 0;
  } finally {
    await app.close();
    db.close();
  }
};

export const run_cli = async (argv: readonly string[], ctx: CliContext): Promise<number> => {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case 'serve':
        return await run_serve(args, ctx);
      case 'check-config':
        return await run_check_config(args, ctx);
      case 'help':
      case '--help':
        ctx.out.write(USAGE);
        return 0;
      default:
        ctx.err.write(`${command === undefined ? '' : `penfield: unknown command "${command}"\n\n`}${USAGE}`);
        return 2;
    }
  } catch (error) {
    ctx.err.write(`penfield: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};

if (import.meta.main) {
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  process.exitCode = await run_cli(process.argv.slice(2), {
    env: process.env,
    out: process.stdout,
    err: process.stderr,
    signal: stop.signal,
  });
}
