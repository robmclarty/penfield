import { z } from 'zod';

import {
  ALIASES_DEFAULT,
  CALLER_DEFAULTS,
  EFFORTS,
  FORMAT_DEFAULTS,
  POLICY_DEFAULTS,
  PROBE_DEFAULTS,
  RECOVER_DEFAULTS,
  SERVER_DEFAULTS,
  SLOTS_DEFAULT,
} from './defaults.js';

// The zod schema for penfield.yaml (spec §5.1). Every object is strict, so an
// unknown key fails at load. `check_references` below holds the static checks that
// need more than one section (D41); nothing here asks a node anything.

export type Listen = { host: string; port: number };

// `host:port`, with an IPv6 host in brackets (`[::1]:7777`).
export const parse_listen = (listen: string): Listen | undefined => {
  const match = /^(?:\[([\da-f:.]+)\]|([^\s:[\]]+)):(\d{1,5})$/i.exec(listen);
  const host = match?.[1] ?? match?.[2];
  const port = Number(match?.[3]);
  if (host === undefined || port > 65_535) return undefined;
  return { host, port };
};

const privacy = z.enum(['local', 'lan', 'cloud']);
const effort = z.enum(EFFORTS);
const format = z.enum(['openai', 'anthropic']);
const busy_mode = z.enum(['degrade', 'wait']);
const ms = z.int().min(1);

// Node, profile and caller names: no `/` or `@`, since a candidate uses both.
const name = z
  .string()
  .regex(
    /^[a-z\d][a-z\d._-]*$/,
    'a name is lowercase letters, digits, ".", "_" or "-", starting with a letter or digit',
  );

// D42: a `CLAUDE_` name may hold a subscription credential, which the gateway never
// reads (C2); the ast-grep rule sees only names written in code, not in the file.
const env_name = z
  .string()
  .regex(/^[A-Z_][A-Z\d_]*$/, 'an environment variable name')
  .refine(
    (value) => !value.startsWith('CLAUDE_'),
    'a CLAUDE_ variable may hold a Claude subscription credential, which penfield never reads (C2)',
  );

const server = z
  .strictObject({
    listen: z
      .string()
      .refine((value) => parse_listen(value) !== undefined, 'listen is host:port, an IPv6 host in brackets')
      .default(SERVER_DEFAULTS.listen),
    name: z.string().min(1).default(SERVER_DEFAULTS.name),
    state_dir: z.string().min(1).default(SERVER_DEFAULTS.state_dir),
    tokens_file: z.string().min(1).default(SERVER_DEFAULTS.tokens_file),
  })
  .prefault({});

const probe = z
  .strictObject({
    every_ms: ms.default(PROBE_DEFAULTS.every_ms),
    timeout_ms: ms.default(PROBE_DEFAULTS.timeout_ms),
    ready_prompt: z.boolean().default(PROBE_DEFAULTS.ready_prompt),
    open_after: z.int().min(1).default(PROBE_DEFAULTS.open_after),
    half_open_ms: ms.default(PROBE_DEFAULTS.half_open_ms),
  })
  .prefault({});

const recover = z
  .strictObject({
    unload_on_hang: z.boolean().default(RECOVER_DEFAULTS.unload_on_hang),
    // Stage D runs it, behind approval in the UI (spec §6).
    command: z.string().min(1).nullable().default(RECOVER_DEFAULTS.command),
    escalate_after_ms: ms.optional(),
  })
  .prefault({});

// `default` is the node's slot count; any other key is a model with its own.
const slots = z
  .object({ default: z.int().min(1).default(SLOTS_DEFAULT) })
  .catchall(z.int().min(1))
  .prefault({});

const formats = (fallback: readonly z.infer<typeof format>[]) =>
  z
    .array(format)
    .min(1)
    .default(() => [...fallback]);

// The fields of a node the gateway forwards to and discovers. `privacy` has no
// default: a cloud URL that quietly read as `lan` would fail open (C11).
const served = {
  url: z.url({ protocol: /^https?$/ }),
  privacy,
  discover: z.boolean().default(true),
  // The hand list: all a node that does not discover has (D24).
  models: z.array(z.string().min(1)).default(() => []),
  pinned: z.array(z.string().min(1)).default(() => []),
  slots,
  probe,
  recover,
  memory_gb: z.number().positive().optional(),
  api_key_env: env_name.optional(),
};

const node = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ollama'), ...served, formats: formats(FORMAT_DEFAULTS.ollama) }),
  z.strictObject({
    kind: z.literal('openai_compatible'),
    ...served,
    formats: formats(FORMAT_DEFAULTS.openai_compatible),
  }),
  z.strictObject({
    kind: z.literal('anthropic_api'),
    // Stage D executes it; off unless the file turns it on (D18).
    enabled: z.boolean().default(false),
    api_key_env: env_name,
    privacy: z.literal('cloud').default('cloud'),
    formats: formats(FORMAT_DEFAULTS.anthropic_api),
    models: z.array(z.string().min(1)).default(() => []),
  }),
  z.strictObject({
    // A decision, never an execution (D17): it has no URL and no credential.
    kind: z.literal('claude_decision'),
    privacy: z.literal('cloud').default('cloud'),
    models: z.array(z.enum(['haiku', 'sonnet', 'opus'])).min(1),
    efforts: z
      .array(effort)
      .min(1)
      .default(() => [...EFFORTS]),
  }),
]);

