import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, test } from 'vitest';

import { check_config, format_issues, load_config, parse_listen, read_config } from '../index.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../test/fixtures/config/${name}.yaml`, import.meta.url));

const example = fileURLToPath(new URL('../../../../../deploy/penfield.example.yaml', import.meta.url));

// The smallest file that loads: one node, everything else defaulted.
const MINIMAL = `version: 1
nodes:
  box: { kind: ollama, url: http://127.0.0.1:11434, privacy: local }
`;

const CLAUDE = '  claude: { kind: claude_decision, models: [sonnet, opus], efforts: [low, medium] }\n';

const loaded = (text: string) => {
  const result = load_config(text);
  if (!result.ok) throw new Error(format_issues('penfield.yaml', result.issues));
  return result.config;
};

const issues_of = (text: string): string[] => {
  const result = load_config(text);
  return result.ok ? [] : format_issues('penfield.yaml', result.issues).trimEnd().split('\n');
};

describe('the four fixtures', () => {
  test('a valid file loads and prints with its defaults applied', async () => {
    const result = await check_config(fixture('valid'));
    expect(result).toMatchObject({ code: 0, err: '' });
    const printed: unknown = parse(result.out);
    expect(printed).toEqual(loaded(await readFile(fixture('valid'), 'utf8')));
    expect(printed).toMatchObject({
      nodes: {
        searle: { formats: ['openai', 'anthropic'], probe: { open_after: 3 }, slots: { default: 2 } },
        openrouter: { formats: ['openai'], probe: { every_ms: 10_000, ready_prompt: false } },
        claude: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      },
    });
  });

  test('an alias to a missing profile names the line, column and path', async () => {
    const file = fixture('alias_missing_profile');
    expect(await check_config(file)).toEqual({
      code: 1,
      out: '',
      err: `${file}:9:22 aliases.digest.profile: profile "summarise" is not defined in profiles\n`,
    });
  });

  test('a pinned model its discover: false node does not list names the line, column and path', async () => {
    const file = fixture('pinned_unlisted');
    expect((await check_config(file)).err).toBe(
      `${file}:10:14 nodes.closet.pinned[0]: pinned model "qwen3.8:27b-mlx" is not in the node's models, and the node does not discover\n`,
    );
  });

  test('an unknown key names its own line and column', async () => {
    const file = fixture('unknown_key');
    expect(await check_config(file)).toMatchObject({
      code: 1,
      err: `${file}:8:5 nodes.searle.max_slots: unknown key "max_slots"\n`,
    });
  });
});

describe('the house example', () => {
  test('deploy/penfield.example.yaml loads', async () => {
    const result = await read_config(example);
    expect(result.ok ? result.config.nodes['searle'] : result.issues).toMatchObject({
      kind: 'ollama',
      url: 'http://192.168.1.90:11434',
      pinned: ['qwen3.8:27b-mlx'],
    });
  });
});

describe('defaults', () => {
  test('a minimal file gains every default', () => {
    expect(loaded(MINIMAL)).toEqual({
      version: 1,
      server: {
        listen: '127.0.0.1:7777',
        name: 'penfield',
        state_dir: '/var/lib/penfield',
        tokens_file: '/etc/penfield/tokens',
      },
      nodes: {
        box: {
          kind: 'ollama',
          url: 'http://127.0.0.1:11434',
          privacy: 'local',
          formats: ['openai', 'anthropic'],
          discover: true,
          models: [],
          pinned: [],
          slots: { default: 1 },
          probe: { every_ms: 10_000, timeout_ms: 3_000, ready_prompt: false, open_after: 3, half_open_ms: 30_000 },
          recover: { unload_on_hang: false, command: null },
        },
      },
      models: {},
      profiles: {},
      aliases: { auto: { ladder: 'default' } },
      policy: {
        precedence: ['privacy', 'quality', 'speed', 'cost'],
        confidence_threshold: 0.7,
        cold_load: 'avoid',
        busy: { default: 'degrade', wait_ms: 5_000 },
        on_claude_for_proxy: 'hint',
        stall_ms: { default: 30_000, first_token_cold: 90_000 },
        deadline_ms: { default: 600_000 },
      },
      router: { rules: [] },
      callers: {},
    });
  });

  test('a partial section keeps its own values and defaults the rest', () => {
    const config = loaded(`${MINIMAL}policy: { busy: { wait_ms: 100 } }
callers:
  rob: { keep_prompts: true }
`);
    expect(config.policy.busy).toEqual({ default: 'degrade', wait_ms: 100 });
    expect(config.callers['rob']).toEqual({ max_privacy: 'lan', priority: 'interactive', keep_prompts: true });
  });

  test('the cloud kinds are cloud whether or not the file says so', () => {
    const config = loaded(`${MINIMAL}${CLAUDE}  anthropic: { kind: anthropic_api, api_key_env: ANTHROPIC_API_KEY }\n`);
    expect(config.nodes['claude']).toMatchObject({ privacy: 'cloud' });
    expect(config.nodes['anthropic']).toMatchObject({ privacy: 'cloud', enabled: false, formats: ['anthropic'] });
    expect(issues_of(`${MINIMAL}  claude: { kind: claude_decision, privacy: lan, models: [opus] }\n`)).toEqual([
      'penfield.yaml:4:45 nodes.claude.privacy: Invalid input: expected "cloud"',
    ]);
  });
});

