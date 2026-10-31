import type { BreakerState, Catalogue } from '../catalogue/index.js';

// GET /healthz: 200 while the server is up, with each node's state as the prober
// last saw it; unauthenticated, for Uptime Kuma (D25, C5). A node is `unknown`
// until its first probe.

type NodeHealth = { name: string; kind: string; state: string; breaker: BreakerState };

type Healthz = { status: 'ok'; nodes: NodeHealth[] };

export const healthz_body = (nodes: readonly NodeHealth[]): Healthz => ({ status: 'ok', nodes: [...nodes] });

export const node_health = (catalogue: Catalogue): NodeHealth[] =>
  catalogue.nodes.map(({ name, kind, state, breaker }) => ({ name, kind, state, breaker }));
