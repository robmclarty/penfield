import { z } from 'zod';

import type { Db, Row } from './db.js';

// `log.decision`: one append-only row per Decision in `decisions` (spec §5.5, D31,
// D43), in the gateway's own schema (D23), and the read that gives it back. A row
// read back is the Decision as it was sent, beside the outcome columns the proxy
// fills in once it runs one (`log_outcome`): a dry decision has none of them.

// The Decision as the log keeps it. Placement's `Decision` fits it; the log names
// its own shape so it never imports what it records.
const target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('proxy'), node: z.string(), model: z.string(), format: z.string() }),
  z.object({ kind: z.literal('claude_decision'), model: z.string(), effort: z.string() }),
  z.object({ kind: z.literal('refused'), reason: z.string() }),
]);

type Target = z.output<typeof target>;

const policy = z.object({
  max_privacy: z.string(),
  prefer: z.string().optional(),
  busy: z.string(),
  wait_ms: z.number().optional(),
});

type Placement = { resident: boolean; cold_load: boolean; waited_ms: number; degraded_from?: string };

export type LoggedDecision = {
  id: string;
  request_id: string;
  at: string;
  caller: string;
  profile: string | null;
  rung: string;
  confidence: number;
  reasons: string[];
  target: Target;
  alternatives: Target[];
  placement: Placement;
  policy: z.output<typeof policy>;
};

// The RouteInput it was decided from. Its text is kept only under the caller's
// `keep_prompts` (D22); the rest is kept so `replay` can route the row again.
type LoggedInput = { text: string; system_text: string; format: string; caller: { keep_prompts: boolean } };

export type DecisionRow = LoggedDecision & {
  // Null until the proxy writes one; `refused` from the start for a refusal.
  outcome: string | null;
  first_byte_ms: number | null;
  total_ms: number | null;
  bytes_out: number | null;
  upstream_status: number | null;
  upstream_prompt_tokens: number | null;
};

const INSERT = `insert into decisions (
  id, request_id, at, caller, profile, rung, confidence,
  target_kind, target_node, target_model, effort, alternatives, reasons,
  resident, cold_load, waited_ms, degraded_from, outcome, prompt, input, policy
) values (
  :id, :request_id, :at, :caller, :profile, :rung, :confidence,
  :target_kind, :target_node, :target_model, :effort, :alternatives, :reasons,
  :resident, :cold_load, :waited_ms, :degraded_from, :outcome, :prompt, :input, :policy
)`;

export const log_decision = (db: Db, decision: LoggedDecision, input: LoggedInput): void => {
  const { target: chosen, placement } = decision;
  const { text, system_text, ...rest } = input;
  db.run(INSERT, {
    id: decision.id,
    request_id: decision.request_id,
    at: decision.at,
    caller: decision.caller,
    profile: decision.profile,
    rung: decision.rung,
    confidence: decision.confidence,
    target_kind: chosen.kind,
    target_node: chosen.kind === 'proxy' ? chosen.node : null,
    target_model: chosen.kind === 'refused' ? null : chosen.model,
    effort: chosen.kind === 'claude_decision' ? chosen.effort : null,
    alternatives: JSON.stringify(decision.alternatives),
    reasons: JSON.stringify(decision.reasons),
    resident: placement.resident ? 1 : 0,
    cold_load: placement.cold_load ? 1 : 0,
    waited_ms: placement.waited_ms,
    degraded_from: placement.degraded_from ?? null,
    outcome: chosen.kind === 'refused' ? 'refused' : null,
    prompt: input.caller.keep_prompts ? JSON.stringify({ text, system_text }) : null,
    input: JSON.stringify(rest),
    policy: JSON.stringify(decision.policy),
  });
};

// ── the outcome ───────────────────────────────────────────────────────────────

// `log.outcome`: what the proxy writes on a decision's row once its forward ends.
// Timings are from the forward's dispatch; `bytes_out` is what the client got.
export type LoggedOutcome = {
  outcome: string;
  first_byte_ms: number | null;
  total_ms: number;
  bytes_out: number;
  upstream_status: number | null;
  upstream_prompt_tokens: number | null;
};

