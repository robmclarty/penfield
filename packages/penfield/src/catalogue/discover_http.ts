import type { z } from 'zod';

import type { DiscoverTarget, Discovery } from './types.js';

// What both discoverers share: one GET with the probe's timeout, its body checked
// by a zod schema, and the `down` result every failure becomes. Nothing here
// throws, so a dead node is data rather than an exception.

type Got<T> = { ok: true; body: T } | { ok: false; reason: string };

const describe_error = (error: unknown, timeout_ms: number): string => {
  if (!(error instanceof Error)) return String(error);
  if (error.name === 'TimeoutError') return `no answer in ${timeout_ms} ms`;
  // fetch wraps the socket error (`connect ECONNREFUSED 127.0.0.1:11434`) in `cause`.
  return error.cause instanceof Error ? error.cause.message : error.message;
};

export const get_json = async <T>(target: DiscoverTarget, path: string, schema: z.ZodType<T>): Promise<Got<T>> => {
  const url = `${target.url.replace(/\/+$/, '')}${path}`;
  const headers: Record<string, string> =
    target.api_key === undefined ? {} : { authorization: `Bearer ${target.api_key}` };
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(target.timeout_ms) });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, reason: `GET ${url}: HTTP ${response.status}` };
    }
    const parsed = schema.safeParse(await response.json());
    if (parsed.success) return { ok: true, body: parsed.data };
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `GET ${url}: unexpected body at ${issue?.path.join('.') ?? ''}: ${issue?.message ?? ''}` };
  } catch (error) {
    return { ok: false, reason: `GET ${url}: ${describe_error(error, target.timeout_ms)}` };
  }
};

export const down = (node: string, reason: string): Discovery => ({ node, state: 'down', models: [], reason });
