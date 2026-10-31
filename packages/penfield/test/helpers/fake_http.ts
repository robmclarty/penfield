import { createServer } from 'node:http';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { text } from 'node:stream/consumers';

// The recording HTTP server under both fakes. It listens on 127.0.0.1 at port 0 and
// keeps every request it receives, body included, so a test can assert on what the
// gateway sent upstream.

export type RecordedRequest = { method: string; url: string; headers: IncomingHttpHeaders; body: string };

// Answers one request. A handler that never ends the response is a hung node.
type Handler = (request: RecordedRequest, response: ServerResponse) => void;

export type FakeServer = {
  // `http://127.0.0.1:<port>`, no trailing slash.
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
};

export const send_json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

export const start_fake = async (handle: Handler): Promise<FakeServer> => {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    void text(request).then((body) => {
      const recorded = { method: request.method ?? 'GET', url: request.url ?? '/', headers: request.headers, body };
      requests.push(recorded);
      handle(recorded, response);
    });
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((closed) => {
        server.close(() => closed());
        server.closeAllConnections();
      }),
  };
};
