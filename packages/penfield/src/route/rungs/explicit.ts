import { names_model } from '../../catalogue/index.js';
import type { Catalogue } from '../../catalogue/index.js';

// D6: a model the catalogue has is forwarded to a node that has it, and no rung
// below runs. The answer is the nodes that have it, or null for none.
export const explicit = (model: string, catalogue: Pick<Catalogue, 'models'>): string | null => {
  const nodes = [...new Set(catalogue.models.filter((each) => names_model(model, each)).map(({ node }) => node))];
  if (nodes.length === 0) return null;
  return `explicit: ${nodes.join(', ')} ${nodes.length === 1 ? 'has' : 'have'} "${model}"`;
};

// Why a model that is no alias, profile or catalogue model is refused. A node that
// is down may hold it, so each one is named with its reason.
export const unknown_model = (model: string, catalogue: Pick<Catalogue, 'nodes'>): string => {
  const down = catalogue.nodes
    .filter(({ state }) => state === 'down')
    .map(({ name, reason }) => `${name} is down: ${reason ?? 'no reason given'}`);
  const base = `"${model}" is no alias, profile or model in the catalogue`;
  return down.length === 0 ? base : `${base} (${down.join('; ')})`;
};
