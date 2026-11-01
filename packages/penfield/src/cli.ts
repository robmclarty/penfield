#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { create_catalogue } from './catalogue/index.js';
import { system_clock } from './clock.js';
import { check_config, format_issues, parse_listen, read_config } from './config/index.js';
import type { Config, Listen } from './config/index.js';
import { log_incident, open_db } from './log/index.js';
import type { Incident } from './log/index.js';
import { create_leases, create_reaper, sweep_orphans } from './place/index.js';
import { create_prober } from './probe/index.js';
import { check_bind, create_server, read_tokens, start_server } from './wire/index.js';

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

type Resolved = { file: string; config: Config; listen: Listen; tokens: ReadonlyMap<string, string> };

const banner = ({ file, config, tokens }: Resolved, address: string, instance_id: string): string =>
  [
    `penfield listening on ${address}`,
    `  config       ${resolve(file)}`,
    `  instance     ${instance_id}`,
    `  state_dir    ${config.server.state_dir}`,
    `  tokens_file  ${config.server.tokens_file}`,
    `  callers      ${[...new Set(tokens.values())].toSorted().join(', ') || 'none: every request but /healthz is refused'}`,
    '',
  ].join('\n');

// The reaper runs with the most frequent probe (spec §6), and at least every ten
// seconds.
const reap_every = (config: Config): number =>
  Math.min(
    10_000,
    ...Object.values(config.nodes).flatMap((entry) => ('probe' in entry ? [entry.probe.every_ms] : [])),
  );

const stopped = (signal: AbortSignal | undefined): Promise<void> =>
  new Promise((done) => {
    if (signal?.aborted === true) done();
    signal?.addEventListener('abort', () => done(), { once: true });
  });

// Everything `serve` checks before it opens a file or a socket: the config, the
// overrides, the C5 bind and the tokens file. A string is the refusal to print.
const resolve_serve = async (flags: ServeFlags, ctx: CliContext): Promise<Resolved | string> => {
  const file = config_path(undefined, flags.config, ctx.env);
  if (file === undefined) return NO_CONFIG;
  const loaded = await read_config(file);
  if (!loaded.ok) return format_issues(file, loaded.issues);
  const config = with_overrides(loaded.config, flags);
  const listen = parse_listen(config.server.listen);
  if (listen === undefined) return `penfield: listen "${config.server.listen}" is not host:port\n`;
  const refusal = check_bind(listen.host, flags['allow-any-interface'] === true);
  if (refusal !== undefined) return `penfield: ${refusal}\n`;
  const tokens = await read_tokens(config.server.tokens_file, config.callers);
  if (!tokens.ok) return tokens.issues.map((issue) => `${issue}\n`).join('');
  return { file, config, listen, tokens: tokens.tokens };
};

const run_serve = async (args: string[], ctx: CliContext): Promise<number> => {
  const { values } = parseArgs({ args, options: SERVE_OPTIONS });
  const resolved = await resolve_serve(values, ctx);
  if (typeof resolved === 'string') {
    ctx.err.write(resolved);
    return 1;
  }
  const { config, listen, tokens } = resolved;
  const db = open_db(config.server.state_dir);
  const incident = (each: Incident): void => void log_incident(db, each);
  const catalogue = create_catalogue(config);
  const prober = create_prober({
    config,
    env: ctx.env,
    catalogue,
    clock: system_clock,
    incident,
    on_error: (error) => void ctx.err.write(`penfield: probe: ${error instanceof Error ? error.message : String(error)}\n`),
  });
  const leases = create_leases({ db, clock: system_clock });
  const reaping = { leases, clock: system_clock, instance_id: db.instance_id, incident };
  // The last boot's leases died with it (spec §6).
  sweep_orphans(reaping);
  const reaper = create_reaper({ ...reaping, every_ms: reap_every(config) });
  const app = create_server({ config, tokens, snapshot: catalogue.snapshot, in_use: leases.in_use });
  try {
    const address = await start_server(app, listen);
    ctx.out.write(banner(resolved, address, db.instance_id));
    prober.start();
    reaper.start();
    await stopped(ctx.signal);
    return 0;
  } finally {
    reaper.stop();
    prober.stop();
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
