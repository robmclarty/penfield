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

// ── the ladder ────────────────────────────────────────────────────────────────

// D7's rungs, cheapest first. Stage A ships all but `embedding` and `classifier`.
export type Rung = 'explicit' | 'alias' | 'shape' | 'rule' | 'embedding' | 'classifier' | 'default';

// What a rung says: a profile and how sure it is, a refusal, or nothing. Each
// carries the line it adds to the Decision's reasons; a pass may add none.
export type Answer = { kind: 'answer'; profile: string; confidence: number; reason: string };

export type RungResult = Answer | { kind: 'refused'; reason: string } | { kind: 'pass'; reason: string | null };

// The embedding and classifier rungs call a model, so the ladder takes them as
// functions and Stage A passes none (C3).
export type ModelRung = (input: RouteInput) => Promise<RungResult>;

export type ModelRungs = { embedding?: ModelRung; classifier?: ModelRung };

// What an alias asks of placement beside its profile (D10).
export type AliasPolicy = { prefer?: Prefer; max_privacy?: Privacy };

// What the ladder hands placement: a profile to place, the one model the request
// named (D6), or a refusal with its reason.
export type RoutedProfile = AliasPolicy & { rung: Rung; confidence: number; reasons: string[] } & (
    | { kind: 'profile'; profile: string }
    | { kind: 'model'; model: string }
    | { kind: 'refused'; reason: string }
  );
