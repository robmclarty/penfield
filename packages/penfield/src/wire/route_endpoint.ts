import { randomUUID } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Catalogue } from '../catalogue/index.js';
import type { Clock } from '../clock.js';
import type { Config } from '../config/index.js';
import { place } from '../place/index.js';
import type { Decision } from '../place/index.js';
import { parse_openai_input, route } from '../route/index.js';
import type { RouteInput } from '../route/index.js';
import type { InUse } from '../ui/index.js';
import type { Caller } from './auth.js';
import { DECISION_HEADER, send_error } from './errors.js';
import { check_policy } from './policy.js';

// POST /route (spec §5.4): the decision a request would get, made dry. The body is
// an OpenAI chat or embeddings body, read once (C4); it is routed, checked against
// the caller's policy, placed over a snapshot of the lease table without taking a
// lease, and logged, and the Decision is the answer. Nothing is forwarded.

export type RouteDeps = {
  config: Config;
  snapshot: () => Catalogue;
  in_use: () => InUse;
  clock: Clock;
  // `log.decision`: the row every decision gets.
  log_decision: (decision: Decision, input: RouteInput) => void;
};

// An embeddings body carries `input` and no `messages`; anything else reads as chat.
const endpoint_of = (body: unknown): 'chat' | 'embeddings' =>
  typeof body === 'object' && body !== null && !('messages' in body) && 'input' in body ? 'embeddings' : 'chat';

// A body the router cannot read is a 400 and no decision. A named model the caller
// may not use is a 403 with the reason and the decision's id (C11). Every other
// decision is the answer, a refusal included, with its id in `x-penfield-decision`.
export const post_route = async (deps: RouteDeps, caller: Caller, request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
  const parsed = parse_openai_input(request.body, request.headers, {
    request_id: request.id,
    caller,
    endpoint: endpoint_of(request.body),
  });
  if (!parsed.ok) return send_error(reply, 'bad_request', `penfield cannot route this body: ${parsed.reason}`);
  const { input } = parsed;
  const catalogue = deps.snapshot();
  const checked = check_policy(await route(input, catalogue, deps.config), caller, catalogue);
  const stamp = { id: randomUUID(), at: new Date(deps.clock.now()).toISOString() };
  const decision = place(checked.routed, input, catalogue, deps.in_use(), deps.config, stamp);
  deps.log_decision(decision, input);
  if (checked.forbidden && decision.target.kind === 'refused') {
    return send_error(reply, 'forbidden', decision.target.reason, decision.id);
  }
  return reply.header(DECISION_HEADER, decision.id).send(decision);
};
