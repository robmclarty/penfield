import type { CallerConfig, Config, Effort, Privacy } from '../config/index.js';

// Spec §5.2: what the wire reads from a request before routing; the router reads
// nothing else of the body. The enums come from the config schema, so a router
// rule and the input it is matched against cannot drift apart.

type When = Config['router']['rules'][number]['when'];

export type Endpoint = NonNullable<When['endpoint']>;

export type Attachments = NonNullable<When['attachments']>;

export type Prefer = NonNullable<Config['aliases'][string]['prefer']>;

// The caller the wire authenticated: its name and its policy from `callers:`.
export type RouteCaller = CallerConfig & { name: string };

// From `x-penfield-*` headers or the body's `metadata.penfield`.
export type Hints = { profile?: string; max_privacy?: Privacy; prefer?: Prefer; effort?: Effort };

export type RouteInput = {
  request_id: string;
  caller: RouteCaller;
  format: 'openai' | 'anthropic';
  endpoint: Endpoint;
  // As sent: a concrete id, an alias or a profile name.
  model: string;
  // The last user message's text, its first 4 k chars.
  text: string;
  // The system prompt's first 1 k chars, or empty.
  system_text: string;
  // The messages before the last user message, system prompts aside.
  history_turns: number;
  // Chars over four, across every message.
  tokens_estimate: number;
  tools: boolean;
  attachments: Attachments;
  hints: Hints;
};

// A body the router cannot read is refused with the reason, for the wire's 400.
export type InputResult = { ok: true; input: RouteInput } | { ok: false; reason: string };
