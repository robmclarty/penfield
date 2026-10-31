import { fastify } from 'fastify';
import type { FastifyInstance } from 'fastify';

import type { Listen } from '../config/index.js';
import { healthz_body } from './healthz.js';
import type { NodeHealth } from './healthz.js';

// The HTTP server. It binds what `serve` resolved and holds the routes; each route
// gets what it reads as an argument, never from a module-level singleton (C6).

const ANY_INTERFACE = new Set(['0.0.0.0', '::', '0:0:0:0:0:0:0:0']);

// C5: the LAN interface or loopback; every interface only when asked for by name.
export const check_bind = (host: string, allow_any_interface: boolean): string | undefined =>
  ANY_INTERFACE.has(host) && !allow_any_interface
    ? `refusing to listen on ${host}, every interface (C5): name the LAN address, or pass --allow-any-interface`
    : undefined;

export type ServerDeps = { node_states: () => readonly NodeHealth[] };

export const create_server = (deps: ServerDeps): FastifyInstance => {
  const app = fastify({ logger: false });
  app.get('/healthz', (_request, reply) => reply.send(healthz_body(deps.node_states())));
  return app;
};

// Resolves to the bound address, so a port of 0 reads back as the real one.
export const start_server = (app: FastifyInstance, listen: Listen): Promise<string> =>
  app.listen({ host: listen.host, port: listen.port });
