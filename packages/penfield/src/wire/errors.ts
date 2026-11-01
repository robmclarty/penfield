import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';

import { REQUEST_HEADER } from './request_id.js';

// The error envelope (spec §5.4): every error penfield sends is JSON in OpenAI's
// error shape, `{ error: { message, type, param, code } }`, which an OpenAI client
// already shows its user, and it carries the ids that trace it (C10): the
// request's always, the decision's when a decision was made, which also goes out
// as `x-penfield-decision`. The Anthropic shape arrives with `/v1/messages`.

export const DECISION_HEADER = 'x-penfield-decision';

type Kind = { status: number; type: string; code: string };

const KINDS = {
  bad_request: { status: 400, type: 'invalid_request_error', code: 'invalid_request' },
  unauthorized: { status: 401, type: 'invalid_request_error', code: 'invalid_api_key' },
  forbidden: { status: 403, type: 'permission_error', code: 'forbidden' },
  not_found: { status: 404, type: 'invalid_request_error', code: 'not_found' },
  internal: { status: 500, type: 'server_error', code: 'internal_error' },
} satisfies Record<string, Kind>;

type ErrorKind = keyof typeof KINDS;

type ErrorBody = {
  error: { message: string; type: string; param: null; code: string; request_id: string; decision_id?: string };
};

type Ids = { request_id: string; decision_id?: string };

const body_of = ({ type, code }: Kind, message: string, { request_id, decision_id }: Ids): ErrorBody => ({
  error: { message, type, param: null, code, request_id, ...(decision_id === undefined ? {} : { decision_id }) },
});

const send = (reply: FastifyReply, kind: Kind, message: string, decision_id?: string): FastifyReply => {
  const request_id = reply.request.id;
  void reply.header(REQUEST_HEADER, request_id);
  if (decision_id !== undefined) void reply.header(DECISION_HEADER, decision_id);
  return reply.code(kind.status).send(body_of(kind, message, { request_id, ...(decision_id === undefined ? {} : { decision_id }) }));
};

export const send_error = (reply: FastifyReply, kind: ErrorKind, message: string, decision_id?: string): FastifyReply =>
  send(reply, KINDS[kind], message, decision_id);

// An unknown path, and what Fastify itself refuses (a body that is not JSON, one
// too large), leave in the same envelope, keeping Fastify's status for a 4xx.
export const install_error_handlers = (app: FastifyInstance): void => {
  app.setNotFoundHandler((request, reply) =>
    send_error(reply, 'not_found', `penfield has no route ${request.method} ${request.url}`),
  );
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const status = error.statusCode ?? 500;
    return status < 500
      ? send(reply, { ...KINDS.bad_request, status }, error.message)
      : send_error(reply, 'internal', `penfield failed on this request: ${error.message}`);
  });
};
