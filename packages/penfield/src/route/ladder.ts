import type { Catalogue } from '../catalogue/index.js';
import type { Config } from '../config/index.js';
import { alias } from './rungs/alias.js';
import { by_default } from './rungs/default.js';
import { explicit, unknown_model } from './rungs/explicit.js';
import { rule } from './rungs/rule.js';
import { shape } from './rungs/shape.js';
import type { AliasPolicy, Answer, ModelRungs, RouteInput, RoutedProfile, Rung, RungResult } from './types.js';

// The ladder (D7): `explicit`, then `alias`, then for an alias that runs it `shape`,
// `rule`, the model rungs Stage C passes in, and `default`. The first rung whose
// answer clears `confidence_threshold` decides; nothing here reads a node, a lease
// or a clock, so the same input routes the same way every time, and `replay` can
// re-run it over the log.

type RouteConfig = Pick<Config, 'aliases' | 'profiles' | 'router' | 'policy'>;

type Step = { rung: Rung; run: (input: RouteInput) => RungResult | Promise<RungResult> };

const steps = (config: RouteConfig, rungs: ModelRungs): Step[] => [
  { rung: 'shape', run: shape },
  { rung: 'rule', run: (input) => rule(input, config.router.rules) },
  ...(rungs.embedding === undefined ? [] : [{ rung: 'embedding' as const, run: rungs.embedding }]),
  ...(rungs.classifier === undefined ? [] : [{ rung: 'classifier' as const, run: rungs.classifier }]),
];

type Trail = { reasons: string[]; policy: AliasPolicy };

const refused = (rung: Rung, confidence: number, reason: string, trail: Trail): RoutedProfile => ({
  ...trail.policy,
  kind: 'refused',
  reason,
  rung,
  confidence,
  reasons: [...trail.reasons, reason],
});

// A profile `profiles:` does not define is refused here, whichever rung named it,
// so a rule or a hint naming one fails with the reason rather than falling through.
const answered = (rung: Rung, answer: Answer, config: RouteConfig, trail: Trail): RoutedProfile => {
  const reasons = [...trail.reasons, answer.reason];
  const { profile, confidence } = answer;
  if (!Object.hasOwn(config.profiles, profile)) {
    return refused(rung, confidence, `no profile "${profile}" in penfield.yaml's profiles`, { ...trail, reasons });
  }
  return { ...trail.policy, kind: 'profile', profile, rung, confidence, reasons };
};

// A threshold of 1 still lets the 1.0 rungs answer, so clearing it is meeting it.
const climb = async (input: RouteInput, config: RouteConfig, rungs: ModelRungs, trail: Trail): Promise<RoutedProfile> => {
  const { confidence_threshold } = config.policy;
  const reasons = [...trail.reasons];
  for (const { rung, run } of steps(config, rungs)) {
    // One rung at a time, cheapest first: a rung below runs only if this one passes.
    const result = await run(input);
    if (result.kind === 'refused') return refused(rung, 1, result.reason, { ...trail, reasons });
    if (result.kind === 'answer' && result.confidence >= confidence_threshold) {
      return answered(rung, result, config, { ...trail, reasons });
    }
    if (result.kind === 'answer') {
      reasons.push(`${result.reason}, at ${result.confidence} below the ${confidence_threshold} threshold`);
    } else if (result.reason !== null) {
      reasons.push(result.reason);
    }
  }
  return answered('default', by_default(), config, { ...trail, reasons });
};

export const route = async (
  input: RouteInput,
  catalogue: Pick<Catalogue, 'models' | 'nodes'>,
  config: RouteConfig,
  rungs: ModelRungs = {},
): Promise<RoutedProfile> => {
  const named = explicit(input.model, catalogue);
  if (named !== null) return { kind: 'model', model: input.model, rung: 'explicit', confidence: 1, reasons: [named] };
  const aliased = alias(input.model, config);
  if (aliased.kind === 'none') return refused('explicit', 1, unknown_model(input.model, catalogue), { reasons: [], policy: {} });
  const { policy } = aliased;
  if (aliased.kind === 'profile') {
    const answer: Answer = { kind: 'answer', profile: aliased.profile, confidence: 1, reason: aliased.reason };
    return answered('alias', answer, config, { reasons: [], policy });
  }
  return climb(input, config, rungs, { reasons: [aliased.reason], policy });
};
