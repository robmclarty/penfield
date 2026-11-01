import { discover_node } from '../catalogue/index.js';
import type { CatalogueStore, Discovery, Env } from '../catalogue/index.js';
import type { Clock } from '../clock.js';
import type { Config, NodeConfig } from '../config/index.js';
import type { Incident } from '../log/index.js';
import { admit, CLOSED, fail, succeed } from './breaker.js';
import type { Breaker, Step } from './breaker.js';
import { ping_live, ping_ready } from './readiness.js';
import { unload_and_reload } from './recover.js';

// The prober (spec §6). On each node's own tick: liveness (`GET /api/version` for
// Ollama, `/models` for an OpenAI-compatible node), then discovery, then, when
// `ready_prompt` is on, a readiness ping to each resident model. A breaker per node
// and per model, every transition an incident, and the catalogue refreshed with
// what it saw. Nothing here places or routes; it only keeps the snapshot honest.

// The readiness ping runs once every this many probe intervals, or at once when
// the node has just failed a probe.
const READY_EVERY = 6;

export type ProberDeps = {
  config: Config;
  env: Env;
  catalogue: CatalogueStore;
  clock: Clock;
  // `log.incident`, bound to the db by the caller.
  incident: (incident: Incident) => void;
  // A probe that threw: the incident log itself failing. `start` reports it here
  // and keeps probing.
  on_error: (error: unknown) => void;
};

export type Prober = {
  // Probes every node once, at the same time.
  tick: () => Promise<void>;
  // Probes every node now, then each again on its own `probe.every_ms`.
  start: () => void;
  stop: () => void;
};

type Served = Extract<NodeConfig, { kind: 'ollama' | 'openai_compatible' }>;
type Ollama = Extract<NodeConfig, { kind: 'ollama' }>;
type Up = Extract<Discovery, { state: 'up' }>;

// What the prober keeps for a node between ticks. `showing` is true while the
// catalogue holds an `up` discovery for it.
type Watched = { name: string; entry: Served; breaker: Breaker; ready_at: number | null; showing: boolean };

