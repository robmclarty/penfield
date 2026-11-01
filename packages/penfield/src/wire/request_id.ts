import { randomUUID } from 'node:crypto';

import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';

// C10: every request has an id, minted here as the server takes it and sent back
// as `x-penfield-request` on every response, a 401, a 404 and an error included,
// so a complaint is one lookup. A client's own header is never taken for it.

export const REQUEST_HEADER = 'x-penfield-request';

export const mint_request_id = (): string => randomUUID();

// The first `onRequest` hook, so it runs before the caller check can refuse.
export const stamp_request_id = (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void => {
  void reply.header(REQUEST_HEADER, request.id);
  done();
};
