import { fastify } from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { Catalogue } from '../catalogue/index.js';
import type { Config, Listen } from '../config/index.js';
import { catalogue_body } from '../ui/index.js';
import type { InUse } from '../ui/index.js';
import { authenticate } from './auth.js';
import type { Caller, Tokens } from './auth.js';
import { install_error_handlers, send_error } from './errors.js';
import { healthz_body, node_health } from './healthz.js';
import { models_list } from './openai.js';
import { mint_request_id, stamp_request_id } from './request_id.js';

// The HTTP server. It binds what `serve` resolved and holds the routes; each route
// gets what it reads as an argument, never from a module-level singleton (C6).

const ANY_INTERFACE = new Set(['0.0.0.0', '::', '0:0:0:0:0:0:0:0']);

// C5: the LAN interface or loopback; every interface only when asked for by name.
export const check_bind = (host: string, allow_any_interface: boolean): string | undefined =>
  ANY_INTERFACE.has(host) && !allow_any_interface
    ? `refusing to listen on ${host}, every interface (C5): name the LAN address, or pass --allow-any-interface`
    : undefined;

// The routes a request without a caller token may reach (C5); every other path,
// an unknown one included, needs a caller first.
const PUBLIC = new Set(['/healthz']);

export type ServerDeps = {
  config: Config;
  tokens: Tokens;
  snapshot: () => Catalogue;
  in_use: () => InUse;
};

export const create_server = (deps: ServerDeps): FastifyInstance => {
  const app = fastify({ logger: false, genReqId: mint_request_id });
  const callers = new WeakMap<FastifyRequest, Caller>();
  install_error_handlers(app);

  app.addHook('onRequest', stamp_request_id);
  app.addHook('onRequest', async (request, reply) => {
    if (PUBLIC.has(request.routeOptions.url ?? '')) return;
    const header = request.headers.authorization;
    const caller = authenticate(deps.tokens, deps.config.callers, header);
    if (caller !== undefined) {
      callers.set(request, caller);
      return;
    }
    const message =
      header === undefined
        ? 'penfield needs a caller token: send Authorization: Bearer <token>'
        : 'penfield does not know that token';
    await send_error(reply, 'unauthorized', message);
  });

  // Every route but the public ones runs after the hook has found its caller.
  const caller_of = (request: FastifyRequest): Caller => {
    const caller = callers.get(request);
    if (caller === undefined) throw new Error(`no caller for ${request.url}`);
    return caller;
  };

  app.get('/healthz', (_request, reply) => reply.send(healthz_body(node_health(deps.snapshot()))));
  app.get('/v1/models', (request, reply) =>
    reply.send(models_list(deps.snapshot(), deps.config, caller_of(request))),
  );
  app.get('/catalogue', (_request, reply) => reply.send(catalogue_body(deps.snapshot(), deps.in_use())));
  return app;
};

// Resolves to the bound address, so a port of 0 reads back as the real one.
export const start_server = (app: FastifyInstance, listen: Listen): Promise<string> =>
  app.listen({ host: listen.host, port: listen.port });