// Metadata overlaid on discovered models by glob, first match wins (D24).
const overlay = z.strictObject({
  profiles: z.array(z.string().min(1)).default(() => []),
  speed: z.enum(['fastest', 'fast', 'medium', 'slow']).optional(),
  quality: z.enum(['low', 'medium', 'high', 'frontier']).optional(),
  cost: z.enum(['free', 'low', 'medium', 'high']).optional(),
  context: z.int().positive().optional(),
});

// Ranked candidates: "node/model@effort", or "model" for any node that has it.
const profile = z.strictObject({ candidates: z.array(z.string().min(1)).min(1) });

const alias = z
  .strictObject({
    ladder: z.literal('default').optional(),
    profile: name.optional(),
    prefer: z.enum(['speed', 'quality']).optional(),
    max_privacy: privacy.optional(),
  })
  .refine(
    (value) => (value.ladder === undefined) !== (value.profile === undefined),
    'an alias takes one of `ladder: default` or `profile: <name>`',
  );

const factors = ['privacy', 'quality', 'speed', 'cost'] as const;

const policy = z
  .strictObject({
    precedence: z
      .array(z.enum(factors))
      .refine(
        (value) => value.length === factors.length && new Set(value).size === factors.length,
        'precedence lists privacy, quality, speed and cost, each once',
      )
      .default(() => [...POLICY_DEFAULTS.precedence]),
    confidence_threshold: z.number().min(0).max(1).default(POLICY_DEFAULTS.confidence_threshold),
    cold_load: z.enum(['allow', 'avoid', 'never']).default(POLICY_DEFAULTS.cold_load),
    // Any key beyond these is a profile with its own value (D15).
    busy: z
      .object({
        default: busy_mode.default(POLICY_DEFAULTS.busy),
        wait_ms: z.int().min(0).default(POLICY_DEFAULTS.wait_ms),
      })
      .catchall(busy_mode)
      .prefault({}),
    on_claude_for_proxy: z.enum(['hint', 'downgrade', 'api_key']).default(POLICY_DEFAULTS.on_claude_for_proxy),
    stall_ms: z
      .object({
        default: ms.default(POLICY_DEFAULTS.stall_ms),
        first_token_cold: ms.default(POLICY_DEFAULTS.first_token_cold_ms),
      })
      .catchall(ms)
      .prefault({}),
    deadline_ms: z
      .object({ default: ms.default(POLICY_DEFAULTS.deadline_ms) })
      .catchall(ms)
      .prefault({}),
  })
  .prefault({});

const rule = z.strictObject({
  when: z.strictObject({
    endpoint: z.enum(['chat', 'embeddings', 'messages', 'audio_transcriptions', 'audio_speech']).optional(),
    hint: z.literal('present').optional(),
    tools: z.boolean().optional(),
    tokens_gt: z.int().min(0).optional(),
    attachments: z.enum(['none', 'code', 'docs', 'images']).optional(),
    system_matches: z.string().min(1).optional(),
    chat: z.boolean().optional(),
  }),
  profile: z.string().regex(/^(?:\$hint|[a-z\d][a-z\d._-]*)$/, 'a profile name, or $hint'),
});

const router = z
  .strictObject({
    // Evaluated in order, first match wins.
    rules: z.array(rule).default(() => []),
    // Stage C reads these three.
    exemplars: z.string().min(1).optional(),
    embedder: z.string().min(1).optional(),
    classifier: z.string().min(1).optional(),
  })
  .prefault({});

const caller = z.strictObject({
  max_privacy: privacy.default(CALLER_DEFAULTS.max_privacy),
  // What a proxy endpoint does with a Claude decision for this caller (D19).
  claude: z.enum(['decision', 'hint', 'downgrade', 'api_key']).optional(),
  priority: z.enum(['interactive', 'batch']).default(CALLER_DEFAULTS.priority),
  keep_prompts: z.boolean().default(CALLER_DEFAULTS.keep_prompts),
  busy: busy_mode.optional(),
  wait_ms: z.int().min(0).optional(),
  // The models it may use; an `auto` request is filtered to them (D38).
  models: z.array(z.string().min(1)).optional(),
});

export const config_schema = z.strictObject({
  version: z.literal(1),
  server,
  nodes: z.record(name, node).refine((value) => Object.keys(value).length > 0, 'at least one node'),
  models: z.record(z.string().min(1), overlay).default(() => ({})),
  profiles: z.record(name, profile).default(() => ({})),
  aliases: z
    .record(z.string().regex(/^\S+$/, 'an alias has no spaces'), alias)
    .default(() => structuredClone(ALIASES_DEFAULT)),
  policy,
  router,
  callers: z.record(name, caller).default(() => ({})),
});

