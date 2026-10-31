import { describe, expect, test } from 'vitest';

import { format_issues, load_config } from '../../config/index.js';
import { authenticate, parse_tokens, read_tokens } from '../auth.js';

const loaded = load_config(`version: 1
nodes:
  searle: { kind: ollama, url: http://searle.test:11434, privacy: lan }
callers:
  rob: { max_privacy: cloud, keep_prompts: true }
  nurselog: { models: [qwen3.8:27b-mlx] }
`);
if (!loaded.ok) throw new Error(format_issues('penfield.yaml', loaded.issues));
const { callers } = loaded.config;

describe('parse_tokens', () => {
  test('reads `caller: token` lines, skipping comments and blanks, a caller with two tokens', () => {
    const text = '# house tokens\n\nrob: tok_rob_5f2a9c1e\n  nurselog:tok_nurselog_9a4b7d3c  \nrob: tok_rob_0e1d2c3b\n';
    expect(parse_tokens('tokens', text, callers)).toEqual({
      ok: true,
      tokens: new Map([
        ['tok_rob_5f2a9c1e', 'rob'],
        ['tok_nurselog_9a4b7d3c', 'nurselog'],
        ['tok_rob_0e1d2c3b', 'rob'],
      ]),
    });
  });

  test('every bad line is an issue with its line, and no token is ever printed', () => {
    const text = [
      'rob tok_rob_5f2a9c1e',
      ': tok_rob_1a2b3c4d',
      'rob:',
      'rob: two words',
      'bob: tok_bob_0d1e2f3a',
      'rob: tok_rob_5f2a9c1e',
      'nurselog: tok_rob_5f2a9c1e',
    ].join('\n');
    const result = parse_tokens('/etc/penfield/tokens', text, callers);
    expect(result).toEqual({
      ok: false,
      issues: [
        '/etc/penfield/tokens:1 is not `caller: token`',
        '/etc/penfield/tokens:2 is not `caller: token`',
        '/etc/penfield/tokens:3 is not `caller: token`',
        '/etc/penfield/tokens:4 is not `caller: token`',
        '/etc/penfield/tokens:5 caller "bob" is not in penfield.yaml\'s callers',
        '/etc/penfield/tokens:7 repeats the token on line 6',
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/tok_/);
  });

  test('an empty file is no callers, which refuses every request', () => {
    expect(parse_tokens('tokens', '', callers)).toEqual({ ok: true, tokens: new Map() });
  });

  test('a file that cannot be read is one issue', async () => {
    expect(await read_tokens('/nonexistent/tokens', callers)).toEqual({
      ok: false,
      issues: [expect.stringMatching(/^\/nonexistent\/tokens cannot read the tokens file: ENOENT/)],
    });
  });
});

describe('authenticate', () => {
  const tokens = new Map([['tok_rob_5f2a9c1e', 'rob']]);

  test.each([
    ['Bearer tok_rob_5f2a9c1e'],
    ['bearer tok_rob_5f2a9c1e'],
    ['BEARER   tok_rob_5f2a9c1e '],
  ])('%s is rob, with rob\'s policy', (header) => {
    expect(authenticate(tokens, callers, header)).toEqual({
      name: 'rob',
      max_privacy: 'cloud',
      priority: 'interactive',
      keep_prompts: true,
    });
  });

  test.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['an unknown token', 'Bearer tok_rob_00000000'],
    ['another scheme', 'Basic tok_rob_5f2a9c1e'],
    ['a bare token', 'tok_rob_5f2a9c1e'],
    ['two tokens', 'Bearer tok_rob_5f2a9c1e tok_rob_5f2a9c1e'],
  ])('%s is no caller', (_, header) => {
    expect(authenticate(tokens, callers, header)).toBeUndefined();
  });

  test('a token whose caller has left penfield.yaml is no caller', () => {
    expect(authenticate(new Map([['tok_gone_1a2b3c4d', 'gone']]), callers, 'Bearer tok_gone_1a2b3c4d')).toBeUndefined();
  });
});
