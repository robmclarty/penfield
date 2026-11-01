import { readFile } from 'node:fs/promises';

import type { CallerConfig, Config } from '../config/index.js';

// Callers (D21, C5): the tokens file maps each bearer token to a caller in
// penfield.yaml's `callers:`, one `caller: token` line each. It lives outside the
// repo and never in penfield.yaml. No token, or one the file does not hold, is no
// caller. A token's value is never printed, not even in an error.

export type Caller = CallerConfig & { name: string };

// Token → caller name.
export type Tokens = ReadonlyMap<string, string>;

export type TokensResult = { ok: true; tokens: Tokens } | { ok: false; issues: string[] };

type Line = { number: number; name: string; token: string } | { number: number; error: string };

const lines_of = (text: string): Line[] =>
  text.split('\n').flatMap((raw, index): Line[] => {
    const line = raw.trim();
    const number = index + 1;
    if (line === '' || line.startsWith('#')) return [];
    const colon = line.indexOf(':');
    const name = colon === -1 ? '' : line.slice(0, colon).trim();
    const token = colon === -1 ? '' : line.slice(colon + 1).trim();
    if (name === '' || token === '' || /\s/.test(token)) {
      return [{ number, error: 'is not `caller: token`' }];
    }
    return [{ number, name, token }];
  });

export const parse_tokens = (file: string, text: string, callers: Config['callers']): TokensResult => {
  const tokens = new Map<string, string>();
  const first_line = new Map<string, number>();
  const issues: string[] = [];
  for (const line of lines_of(text)) {
    if ('error' in line) {
      issues.push(`${file}:${line.number} ${line.error}`);
    } else if (!(line.name in callers)) {
      issues.push(`${file}:${line.number} caller "${line.name}" is not in penfield.yaml's callers`);
    } else if (tokens.has(line.token)) {
      issues.push(`${file}:${line.number} repeats the token on line ${first_line.get(line.token) ?? 0}`);
    } else {
      tokens.set(line.token, line.name);
      first_line.set(line.token, line.number);
    }
  }
  return issues.length === 0 ? { ok: true, tokens } : { ok: false, issues };
};

export const read_tokens = async (file: string, callers: Config['callers']): Promise<TokensResult> => {
  try {
    return parse_tokens(file, await readFile(file, 'utf8'), callers);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, issues: [`${file} cannot read the tokens file: ${reason}`] };
  }
};

// The caller an `Authorization: Bearer <token>` header names, or undefined.
export const authenticate = (
  tokens: Tokens,
  callers: Config['callers'],
  authorization: string | undefined,
): Caller | undefined => {
  const match = /^bearer\s+(\S+)\s*$/i.exec(authorization ?? '');
  const name = match?.[1] === undefined ? undefined : tokens.get(match[1]);
  const policy = name === undefined ? undefined : callers[name];
  return name === undefined || policy === undefined ? undefined : { ...policy, name };
};
