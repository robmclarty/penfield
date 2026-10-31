// The values penfield.yaml may leave out. The schema applies them at load, so the
// merged config `check-config` prints carries every one of them.

export const SERVER_DEFAULTS = {
  // Loopback until the file names the LAN address (C5).
  listen: '127.0.0.1:7777',
  name: 'penfield',
  state_dir: '/var/lib/penfield',
  tokens_file: '/etc/penfield/tokens',
} as const;

export const PROBE_DEFAULTS = {
  every_ms: 10_000,
  timeout_ms: 3_000,
  // Off until Q2 (readiness-ping-cost) is measured on searle.
  ready_prompt: false,
  // Consecutive failures that open the breaker, and the half-open retry (spec §6).
  open_after: 3,
  half_open_ms: 30_000,
} as const;

export const RECOVER_DEFAULTS = {
  unload_on_hang: false,
  command: null,
} as const;

export const SLOTS_DEFAULT = 1;

// What each kind of node accepts on the wire unless its entry says otherwise.
export const FORMAT_DEFAULTS = {
  ollama: ['openai', 'anthropic'],
  openai_compatible: ['openai'],
  anthropic_api: ['anthropic'],
} as const;

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export const POLICY_DEFAULTS = {
  precedence: ['privacy', 'quality', 'speed', 'cost'],
  confidence_threshold: 0.7,
  cold_load: 'avoid',
  busy: 'degrade',
  wait_ms: 5_000,
  on_claude_for_proxy: 'hint',
  stall_ms: 30_000,
  first_token_cold_ms: 90_000,
  deadline_ms: 600_000,
} as const;

export const CALLER_DEFAULTS = {
  // D10: a caller reaches local and LAN nodes unless its entry says cloud.
  max_privacy: 'lan',
  priority: 'interactive',
  keep_prompts: false,
} as const;

// `auto` exists even when the file has no `aliases:` key.
export const ALIASES_DEFAULT = { auto: { ladder: 'default' } } as const;
