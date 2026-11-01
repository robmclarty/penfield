import type { Config } from '../../config/index.js';
import type { Endpoint, RouteInput, RungResult } from '../types.js';

// D35: the rule rung walks `router.rules` in file order and the first rule whose
// every condition holds answers, at 1.0. A condition the rule leaves out holds for
// any request. `$hint` routes to the profile the request's hint names.

type Rule = Config['router']['rules'][number];

type When = Rule['when'];

const CHAT: ReadonlySet<Endpoint> = new Set(['chat', 'messages']);

// The file writes PCRE's inline flags (`(?i)classif`), which a JS RegExp rejects,
// so a leading group of them becomes the RegExp's own flags.
const INLINE_FLAGS = /^\(\?([ims]+)\)/;

const compile = (pattern: string): RegExp | Error => {
  const inline = INLINE_FLAGS.exec(pattern);
  try {
    return inline === null ? new RegExp(pattern) : new RegExp(pattern.slice(inline[0].length), inline[1]);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
};

const check = <K extends keyof When>(when: When, key: K, test: (value: NonNullable<When[K]>) => boolean): boolean => {
  const value = when[key];
  return value === undefined || test(value);
};

// `system_matches` is tested apart, since its pattern is compiled first.
const holds = (when: When, input: RouteInput): boolean =>
  check(when, 'endpoint', (endpoint) => endpoint === input.endpoint) &&
  check(when, 'hint', () => input.hints.profile !== undefined) &&
  check(when, 'tools', (tools) => tools === input.tools) &&
  check(when, 'tokens_gt', (tokens) => input.tokens_estimate > tokens) &&
  check(when, 'attachments', (attachments) => attachments === input.attachments) &&
  check(when, 'chat', (chat) => chat === CHAT.has(input.endpoint));

const ATTACHED: Record<NonNullable<When['attachments']>, string> = {
  none: 'nothing attached',
  code: 'code attached',
  docs: 'docs attached',
  images: 'images attached',
};

// The rule's conditions as the reasons read them: `tools, over 12000 tokens`.
const describe = (when: When): string => {
  const parts = [
    when.endpoint === undefined ? [] : [`the ${when.endpoint} endpoint`],
    when.hint === undefined ? [] : ['a profile hint'],
    when.tools === undefined ? [] : [when.tools ? 'tools' : 'no tools'],
    when.tokens_gt === undefined ? [] : [`over ${when.tokens_gt} tokens`],
    when.attachments === undefined ? [] : [ATTACHED[when.attachments]],
    when.system_matches === undefined ? [] : [`a system prompt matching ${when.system_matches}`],
    when.chat === undefined ? [] : [when.chat ? 'chat' : 'not chat'],
  ].flat();
  return parts.length === 0 ? 'any request' : parts.join(', ');
};

const answer = (rule: Rule, number: number, input: RouteInput): RungResult => {
  const said = `rule ${number} (${describe(rule.when)})`;
  if (rule.profile !== '$hint') return { kind: 'answer', profile: rule.profile, confidence: 1, reason: `${said}: ${rule.profile}` };
  const hinted = input.hints.profile;
  return hinted === undefined
    ? { kind: 'pass', reason: null }
    : { kind: 'answer', profile: hinted, confidence: 1, reason: `${said}: ${hinted}, as hinted` };
};

// One rule against the request: its answer, a pass, or a refusal when its pattern
// does not compile, since skipping a broken rule would route the request elsewhere
// in silence. The pattern reads `system_text`, which the input caps at 1 k chars.
const try_rule = (rule: Rule, number: number, input: RouteInput): RungResult => {
  if (!holds(rule.when, input)) return { kind: 'pass', reason: null };
  if (rule.when.system_matches !== undefined) {
    const pattern = compile(rule.when.system_matches);
    if (pattern instanceof Error) {
      return { kind: 'refused', reason: `rule ${number}'s system_matches does not compile: ${pattern.message}` };
    }
    if (!pattern.test(input.system_text)) return { kind: 'pass', reason: null };
  }
  return answer(rule, number, input);
};

export const rule = (input: RouteInput, rules: readonly Rule[]): RungResult => {
  for (const [index, each] of rules.entries()) {
    const result = try_rule(each, index + 1, input);
    if (result.kind !== 'pass') return result;
  }
  return { kind: 'pass', reason: `rule: none of ${rules.length} matched` };
};
