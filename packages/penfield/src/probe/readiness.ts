// The calls the prober makes to an Ollama node beside discovery: liveness, the
// readiness ping, and the unload that recovery sends. None throws; each says how
// long it took, by the prober's clock.

export type Outcome = { ok: true; ms: number } | { ok: false; ms: number; reason: string };

type Request = { method: 'GET' } | { method: 'POST'; body: Record<string, unknown> };

const describe_error = (error: unknown, timeout_ms: number): string => {
  if (error instanceof Error && error.name === 'TimeoutError') return `no answer in ${timeout_ms} ms`;
  if (error instanceof Error) return error.cause instanceof Error ? error.cause.message : error.message;
  return String(error);
};

export const call = async (
  url: string,
  request: Request,
  timeout_ms: number,
  now: () => number,
): Promise<Outcome> => {
  const started = now();
  const label = `${request.method} ${url}`;
  try {
    const response = await fetch(url, {
      method: request.method,
      signal: AbortSignal.timeout(timeout_ms),
      ...(request.method === 'POST'
        ? { body: JSON.stringify(request.body), headers: { 'content-type': 'application/json' } }
        : {}),
    });
    await response.arrayBuffer();
    const ms = now() - started;
    return response.ok ? { ok: true, ms } : { ok: false, ms, reason: `${label}: HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, ms: now() - started, reason: `${label}: ${describe_error(error, timeout_ms)}` };
  }
};

export const endpoint = (url: string, path: string): string => `${url.replace(/\/+$/, '')}${path}`;

export const ping_live = (url: string, timeout_ms: number, now: () => number): Promise<Outcome> =>
  call(endpoint(url, '/api/version'), { method: 'GET' }, timeout_ms, now);

// An empty prompt loads a model that is not resident, so the prober sends this only
// to models `/api/ps` lists (Q2). `keep_alive` is left out, as spec §6 says.
export const ping_ready = (url: string, model: string, timeout_ms: number, now: () => number): Promise<Outcome> =>
  call(endpoint(url, '/api/generate'), { method: 'POST', body: { model, prompt: '', stream: false } }, timeout_ms, now);
