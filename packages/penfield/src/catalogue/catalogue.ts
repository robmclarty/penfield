import type { Config, NodeConfig } from '../config/index.js';
import { down } from './discover_http.js';
import { discover_ollama } from './discover_ollama.js';
import { discover_openai } from './discover_openai.js';
import { merge_catalogue } from './merge.js';
import type { Breakers, Catalogue, Seen } from './merge.js';
import type { Discovery } from './types.js';

// The catalogue: the only module that reads a node's models (spec §7). The prober
// reads each node with `discover_node` on its tick and records what it saw, with
// the breaker states; everything else reads `snapshot()`, plain data merged from
// those records.

export type Env = Readonly<Record<string, string | undefined>>;

// A node the gateway forwards to, so one it can read.
type Served = Extract<NodeConfig, { kind: 'ollama' | 'openai_compatible' }>;

const discovers = (entry: NodeConfig): entry is Served =>
  (entry.kind === 'ollama' || entry.kind === 'openai_compatible') && entry.discover;

// Reads one node's models, whether or not it discovers: the prober also reads a
// hand-listed OpenAI-compatible node's `/models`, as its liveness.
export const discover_node = (name: string, entry: Served, env: Env): Promise<Discovery> => {
  const api_key = entry.api_key_env === undefined ? undefined : env[entry.api_key_env];
  if (entry.api_key_env !== undefined && api_key === undefined) {
    return Promise.resolve(down(name, `${entry.api_key_env} is not set`));
  }
  const target = {
    name,
    url: entry.url,
    timeout_ms: entry.probe.timeout_ms,
    ...(api_key === undefined ? {} : { api_key }),
  };
  return entry.kind === 'ollama' ? discover_ollama(target) : discover_openai(target);
};

// Reads every node that discovers, at once. A node that fails is `down` with the
// reason, so this never rejects. `env` holds each node's `api_key_env`.
export const discover_all = (config: Config, env: Env): Promise<Discovery[]> =>
  Promise.all(
    Object.entries(config.nodes).flatMap(([name, entry]) =>
      discovers(entry) ? [discover_node(name, entry, env)] : [],
    ),
  );

export type CatalogueStore = {
  snapshot: () => Catalogue;
  // `at` is when the discovery ran, from the prober's clock (D34).
  record_discovery: (discovery: Discovery, at: string) => void;
  record_breakers: (breakers: Breakers) => void;
};

export const create_catalogue = (config: Config): CatalogueStore => {
  const seen: Record<string, Seen> = {};
  let breakers: Breakers = { nodes: {}, models: {} };
  let current = merge_catalogue(config, { seen, breakers });
  const remerge = (): void => {
    current = merge_catalogue(config, { seen, breakers });
  };
  return {
    snapshot: () => current,
    record_discovery: (discovery, at) => {
      if (!(discovery.node in config.nodes)) return;
      seen[discovery.node] = { discovery, at };
      remerge();
    },
    record_breakers: (next) => {
      breakers = { nodes: { ...next.nodes }, models: { ...next.models } };
      remerge();
    },
  };
};
