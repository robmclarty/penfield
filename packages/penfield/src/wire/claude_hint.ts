import type { Decision } from '../place/index.js';
import { sse_event } from './sse.js';

// D19's `hint`: a proxy endpoint cannot run a Claude decision, since penfield holds
// no Claude login (C2), so it answers with an OpenAI chat completion of its own,
// one assistant message naming the model and effort the requester's own Claude
// client should run it with. It goes out in the shape the request asked for: one
// JSON body, or an event stream ending in `[DONE]` when it said `stream: true`.

type ClaudeTarget = Extract<Decision['target'], { kind: 'claude_decision' }>;

export type Hint = {
  // The decision's id, which the completion's id carries.
  decision_id: string;
  // The model as the request named it (`auto`, `code-heavy`).
  model: string;
  profile: string | null;
  target: ClaudeTarget;
  // Seconds since the epoch.
  created: number;
};

const text_of = ({ target, profile }: Hint): string => {
  const routed = profile === null ? '' : ` (profile ${profile})`;
  const run = `${target.model} at ${target.effort} effort`;
  return (
    `penfield routes this to Claude ${run}${routed}. ` +
    `penfield does not run Claude itself, so send it from your Claude client with ${run}, or pick a local model to have it answered here.`
  );
};

// No model ran, so nothing was counted.
const USAGE = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

const head = (hint: Hint, object: string): Record<string, unknown> => ({
  id: `chatcmpl-${hint.decision_id}`,
  object,
  created: hint.created,
  model: hint.model,
});

export const hint_completion = (hint: Hint): string =>
  JSON.stringify({
    ...head(hint, 'chat.completion'),
    choices: [{ index: 0, message: { role: 'assistant', content: text_of(hint) }, finish_reason: 'stop' }],
    usage: USAGE,
  });

// The chunks in the order a node streams them: the message, its finish, the usage
// when `stream_options.include_usage` asked for it, then `[DONE]`.
export const hint_events = (hint: Hint, include_usage: boolean): string => {
  const chunk = head(hint, 'chat.completion.chunk');
  return [
    sse_event({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: text_of(hint) }, finish_reason: null }] }),
    sse_event({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ...(include_usage ? [sse_event({ ...chunk, choices: [], usage: USAGE })] : []),
    'data: [DONE]\n\n',
  ].join('');
};
