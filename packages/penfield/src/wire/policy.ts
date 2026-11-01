import { names_model } from '../catalogue/index.js';
import type { Catalogue, CatalogueModel, CatalogueNode } from '../catalogue/index.js';
import type { Privacy } from '../config/index.js';
import type { RoutedProfile } from '../route/index.js';
import type { Caller } from './auth.js';

// What a caller may use (D10, D38), read one way by `/v1/models`, which lists only
// that, and by every endpoint that takes a model. An `auto`, alias or profile
// request is filtered to it by placement. A request that names a model the caller
// may use on no node that has it fails closed (C11): a refusal with the reason,
// which the endpoint sends as a 403, and never another model in its place.

const RANK: Record<Privacy, number> = { local: 0, lan: 1, cloud: 2 };

// Why the caller may not use the model on its node, or null when it may.
export const bar_of = (model: CatalogueModel, node: Pick<CatalogueNode, 'name' | 'privacy'>, caller: Caller): string | null => {
  if (RANK[node.privacy] > RANK[caller.max_privacy]) {
    return `node ${node.name} is ${node.privacy}, above its max_privacy ${caller.max_privacy}`;
  }
  if (caller.models !== undefined && !caller.models.some((wanted) => names_model(wanted, model))) {
    return "it is not in the caller's models list";
  }
  return null;
};

// `forbidden` is true when the route is the policy's refusal, for the endpoint's 403.
export type Checked = { routed: RoutedProfile; forbidden: boolean };

// The route placement takes: the ladder's, or a refusal naming every bar when the
// caller may use the named model on none of the nodes that have it. One node it
// may use is enough, since placement then chooses only among those (D6).
export const check_policy = (routed: RoutedProfile, caller: Caller, catalogue: Catalogue): Checked => {
  if (routed.kind !== 'model') return { routed, forbidden: false };
  const nodes = new Map(catalogue.nodes.map((node) => [node.name, node]));
  const bars = catalogue.models.flatMap((model) => {
    const node = nodes.get(model.node);
    return node === undefined || !names_model(routed.model, model) ? [] : [bar_of(model, node, caller)];
  });
  const named = bars.filter((bar): bar is string => bar !== null);
  if (named.length === 0 || named.length < bars.length) return { routed, forbidden: false };
  const reason = `caller ${caller.name} may not use "${routed.model}": ${[...new Set(named)].join('; ')}`;
  return {
    routed: {
      kind: 'refused',
      reason,
      rung: routed.rung,
      confidence: routed.confidence,
      reasons: [...routed.reasons, `policy: refused: ${reason}`],
    },
    forbidden: true,
  };
};