export type Config = z.output<typeof config_schema>;
export type NodeConfig = Config['nodes'][string];
export type CallerConfig = Config['callers'][string];
export type Privacy = z.output<typeof privacy>;
export type Effort = z.output<typeof effort>;
export type Format = z.output<typeof format>;

export type ReferenceIssue = { path: (string | number)[]; message: string; at_key?: true };

// ── static checks across sections (D41) ──────────────────────────────────────

// A node's models when they are all it can ever have; undefined when it discovers.
const hand_list = (entry: NodeConfig): readonly string[] | undefined => {
  if (entry.kind === 'claude_decision' || entry.kind === 'anthropic_api') return entry.models;
  return entry.discover ? undefined : entry.models;
};

const check_bare_model = (config: Config, model: string): string | undefined => {
  const possible = Object.values(config.nodes).some((entry) => hand_list(entry)?.includes(model) ?? true);
  return possible ? undefined : `no node lists "${model}", and none discovers its models`;
};

const check_effort = (entry: NodeConfig, node_name: string, value: string): string | undefined => {
  const known = effort.safeParse(value);
  if (!known.success) return `effort "${value}" is not one of ${EFFORTS.join(', ')}`;
  if (entry.kind === 'claude_decision' && !entry.efforts.includes(known.data)) {
    return `node "${node_name}" does not offer effort "${value}"`;
  }
  return undefined;
};

// The text before the first `/` is always a node, so a model id with a slash in it
// keeps its node prefix (`openrouter/anthropic/claude-sonnet-5.5`).
const check_candidate = (config: Config, candidate: string): string | undefined => {
  const at = candidate.lastIndexOf('@');
  const body = at === -1 ? candidate : candidate.slice(0, at);
  const slash = body.indexOf('/');
  if (slash === -1) {
    if (at !== -1 && !effort.safeParse(candidate.slice(at + 1)).success) {
      return `effort "${candidate.slice(at + 1)}" is not one of ${EFFORTS.join(', ')}`;
    }
    return check_bare_model(config, body);
  }
  const node_name = body.slice(0, slash);
  const model = body.slice(slash + 1);
  const entry = config.nodes[node_name];
  if (entry === undefined) return `names node "${node_name}", which is not in nodes`;
  if (model === '') return 'names no model after the node';
  if (hand_list(entry)?.includes(model) === false) return `node "${node_name}" does not list model "${model}"`;
  return at === -1 ? undefined : check_effort(entry, node_name, candidate.slice(at + 1));
};

const check_profiles = (config: Config): ReferenceIssue[] =>
  Object.entries(config.profiles).flatMap(([profile_name, entry]) =>
    entry.candidates.flatMap((candidate, index) => {
      const message = check_candidate(config, candidate);
      return message === undefined ? [] : [{ path: ['profiles', profile_name, 'candidates', index], message }];
    }),
  );

const check_aliases = (config: Config): ReferenceIssue[] =>
  Object.entries(config.aliases).flatMap(([alias_name, entry]) =>
    entry.profile === undefined || entry.profile in config.profiles
      ? []
      : [{ path: ['aliases', alias_name, 'profile'], message: `profile "${entry.profile}" is not defined in profiles` }],
  );

const check_pins = (config: Config): ReferenceIssue[] =>
  Object.entries(config.nodes).flatMap(([node_name, entry]) => {
    if (entry.kind !== 'ollama' && entry.kind !== 'openai_compatible') return [];
    const list = hand_list(entry);
    return entry.pinned.flatMap((model, index) =>
      list === undefined || list.includes(model)
        ? []
        : [
            {
              path: ['nodes', node_name, 'pinned', index],
              message: `pinned model "${model}" is not in the node's models, and the node does not discover`,
            },
          ],
    );
  });

// The per-profile keys of busy, stall_ms and deadline_ms must name a profile.
const check_policy_keys = (config: Config): ReferenceIssue[] => {
  const sections: { section: string; values: object; reserved: readonly string[] }[] = [
    { section: 'busy', values: config.policy.busy, reserved: ['default', 'wait_ms'] },
    { section: 'stall_ms', values: config.policy.stall_ms, reserved: ['default', 'first_token_cold'] },
    { section: 'deadline_ms', values: config.policy.deadline_ms, reserved: ['default'] },
  ];
  return sections.flatMap(({ section, values, reserved }) =>
    Object.keys(values)
      .filter((key) => !reserved.includes(key) && !(key in config.profiles))
      .map((key) => ({
        path: ['policy', section, key],
        message: `unknown key "${key}": not a profile`,
        at_key: true as const,
      })),
  );
};

export const check_references = (config: Config): ReferenceIssue[] => [
  ...check_aliases(config),
  ...check_profiles(config),
  ...check_pins(config),
  ...check_policy_keys(config),
];
