import { describe, expect, test } from 'vitest';

import { create_catalogue } from '../../catalogue/index.js';
import { system_clock } from '../../clock.js';
import { format_issues, load_config } from '../../config/index.js';
import { DECISION_HEADER, send_error } from '../errors.js';
import { REQUEST_HEADER } from '../request_id.js';
import { create_server } from '../server.js';

const loaded = load_config(`version: 1
nodes:
  searle: { kind: ollama, url: http://searle.test:11434, privacy: lan }
callers:
  rob: { max_privacy: cloud }
`);
if (!loaded.ok) throw new Error(format_issues('penfield.yaml', loaded.issues));
const { config } = loaded;

const ROB = { authorization: 'Bearer tok_rob_5f2a9c1e' };

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

// The server as `serve` builds it, with three routes beside its own that fail on
// purpose, as later endpoints will: a decision refused for its policy, a body
// Fastify cannot read, and a bug.
const server = () => {
  const app = create_server({
    config,
    tokens: new Map([['tok_rob_5f2a9c1e', 'rob']]),
    snapshot: create_catalogue(config).snapshot,
    in_use: () => ({}),
    clock: system_clock,
    log_decision: () => undefined,
    read_decisions: () => [],
  });
  app.post('/refused', (_request, reply) => send_error(reply, 'forbidden', 'caller rob may not use "claude/opus"', 'dec-1'));
  app.post('/echo', (request, reply) => reply.send(request.body));
  app.get('/broken', () => {
    throw new Error('a bug');
  });
  return app;
};

describe('x-penfield-request (C10)', () => {
  test.each([
    ['/healthz, which needs no token', '/healthz', {}, 200],
    ['a 401', '/v1/models', {}, 401],
    ['a route with its caller', '/v1/models', ROB, 200],
    ['an unknown path', '/nowhere', ROB, 404],
    ['a route that throws', '/broken', ROB, 500],
  ])('is on every response: %s', async (_, url, headers, status) => {
    const app = server();
    const response = await app.inject({ method: 'GET', url, headers });
    expect(response.statusCode).toBe(status);
    expect(response.headers[REQUEST_HEADER]).toMatch(UUID);
    await app.close();
  });

  test('is minted for each request, never taken from the client', async () => {
    const app = server();
    const sent = { ...ROB, [REQUEST_HEADER]: 'mine' };
    const ids = await Promise.all([1, 2].map(async () => (await app.inject({ url: '/healthz', headers: sent })).headers[REQUEST_HEADER]));
    expect(ids[0]).not.toBe('mine');
    expect(ids[0]).not.toBe(ids[1]);
    await app.close();
  });
});

describe('the error envelope: OpenAI error shape, with the ids that trace it', () => {
  test("plan step 7's 401s use it, its request_id the header's", async () => {
    const app = server();
    const response = await app.inject({ url: '/v1/models' });
    expect(response.json()).toEqual({
      error: {
        message: 'penfield needs a caller token: send Authorization: Bearer <token>',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_api_key',
        request_id: response.headers[REQUEST_HEADER],
      },
    });
    const unknown = await app.inject({ url: '/v1/models', headers: { authorization: 'Bearer tok_rob_00000000' } });
    expect(unknown.json()).toMatchObject({ error: { message: 'penfield does not know that token', code: 'invalid_api_key' } });
    await app.close();
  });

  test('a decision refused for its policy is a 403 carrying the decision id, in the body and as x-penfield-decision', async () => {
    const app = server();
    const response = await app.inject({ method: 'POST', url: '/refused', headers: ROB });
    expect(response.statusCode).toBe(403);
    expect(response.headers[DECISION_HEADER]).toBe('dec-1');
    expect(response.json()).toEqual({
      error: {
        message: 'caller rob may not use "claude/opus"',
        type: 'permission_error',
        param: null,
        code: 'forbidden',
        request_id: response.headers[REQUEST_HEADER],
        decision_id: 'dec-1',
      },
    });
    await app.close();
  });

  test('an error with no decision carries no decision id', async () => {
    const app = server();
    const response = await app.inject({ url: '/nowhere', headers: ROB });
    expect(response.headers[DECISION_HEADER]).toBeUndefined();
    expect(response.json()).toEqual({
      error: {
        message: 'penfield has no route GET /nowhere',
        type: 'invalid_request_error',
        param: null,
        code: 'not_found',
        request_id: response.headers[REQUEST_HEADER],
      },
    });
    await app.close();
  });

  test("what Fastify refuses keeps its 4xx status; a bug is a 500, in the same shape", async () => {
    const app = server();
    const json = { ...ROB, 'content-type': 'application/json' };
    const broken = await app.inject({ method: 'POST', url: '/echo', headers: json, payload: '{"model":' });
    expect(broken.statusCode).toBe(400);
    expect(broken.json()).toMatchObject({ error: { type: 'invalid_request_error', code: 'invalid_request', param: null } });
    const typed = await app.inject({ method: 'POST', url: '/echo', headers: { ...ROB, 'content-type': 'text/csv' }, payload: 'a,b' });
    expect(typed.statusCode).toBe(415);
    expect(typed.json()).toMatchObject({ error: { type: 'invalid_request_error', code: 'invalid_request' } });
    const bug = await app.inject({ url: '/broken', headers: ROB });
    expect(bug.json()).toEqual({
      error: {
        message: 'penfield failed on this request: a bug',
        type: 'server_error',
        param: null,
        code: 'internal_error',
        request_id: bug.headers[REQUEST_HEADER],
      },
    });
    await app.close();
  });
});
