import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run_cli } from '../../src/cli.js';

// `penfield serve` through the bin's own entry, in-process: the arguments,
// environment and streams are values, so no build is needed and the CLI's lines
// count toward coverage.

export const EXAMPLE = fileURLToPath(new URL('../../../../deploy/penfield.example.yaml', import.meta.url));

export const TOKENS = fileURLToPath(new URL('../fixtures/tokens', import.meta.url));

// The house config with searle on `searle_url`, written into `dir`, so a test
// that boots it never reaches the real searle.
export const house_config = (dir: string, searle_url: string): string => {
  const file = join(dir, 'penfield.yaml');
  writeFileSync(file, readFileSync(EXAMPLE, 'utf8').replace('http://192.168.1.90:11434', searle_url));
  return file;
};

export type Collector = {
  text: () => string;
  write: (chunk: string) => boolean;
  until: (pattern: RegExp) => Promise<string>;
};

// A stream that keeps what was written, and resolves `until` with a pattern's first
// group once the text matches it.
export const collector = (): Collector => {
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

export type Running = { out: Collector; err: Collector; exit: Promise<number>; stop: () => Promise<number> };

export const serve = (args: string[], env: Record<string, string> = {}): Running => {
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
export const booted = (running: Running): Promise<string> => {
  const gave_up = running.exit.then((code) => {
    throw new Error(`serve exited ${code}: ${running.err.text()}`);
  });
  return Promise.race([running.out.until(LISTENING), gave_up]);
};
