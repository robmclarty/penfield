import { describe, expect, test } from 'vitest';

import { merge_catalogue } from '../../catalogue/index.js';
import type { Discovery } from '../../catalogue/index.js';
import { format_issues, load_config } from '../../config/index.js';
import type { Config } from '../../config/index.js';
import { models_list } from '../openai.js';

const loaded = (text: string): Config => {
  const result = load_config(text);
  if (!result.ok) throw new Error(format_issues('penfield.yaml', result.issues));
  return result.config;
};

const up = (node: string, ids: string[]): Discovery => ({
  node,
  state: 'up',
  models: ids.map((id) => ({ id, node, residency: 'cold', size_bytes: null, context_length: null })),
});

const config = loaded(`version: 1
nodes:
  searle: { kind: ollama, url: http://searle.test:11434, privacy: lan }
  closet: { kind: ollama, url: http://closet.test:11434, privacy: local }
  anthropic: { kind: anthropic_api, api_key_env: ANTHROPIC_API_KEY, models: [claude-sonnet-5-5] }
aliases:
  auto/fast: { ladder: default, prefer: speed }
  auto: { ladder: default }
callers:
  rob: { max_privacy: cloud }
`);

const catalogue = merge_catalogue(config, {
  seen: {
    searle: { discovery: up('searle', ['gemma4:26b', 'qwen3:4b']), at: '2026-10-31T12:00:00.000Z' },
    closet: { discovery: up('closet', ['gemma4:26b']), at: '2026-10-31T12:00:00.000Z' },
  },
  breakers: { nodes: {}, models: {} },
});

const rob = { name: 'rob', max_privacy: 'cloud', priority: 'interactive', keep_prompts: false } as const;

describe('models_list', () => {
  test('auto comes first whatever the file order', () => {
    expect(models_list(catalogue, config, rob).data.slice(0, 2).map(({ id }) => id)).toEqual(['auto', 'auto/fast']);
  });

  test('a tag two nodes share is listed as node/tag on both; a tag one node has is bare', () => {
    expect(models_list(catalogue, config, rob).data.slice(2).map(({ id, owned_by }) => [id, owned_by])).toEqual([
      ['searle/gemma4:26b', 'searle'],
      ['qwen3:4b', 'searle'],
      ['closet/gemma4:26b', 'closet'],
    ]);
  });

  test('a disabled node lists nothing; a local caller sees only local nodes', () => {
    const local = { ...rob, max_privacy: 'local' } as const;
    expect(models_list(catalogue, config, local).data.slice(2).map(({ id }) => id)).toEqual(['gemma4:26b']);
  });
});
