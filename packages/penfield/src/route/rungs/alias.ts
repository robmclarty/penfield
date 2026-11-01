import type { Config } from '../../config/index.js';
import type { AliasPolicy } from '../types.js';

// The alias rung: a name from `aliases:` routes to its profile or runs the ladder,
// and a profile's own name routes to that profile (spec §5.1). An alias carries its
// `prefer` and `max_privacy` with it, whichever rung answers.

export type Aliased =
  | { kind: 'profile'; profile: string; reason: string; policy: AliasPolicy }
  | { kind: 'ladder'; reason: string; policy: AliasPolicy }
  | { kind: 'none' };

type Alias = Config['aliases'][string];

const policy_of = ({ prefer, max_privacy }: Alias): AliasPolicy => ({
  ...(prefer === undefined ? {} : { prefer }),
  ...(max_privacy === undefined ? {} : { max_privacy }),
});

const describe = (policy: AliasPolicy): string =>
  [
    ...(policy.prefer === undefined ? [] : [`prefer ${policy.prefer}`]),
    ...(policy.max_privacy === undefined ? [] : [`max_privacy ${policy.max_privacy}`]),
  ]
    .map((part) => `, ${part}`)
    .join('');

export const alias = (model: string, config: Pick<Config, 'aliases' | 'profiles'>): Aliased => {
  // `Object.hasOwn`, so a model named `constructor` is no alias.
  const entry = Object.hasOwn(config.aliases, model) ? config.aliases[model] : undefined;
  if (entry !== undefined) {
    const policy = policy_of(entry);
    const said = describe(policy);
    return entry.profile === undefined
      ? { kind: 'ladder', reason: `alias: "${model}" runs the ladder${said}`, policy }
      : { kind: 'profile', profile: entry.profile, reason: `alias: "${model}" is profile "${entry.profile}"${said}`, policy };
  }
  if (Object.hasOwn(config.profiles, model)) {
    return { kind: 'profile', profile: model, reason: `alias: "${model}" is a profile`, policy: {} };
  }
  return { kind: 'none' };
};