// Written once: a row that already has an outcome keeps it.
const OUTCOME = `update decisions set
  outcome = :outcome, first_byte_ms = :first_byte_ms, total_ms = :total_ms,
  bytes_out = :bytes_out, upstream_status = :upstream_status, upstream_prompt_tokens = :upstream_prompt_tokens
where id = :id and outcome is null`;

export const log_outcome = (db: Db, id: string, outcome: LoggedOutcome): void => {
  db.run(OUTCOME, { id, ...outcome });
};

// ── reading it back ───────────────────────────────────────────────────────────

// `since` is an ISO time, as `at` is written, so the two compare as text.
export type DecisionQuery = { caller?: string | undefined; since?: string | undefined; limit: number };

const SELECT = `select * from decisions
where (:caller is null or caller = :caller) and (:since is null or at >= :since)
order by at desc, rowid desc
limit :limit`;

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`decisions.${key} is not text`);
  return value;
};

const text_or_null = (row: Row, key: string): string | null => {
  const value = row[key];
  return typeof value === 'string' ? value : null;
};

const number_or_null = (row: Row, key: string): number | null => {
  const value = row[key];
  return typeof value === 'number' ? value : null;
};

const json = <T>(row: Row, key: string, schema: z.ZodType<T>): T => schema.parse(JSON.parse(text(row, key)));

const input_format = z.object({ format: z.string() });

// The row has the target's columns, not the target. A proxy target is in the
// request's own format (C1), which the input keeps; a refusal's reason is the last
// of its reasons, which every refusal ends on, behind the stage that refused it.
const target_of = (row: Row, reasons: readonly string[]): Target => {
  const kind = text(row, 'target_kind');
  if (kind === 'proxy') {
    const { format } = json(row, 'input', input_format);
    return { kind, node: text(row, 'target_node'), model: text(row, 'target_model'), format };
  }
  if (kind === 'claude_decision') return { kind, model: text(row, 'target_model'), effort: text(row, 'effort') };
  if (kind === 'refused') return { kind, reason: (reasons.at(-1) ?? '').replace(/^(?:place|policy): refused: /, '') };
  throw new Error(`decisions.target_kind "${kind}" is not a target`);
};

const to_row = (row: Row): DecisionRow => {
  const reasons = json(row, 'reasons', z.array(z.string()));
  const degraded_from = text_or_null(row, 'degraded_from');
  return {
    id: text(row, 'id'),
    request_id: text(row, 'request_id'),
    at: text(row, 'at'),
    caller: text(row, 'caller'),
    profile: text_or_null(row, 'profile'),
    rung: text(row, 'rung'),
    confidence: number_or_null(row, 'confidence') ?? 0,
    reasons,
    target: target_of(row, reasons),
    alternatives: json(row, 'alternatives', z.array(target)),
    placement: {
      resident: row['resident'] === 1,
      cold_load: row['cold_load'] === 1,
      waited_ms: number_or_null(row, 'waited_ms') ?? 0,
      ...(degraded_from === null ? {} : { degraded_from }),
    },
    policy: json(row, 'policy', policy),
    outcome: text_or_null(row, 'outcome'),
    first_byte_ms: number_or_null(row, 'first_byte_ms'),
    total_ms: number_or_null(row, 'total_ms'),
    bytes_out: number_or_null(row, 'bytes_out'),
    upstream_status: number_or_null(row, 'upstream_status'),
    upstream_prompt_tokens: number_or_null(row, 'upstream_prompt_tokens'),
  };
};

// Newest first; rows decided in the same millisecond, latest written first.
export const read_decisions = (db: Db, { caller, since, limit }: DecisionQuery): DecisionRow[] =>
  db.all(SELECT, { caller: caller ?? null, since: since ?? null, limit }).map(to_row);