export const create_prober = (deps: ProberDeps): Prober => {
  const { config, env, catalogue, clock } = deps;
  const watched: Watched[] = Object.entries(config.nodes).flatMap(([name, entry]) =>
    entry.kind === 'ollama' || entry.kind === 'openai_compatible'
      ? [{ name, entry, breaker: CLOSED, ready_at: null, showing: false }]
      : [],
  );
  const model_breakers = new Map<string, Breaker>();
  const reported = new Set<string>();

  const report = (kind: Incident['kind'], node: string | null, model: string | null, detail: string): void => {
    deps.incident({ at: new Date(clock.now()).toISOString(), node, model, kind, detail });
  };

  // Each transition is an incident; a failure below the threshold is a probe_fail.
  const transition = (node: string, model: string | null, step: Step, reason: string | null, open_after: number): void => {
    if (step.change === 'opened') {
      report('breaker_open', node, model, `${step.breaker.failures} failed in a row; last: ${reason ?? 'unknown'}`);
    } else if (step.change === 'closed') {
      report('recovered', node, model, 'the half-open probe succeeded');
    } else if (reason !== null && step.breaker.state === 'closed') {
      report('probe_fail', node, model, `${step.breaker.failures} of ${open_after}: ${reason}`);
    }
  };

  // The breakers into the catalogue, and a candidate that has gone missing since
  // the last look into the log, once until it comes back (D41).
  const publish = (): void => {
    catalogue.record_breakers({
      nodes: Object.fromEntries(watched.map(({ name, breaker }) => [name, breaker.state])),
      models: Object.fromEntries([...model_breakers].map(([ref, breaker]) => [ref, breaker.state])),
    });
    const warnings = catalogue.snapshot().warnings;
    const current = new Set(warnings.map(({ profile, candidate }) => `${profile} ${candidate}`));
    for (const key of reported) if (!current.has(key)) reported.delete(key);
    for (const { profile, candidate, message } of warnings) {
      const key = `${profile} ${candidate}`;
      if (reported.has(key)) continue;
      reported.add(key);
      report('candidate_missing', null, candidate, `profile "${profile}": ${message}`);
    }
  };

  const read = async ({ name, entry }: Watched): Promise<Discovery> => {
    if (entry.kind === 'openai_compatible') return discover_node(name, entry, env);
    const live = await ping_live(entry.url, entry.probe.timeout_ms, clock.now);
    if (!live.ok) return { node: name, state: 'down', models: [], reason: live.reason };
    return entry.discover ? discover_node(name, entry, env) : { node: name, state: 'up', models: [] };
  };

  const ready_model = async (name: string, entry: Ollama, id: string): Promise<void> => {
    const ref = `${name}/${id}`;
    const admitted = admit(model_breakers.get(ref) ?? CLOSED, clock.now(), entry.probe.half_open_ms);
    if (admitted === undefined) return;
    const ping = await ping_ready(entry.url, id, entry.probe.timeout_ms, clock.now);
    // D45: a 4xx is the runner answering (an embedding model refuses `generate`), so
    // it counts as nothing; only a hang takes `unload_on_hang`, and a 5xx or a
    // refused connection counts toward the model's breaker.
    if (!ping.ok && ping.failure === 'client') return;
    if (ping.ok || ping.failure !== 'hang' || !entry.recover.unload_on_hang) {
      const step = ping.ok ? succeed(admitted) : fail(admitted, clock.now(), entry.probe.open_after);
      model_breakers.set(ref, step.breaker);
      transition(name, id, step, ping.ok ? null : `readiness: ${ping.reason}`, entry.probe.open_after);
      return;
    }
    report('probe_fail', name, id, `readiness: ${ping.reason}; unloading it to reload`);
    const timeouts = { unload_ms: entry.probe.timeout_ms, reload_ms: config.policy.stall_ms.first_token_cold };
    const again = await unload_and_reload(entry.url, id, timeouts, clock.now);
    if (again.ok) {
      model_breakers.set(ref, CLOSED);
      report('recovered', name, id, `unloaded and reloaded in ${again.ms} ms`);
      return;
    }
    // The recovery failed: this model's breaker opens, and the node's stays as it is.
    const step = fail(admitted, clock.now(), 1);
    model_breakers.set(ref, step.breaker);
    transition(name, id, step, again.reason, 1);
  };

  // Q2: only what `/api/ps` listed as resident is pinged, so nothing is loaded.
  const readiness = async (name: string, entry: Ollama, discovery: Up): Promise<void> => {
    for (const { id, residency } of discovery.models) {
      if (residency === 'resident') await ready_model(name, entry, id);
    }
  };

  const ready_due = (node: Watched, suspect: boolean): node is Watched & { entry: Ollama } =>
    node.entry.kind === 'ollama' &&
    node.entry.probe.ready_prompt &&
    (suspect || node.ready_at === null || clock.now() - node.ready_at >= READY_EVERY * node.entry.probe.every_ms);

  const probe_node = async (node: Watched): Promise<void> => {
    const admitted = admit(node.breaker, clock.now(), node.entry.probe.half_open_ms);
    if (admitted === undefined) return;
    const discovery = await read(node);
    const at = new Date(clock.now()).toISOString();
    const { open_after } = node.entry.probe;
    if (discovery.state === 'up') {
      const step = succeed(admitted);
      node.breaker = step.breaker;
      transition(node.name, null, step, null, open_after);
      node.showing = true;
      catalogue.record_discovery(discovery, at);
      if (ready_due(node, admitted.failures > 0)) {
        node.ready_at = clock.now();
        await readiness(node.name, node.entry, discovery);
      }
    } else {
      const step = fail(admitted, clock.now(), open_after);
      node.breaker = step.breaker;
      transition(node.name, null, step, discovery.reason, open_after);
      // Below the threshold a node keeps its last models, so placement may still use
      // it; once the breaker opens, or if it was never up, it shows as down.
      if (!node.showing || node.breaker.state !== 'closed') {
        node.showing = false;
        catalogue.record_discovery(discovery, at);
      }
    }
    publish();
  };

  let running = false;
  const cancels = new Map<string, () => void>();
  const loop = (node: Watched): void => {
    void probe_node(node)
      .catch(deps.on_error)
      .then(() => {
        if (running) cancels.set(node.name, clock.after(node.entry.probe.every_ms, () => loop(node)));
      });
  };

  return {
    tick: async () => {
      await Promise.all(watched.map(probe_node));
    },
    start: () => {
      if (running) return;
      running = true;
      for (const node of watched) loop(node);
    },
    stop: () => {
      running = false;
      for (const cancel of cancels.values()) cancel();
      cancels.clear();
    },
  };
};
