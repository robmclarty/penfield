import { call, endpoint, ping_ready } from './readiness.js';
import type { Outcome } from './readiness.js';

// Spec §6, a model resident but wedged, under `recover.unload_on_hang`: unload it
// with `keep_alive: 0`, then a readiness ping that loads it again. This is the one
// place the prober loads a model, and only one it has just unloaded. One attempt;
// the prober opens the model's breaker when it fails.

export type RecoverTimeouts = { unload_ms: number; reload_ms: number };

export const unload_and_reload = async (
  url: string,
  model: string,
  timeouts: RecoverTimeouts,
  now: () => number,
): Promise<Outcome> => {
  const unloaded = await call(
    endpoint(url, '/api/generate'),
    { method: 'POST', body: { model, keep_alive: 0 } },
    timeouts.unload_ms,
    now,
  );
  if (!unloaded.ok) return { ...unloaded, reason: `unload: ${unloaded.reason}` };
  const reloaded = await ping_ready(url, model, timeouts.reload_ms, now);
  return reloaded.ok ? reloaded : { ...reloaded, reason: `reload: ${reloaded.reason}` };
};
