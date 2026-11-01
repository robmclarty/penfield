import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import { create_usage_reader, is_event_stream, sse_event } from '../sse.js';

// The stream as searle sent it, with `stream_options.include_usage`: content
// chunks, the finish, the usage chunk, `[DONE]`.
const CAPTURED = readFileSync(new URL('../../../test/fixtures/ollama/chat_stream.sse', import.meta.url));

// The same bytes cut into pieces of `size`, so events and characters straddle pushes.
const pieces = (bytes: Uint8Array, size: number): Uint8Array[] =>
  Array.from({ length: Math.ceil(bytes.length / size) }, (_, index) => bytes.subarray(index * size, (index + 1) * size));

const read = (chunks: readonly Uint8Array[]): number | null => {
  const reader = create_usage_reader();
  for (const chunk of chunks) reader.push(chunk);
  return reader.end();
};

const encoded = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('the usage reader', () => {
  test("reads the node's prompt count from the captured stream, whole or cut at any byte", () => {
    expect(read([CAPTURED])).toBe(18);
    for (const size of [1, 7, 64, 333]) expect(read(pieces(CAPTURED, size))).toBe(18);
  });

  test('a stream the client sent without include_usage ends with no count', () => {
    const without = CAPTURED.toString('utf8').replace(/^data: \{[^\n]*"usage"[^\n]*\n\n/m, '');
    expect(without).not.toContain('prompt_tokens');
    expect(read([encoded(without)])).toBeNull();
  });

  test('the last count wins, and OpenAI\'s "usage": null on each chunk is no count', () => {
    const stream = [
      sse_event({ choices: [{ delta: { content: 'hi' } }], usage: null }),
      sse_event({ choices: [], usage: { prompt_tokens: 3 } }),
      sse_event({ choices: [], usage: { prompt_tokens: 41, completion_tokens: 2 } }),
      'data: [DONE]\n\n',
    ].join('');
    expect(read([encoded(stream)])).toBe(41);
  });

  test('an event still open when the stream ends is read, CRLF framing included', () => {
    expect(read([encoded('data: {"usage":{"prompt_tokens":7}}\r\n\r\ndata: {"usage":{"prompt_tokens":9}}')])).toBe(9);
  });

  test('an event too long to be a usage event is dropped, not held while it grows', () => {
    const long = `data: {"text":"${'x'.repeat(70 * 1024)}`;
    expect(read([encoded(long), encoded('","usage":{"prompt_tokens":5}}\n\n')])).toBeNull();
    expect(read([encoded(long), encoded('"}\n\n'), encoded('data: {"usage":{"prompt_tokens":5}}\n\n')])).toBe(5);
  });

  test('a data line that is not JSON, or carries a count that is no number, is passed over', () => {
    expect(read([encoded('data: {"usage":{"prompt_tokens":"many"}}\n\ndata: {not json "prompt_tokens"\n\n')])).toBeNull();
  });
});

describe('event framing', () => {
  test('an event is one data line of JSON and the blank line that ends it', () => {
    expect(sse_event({ error: { message: 'stalled' } })).toBe('data: {"error":{"message":"stalled"}}\n\n');
  });

  test('an event stream is told by its content type, parameters and case aside', () => {
    expect(is_event_stream('text/event-stream')).toBe(true);
    expect(is_event_stream('Text/Event-Stream; charset=utf-8')).toBe(true);
    expect(is_event_stream('application/json')).toBe(false);
    expect(is_event_stream(null)).toBe(false);
  });
});
