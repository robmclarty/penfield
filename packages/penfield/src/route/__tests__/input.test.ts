import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import { parse_openai_input } from '../index.js';
import type { InputContext, RouteCaller, RouteInput } from '../index.js';

// Plan step 8: spec §5.2's RouteInput from OpenAI bodies the wire has already
// parsed, with the headers beside them.

const ROB: RouteCaller = { name: 'rob', max_privacy: 'cloud', priority: 'interactive', keep_prompts: true };

const CHAT: InputContext = { request_id: 'req_1', caller: ROB, endpoint: 'chat' };

const body = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../test/fixtures/bodies/${name}.json`, import.meta.url), 'utf8'));

const parsed = (value: unknown, headers: Record<string, string> = {}, context: InputContext = CHAT): RouteInput => {
  const result = parse_openai_input(value, headers, context);
  if (!result.ok) throw new Error(result.reason);
  return result.input;
};

const reason = (value: unknown, headers: Record<string, string> = {}, context: InputContext = CHAT): string => {
  const result = parse_openai_input(value, headers, context);
  if (result.ok) throw new Error('parsed when it should have been refused');
  return result.reason;
};

const user = (...content: unknown[]) => ({ model: 'auto', messages: [{ role: 'user', content }] });

const file = (filename: string) => ({ type: 'file', file: { filename, file_data: 'data:;base64,AA==' } });

const with_metadata = (penfield: unknown) => ({ model: 'auto', metadata: { penfield }, messages: [] });

describe('a chat body', () => {
  test('with tools, a pasted file and a tool call reads as the agent sent it', () => {
    expect(parsed(body('chat_tools'))).toEqual({
      request_id: 'req_1',
      caller: ROB,
      format: 'openai',
      endpoint: 'chat',
      model: 'auto',
      text: 'Fix it so a bad string returns undefined.',
      system_text: "You are a coding agent working in the user's repository.",
      // The first user message, the tool call and its result come before the last one.
      history_turns: 3,
      // Every message's text and the tool call's arguments: 263 chars.
      tokens_estimate: 66,
      tools: true,
      attachments: 'code',
      hints: {},
    });
  });

  test('with an image is images, and the text is its text parts', () => {
    expect(parsed(body('chat_images'))).toMatchObject({
      text: 'What is on this whiteboard?',
      attachments: 'images',
      tools: false,
      history_turns: 0,
      tokens_estimate: 7,
    });
  });

  test('a long history counts the turns before the last user message', () => {
    expect(parsed(body('chat_long_history'))).toMatchObject({
      model: 'chat',
      text: 'And the last one?',
      system_text: '',
      history_turns: 12,
      tokens_estimate: 35,
      attachments: 'none',
    });
  });

  test('the system and developer prompts are the system text, and no turns', () => {
    expect(parsed(body('chat_system'))).toMatchObject({
      text: 'I was charged twice this month.',
      system_text: 'Classify the support ticket into one of: billing, bug, feature.\nAnswer with the label alone.',
      history_turns: 0,
      tokens_estimate: 31,
    });
  });

  test('images outrank code, and code outranks docs; a file part is code by its name', () => {
    const image = { type: 'image_url', image_url: { url: 'https://example.com/a.png' } };
    const fenced = { type: 'text', text: '```\nls\n```' };
    expect(parsed(user(file('notes.pdf'))).attachments).toBe('docs');
    expect(parsed(user(file('lease.ts'))).attachments).toBe('code');
    expect(parsed(user(file('notes.pdf'), fenced)).attachments).toBe('code');
    expect(parsed(user(fenced, image, file('notes.pdf'))).attachments).toBe('images');
  });

  test("an assistant's code is not an attachment, and the deprecated functions array is tools", () => {
    const value = {
      model: 'auto',
      messages: [
        { role: 'user', content: 'Show me a loop.' },
        { role: 'assistant', content: '```js\nfor (;;) {}\n```' },
        { role: 'user', content: 'Thanks.' },
      ],
      functions: [{ name: 'noop', parameters: {} }],
    };
    expect(parsed(value)).toMatchObject({ attachments: 'none', tools: true, history_turns: 2 });
  });
});

describe('hints', () => {
  test('come from metadata.penfield, and an x-penfield-* header wins over it', () => {
    expect(parsed(body('chat_hints')).hints).toEqual({ profile: 'code-heavy', effort: 'high' });
    const headers = { 'x-penfield-profile': 'summarize', 'x-penfield-prefer': 'speed', 'x-penfield-max-privacy': 'lan' };
    expect(parsed(body('chat_hints'), headers).hints).toEqual({
      profile: 'summarize',
      prefer: 'speed',
      max_privacy: 'lan',
      effort: 'high',
    });
  });

  test('an empty header is no hint', () => {
    expect(parsed(body('chat_images'), { 'x-penfield-profile': '  ' }).hints).toEqual({});
  });

  test('one that cannot be read is refused, never dropped (C11)', () => {
    expect(reason(body('chat_images'), { 'x-penfield-max-privacy': 'public' })).toBe(
      'x-penfield-max-privacy "public" is not one of local, lan, cloud',
    );
    expect(reason(with_metadata({ effort: 'huge' }))).toBe(
      'metadata.penfield.effort "huge" is not one of low, medium, high, xhigh, max',
    );
    expect(reason(with_metadata({ prefer: 3 }))).toBe('metadata.penfield.prefer 3 is not one of speed, quality');
    expect(reason(with_metadata({ profile: '' }))).toBe('metadata.penfield.profile is not a profile name');
    expect(reason(with_metadata('code-heavy'))).toBe('metadata.penfield is not an object');
  });
});

describe('an embeddings body', () => {
  const EMBED: InputContext = { ...CHAT, endpoint: 'embeddings' };

  test('reads its inputs as the text, with no turns, tools or attachments', () => {
    expect(parsed(body('embeddings'), {}, EMBED)).toEqual({
      request_id: 'req_1',
      caller: ROB,
      format: 'openai',
      endpoint: 'embeddings',
      model: 'auto',
      text: 'The quick brown fox.\nJumps over the lazy dog.',
      system_text: '',
      history_turns: 0,
      tokens_estimate: 11,
      tools: false,
      attachments: 'none',
      hints: {},
    });
  });

  test('a string input, and token ids counted as tokens', () => {
    expect(parsed({ model: 'auto', input: 'one line' }, {}, EMBED)).toMatchObject({ text: 'one line', tokens_estimate: 2 });
    expect(parsed({ model: 'auto', input: [1, 2, 3] }, {}, EMBED)).toMatchObject({ text: '', tokens_estimate: 3 });
    expect(parsed({ model: 'auto', input: [[1, 2], [3]] }, {}, EMBED).tokens_estimate).toBe(3);
  });

  test('no input is refused', () => {
    expect(reason({ model: 'auto' }, {}, EMBED)).toBe('input is not a string or an array');
  });
});

describe('a 2 MB body', () => {
  const MB = 1024 * 1024;
  const huge = {
    model: 'auto',
    messages: [
      { role: 'system', content: 's'.repeat(MB / 2) },
      { role: 'user', content: 'a'.repeat(MB) },
      { role: 'assistant', content: 'b'.repeat(MB / 4) },
      { role: 'user', content: [{ type: 'text', text: 'c'.repeat(MB / 8) }, { type: 'text', text: 'd'.repeat(MB / 8) }] },
    ],
  };

  test('caps text at 4 k chars and system text at 1 k, and estimates over every char', () => {
    const input = parsed(huge);
    expect(input.text).toHaveLength(4096);
    expect(input.text).toBe('c'.repeat(4096));
    expect(input.system_text).toBe('s'.repeat(1024));
    expect(input.tokens_estimate).toBe((2 * MB) / 4);
  });

  test('caps the joined text parts too, the newline between them counted', () => {
    const parts = { model: 'auto', messages: [{ role: 'user', content: [{ type: 'text', text: 'e'.repeat(4000) }, { type: 'text', text: 'f'.repeat(4000) }] }] };
    const { text } = parsed(parts);
    expect(text).toHaveLength(4096);
    expect(text).toBe(`${'e'.repeat(4000)}\n${'f'.repeat(95)}`);
  });
});

describe('a body the router cannot read', () => {
  test.each([
    [null, 'the body is not a JSON object'],
    [[], 'the body is not a JSON object'],
    [{ messages: [] }, 'the body names no model'],
    [{ model: '', messages: [] }, 'the body names no model'],
    [{ model: 'auto' }, 'messages is not an array'],
    [{ model: 'auto', messages: [{ role: 'user', content: 'hi' }, { content: 'no role' }] }, 'messages[1] has no role'],
    [{ model: 'auto', messages: ['hi'] }, 'messages[0] has no role'],
  ])('%j is refused: %s', (value, why) => {
    expect(reason(value)).toBe(why);
  });

  test('a chat with no user message has no text, and every message is history', () => {
    expect(parsed({ model: 'auto', messages: [{ role: 'assistant', content: 'Hello.' }] })).toMatchObject({
      text: '',
      history_turns: 1,
    });
  });
});
