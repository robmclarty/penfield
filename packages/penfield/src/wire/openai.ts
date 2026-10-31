import { names_model } from '../catalogue/index.js';
import type { Catalogue, CatalogueModel } from '../catalogue/index.js';
import type { Config, Privacy } from '../config/index.js';
import type { Caller } from './auth.js';

// GET /v1/models (spec §5.4): `auto` and the other aliases, the profile names, then
// the catalogue's models this caller may reach, in OpenAI's list shape. A model is
// listed by its tag, as a client sends it, and a decision node's as `node/model`
// (`claude/opus`); a tag two nodes share is listed as `node/tag` on both. Each
// entry carries a `penfield` object saying what it is.

const RANK: Record<Privacy, number> = { local: 0, lan: 1, cloud: 2 };

type Alias = Config['aliases'][string];

type Penfield =
  | ({ kind: 'alias' } & Alias)
  | { kind: 'profile' }
  | {
      kind: 'model';
      node: string;
      ref: string;
      // null when the node cannot say.
      resident: boolean | null;
      pinned: boolean;
      profiles: string[];
    };

type Entry = { id: string; object: 'model'; created: number; owned_by: string; penfield: Penfield };

export type ModelList = { object: 'list'; data: Entry[] };

const entry = (id: string, owned_by: string, penfield: Penfield): Entry => ({
  id,
  object: 'model',
  created: 0,
  owned_by,
  penfield,
});

// Over the caller's max_privacy (D10), or outside its `models:` list (D38), is not listed.
const reachable = (model: CatalogueModel, privacy: Privacy, caller: Caller): boolean =>
  RANK[privacy] <= RANK[caller.max_privacy] &&
  (caller.models === undefined || caller.models.some((wanted) => names_model(wanted, model)));

const model_entries = (catalogue: Catalogue, caller: Caller): Entry[] => {
  const nodes = new Map(catalogue.nodes.map((node) => [node.name, node]));
  const visible = catalogue.models.flatMap((model) => {
    const node = nodes.get(model.node);
    return node?.enabled === true && reachable(model, node.privacy, caller) ? [{ model, decision: node.kind === 'claude_decision' }] : [];
  });
  const tags = new Map<string, number>();
  for (const { model, decision } of visible) if (!decision) tags.set(model.id, (tags.get(model.id) ?? 0) + 1);
  return visible.map(({ model, decision }) =>
    entry(decision || (tags.get(model.id) ?? 0) > 1 ? model.ref : model.id, model.node, {
      kind: 'model',
      node: model.node,
      ref: model.ref,
      resident: model.residency === 'unknown' ? null : model.residency === 'resident',
      pinned: model.pinned,
      profiles: model.profiles,
    }),
  );
};

export const models_list = (catalogue: Catalogue, config: Config, caller: Caller): ModelList => {
  const aliases = Object.entries(config.aliases).toSorted(([a], [b]) => Number(b === 'auto') - Number(a === 'auto'));
  return {
    object: 'list',
    data: [
      ...aliases.map(([id, alias]) => entry(id, 'penfield', { kind: 'alias', ...alias })),
      ...Object.keys(config.profiles).map((id) => entry(id, 'penfield', { kind: 'profile' })),
      ...model_entries(catalogue, caller),
    ],
  };
};