describe('shape failures', () => {
  test.each([
    ['an empty file', '', 'penfield.yaml:1:1 Invalid input: expected object, received null'],
    ['a wrong version', MINIMAL.replace('version: 1', 'version: 2'), 'penfield.yaml:1:10 version: Invalid input: expected 1'],
    ['no nodes', 'version: 1\nnodes: {}\n', 'penfield.yaml:2:1 nodes: at least one node'],
    [
      'a missing key, at its parent',
      'version: 1\nnodes:\n  box:\n    kind: ollama\n    privacy: lan\n',
      'penfield.yaml:3:3 nodes.box.url: missing key "url"',
    ],
    [
      'an unknown node kind',
      'version: 1\nnodes:\n  box: { kind: vllm, url: http://x:1 }\n',
      "penfield.yaml:3:16 nodes.box.kind: Invalid discriminator value. Expected 'ollama' | 'openai_compatible' | 'anthropic_api' | 'claude_decision'",
    ],
    [
      'a node with no privacy',
      'version: 1\nnodes:\n  box: { kind: ollama, url: http://x:1 }\n',
      'penfield.yaml:3:3 nodes.box.privacy: missing key "privacy"',
    ],
    [
      'a name with capitals',
      'version: 1\nnodes:\n  Searle: { kind: ollama, url: http://x:1, privacy: lan }\n',
      'penfield.yaml:3:3 nodes.Searle: invalid key "Searle": a name is lowercase letters, digits, ".", "_" or "-", starting with a letter or digit',
    ],
    [
      'a listen address without a port',
      `${MINIMAL}server: { listen: plato }\n`,
      'penfield.yaml:4:19 server.listen: listen is host:port, an IPv6 host in brackets',
    ],
    [
      'an alias with both a ladder and a profile',
      `${MINIMAL}profiles: { chat: { candidates: [m] } }\naliases: { x: { ladder: default, profile: chat } }\n`,
      'penfield.yaml:5:12 aliases.x: an alias takes one of `ladder: default` or `profile: <name>`',
    ],
    [
      'a precedence that drops a factor',
      `${MINIMAL}policy: { precedence: [privacy, speed, cost] }\n`,
      'penfield.yaml:4:11 policy.precedence: precedence lists privacy, quality, speed and cost, each once',
    ],
  ])('%s', (_, text, issue) => {
    expect(issues_of(text)).toEqual([issue]);
  });

  test.each([
    ['an OpenAI-compatible node', 'cloud: { kind: openai_compatible, url: https://x.test/v1, privacy: cloud, api_key_env: CLAUDE_API_KEY }'],
    ['an anthropic_api node', 'anthropic: { kind: anthropic_api, api_key_env: CLAUDE_SESSION }'],
  ])('%s whose api_key_env starts with CLAUDE_ fails at its value (D42)', (_, entry) => {
    const node = entry.slice(0, entry.indexOf(':'));
    // The line is indented two spaces, and columns count from 1.
    const col = entry.indexOf('CLAUDE_') + 3;
    expect(issues_of(`${MINIMAL}  ${entry}\n`)).toEqual([
      `penfield.yaml:4:${col} nodes.${node}.api_key_env: a CLAUDE_ variable may hold a Claude subscription credential, which penfield never reads (C2)`,
    ]);
  });

  test('an api_key_env with CLAUDE in the middle of its name loads', () => {
    const entry = '  cloud: { kind: openai_compatible, url: https://x.test/v1, privacy: cloud, api_key_env: MY_CLAUDE_PROXY_KEY }\n';
    expect(issues_of(`${MINIMAL}${entry}`)).toEqual([]);
  });

  test('every issue is reported, in line order', () => {
    expect(issues_of('version: 1\nnodes:\n  box: { kind: ollama, url: http://x:1, privacy: lan, slot: 2 }\nextra: 1\n')).toEqual([
      'penfield.yaml:3:55 nodes.box.slot: unknown key "slot"',
      'penfield.yaml:4:1 extra: unknown key "extra"',
    ]);
  });

  test('a YAML error and a duplicate key name their position', () => {
    expect(issues_of('version: 1\nversion: 1\n')).toEqual([
      'penfield.yaml:2:1 yaml: Map keys must be unique',
    ]);
    expect(issues_of('version: 1\nnodes: [a\n')[0]).toMatch(/^penfield\.yaml:3:1 yaml: /);
  });
});

