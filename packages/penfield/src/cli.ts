#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { check_config } from './config/index.js';

// The `penfield` bin. `run_cli` takes its arguments, environment and output streams
// as values, so tests drive it in-process; the guard at the bottom wires the process.

export type CliWriter = { write: (text: string) => unknown };

export type CliContext = {
  env: Record<string, string | undefined>;
  out: CliWriter;
  err: CliWriter;
};

const USAGE = `usage: penfield <command> [options]

commands:
  check-config [path]   validate penfield.yaml and print it with every default applied

The config path is the argument, else --config, else PENFIELD_CONFIG.
`;

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
    ctx.err.write('penfield: no config: pass a path or --config, or set PENFIELD_CONFIG\n');
    return 1;
  }
  const result = await check_config(file);
  ctx.out.write(result.out);
  ctx.err.write(result.err);
  return result.code;
};

export const run_cli = async (argv: readonly string[], ctx: CliContext): Promise<number> => {
  const [command, ...args] = argv;
  try {
    switch (command) {
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
    return 2;
  }
};

if (import.meta.main) {
  process.exitCode = await run_cli(process.argv.slice(2), {
    env: process.env,
    out: process.stdout,
    err: process.stderr,
  });
}
