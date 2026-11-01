import type { Catalogue, CatalogueModel } from '../catalogue/index.js';

// The JSON the status page reads. GET /catalogue (spec §5.4): every node with its
// state and breaker, every model with its residency, pin, breaker, slots and the
// slots its leases hold now, and the candidate warnings. Unfiltered: it is the
// operator's view, behind a caller token like every endpoint but /healthz (C5).

// Active leases per model ref, from the lease table.
export type InUse = Readonly<Record<string, number>>;

type CatalogueBody = Omit<Catalogue, 'models'> & { models: (CatalogueModel & { slots_in_use: number })[] };

export const catalogue_body = (catalogue: Catalogue, in_use: InUse): CatalogueBody => ({
  nodes: catalogue.nodes,
  models: catalogue.models.map((model) => ({ ...model, slots_in_use: in_use[model.ref] ?? 0 })),
  warnings: catalogue.warnings,
});
