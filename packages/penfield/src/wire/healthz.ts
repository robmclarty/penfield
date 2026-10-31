import type { Config } from '../config/index.js';

// GET /healthz: 200 while the server is up, with each node's state; unauthenticated,
// for Uptime Kuma (D25, C5). The states come from a supplier, so the prober plugs in
// without touching the route; until it does, every node is `unknown`.

export type NodeHealth = { name: string; kind: string; state: string };

export type Healthz = { status: 'ok'; nodes: NodeHealth[] };

export const healthz_body = (nodes: readonly NodeHealth[]): Healthz => ({ status: 'ok', nodes: [...nodes] });

export const unknown_states = (config: Config): NodeHealth[] =>
  Object.entries(config.nodes).map(([name, entry]) => ({ name, kind: entry.kind, state: 'unknown' }));