const profiles = (candidates: string): string[] =>
  issues_of(`${MINIMAL}${CLAUDE}profiles:\n  chat: { candidates: [${candidates}] }\n`);

describe('static checks across sections (D41)', () => {
  test.each([
    ['a discovering node may have any bare model', 'qwen3.6:35b-mlx'],
    ['a hand-listed model on its node', 'claude/sonnet@low'],
    ['a model id with a slash keeps its node prefix', 'box/library/qwen3'],
  ])('%s', (_, candidate) => {
    expect(profiles(candidate)).toEqual([]);
  });

  test.each([
    ['a node that does not exist', 'nowhere/qwen3', 'names node "nowhere", which is not in nodes'],
    ['a model the hand-listed node lacks', 'claude/haiku', 'node "claude" does not list model "haiku"'],
    ['an effort that does not exist', 'claude/opus@extreme', 'effort "extreme" is not one of low, medium, high, xhigh, max'],
    ['an effort the node does not offer', 'claude/opus@max', 'node "claude" does not offer effort "max"'],
    ['a bare model with an unknown effort', 'qwen3@turbo', 'effort "turbo" is not one of low, medium, high, xhigh, max'],
    ['a node with no model', 'box/', 'names no model after the node'],
  ])('%s', (_, candidate, message) => {
    expect(profiles(candidate)).toEqual([`penfield.yaml:6:24 profiles.chat.candidates[0]: ${message}`]);
  });

  test('a bare model no node could ever have', () => {
    const only_hand_listed = `version: 1
nodes:
  closet: { kind: openai_compatible, url: http://x:1, privacy: lan, discover: false, models: [gemma4:26b] }
profiles:
  chat: { candidates: [gemma4:26b, qwen3.8:27b] }
`;
    expect(issues_of(only_hand_listed)).toEqual([
      'penfield.yaml:5:36 profiles.chat.candidates[1]: no node lists "qwen3.8:27b", and none discovers its models',
    ]);
  });

  test('a per-profile policy key must name a profile', () => {
    const text = `${MINIMAL}profiles: { chat: { candidates: [m] } }
policy:
  stall_ms: { chat: 1000, chta: 2000 }
  busy: { chat: wait }
`;
    expect(issues_of(text)).toEqual(['penfield.yaml:6:27 policy.stall_ms.chta: unknown key "chta": not a profile']);
  });

  test('a pinned model on a discovering node is left to discovery', () => {
    const text = 'version: 1\nnodes:\n  box: { kind: ollama, url: http://x:1, privacy: lan, pinned: [anything] }\n';
    expect(issues_of(text)).toEqual([]);
  });
});

describe('reading and printing', () => {
  test('an unreadable file is one issue with no position', async () => {
    const result = await check_config('/nonexistent/penfield.yaml');
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^\/nonexistent\/penfield\.yaml cannot read the config: ENOENT/);
  });

  test('a key that is not an identifier is quoted in the path', () => {
    expect(issues_of(`${MINIMAL}aliases: { "auto/fast": { ladder: fast } }\n`)).toEqual([
      'penfield.yaml:4:35 aliases["auto/fast"].ladder: Invalid input: expected "default"',
    ]);
  });
});

describe('parse_listen', () => {
  test.each([
    ['192.168.1.89:7777', { host: '192.168.1.89', port: 7777 }],
    ['localhost:0', { host: 'localhost', port: 0 }],
    ['[::1]:7777', { host: '::1', port: 7777 }],
    ['0.0.0.0:7777', { host: '0.0.0.0', port: 7777 }],
    ['plato', undefined],
    [':7777', undefined],
    ['plato:99999', undefined],
    ['::1:7777', undefined],
  ])('%s', (listen, expected) => {
    expect(parse_listen(listen)).toEqual(expected);
  });
});
