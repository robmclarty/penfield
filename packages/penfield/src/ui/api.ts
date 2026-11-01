import { z } from 'zod';

import type { Catalogue, CatalogueModel } from '../catalogue/index.js';
import type { DecisionQuery, DecisionRow } from '../log/index.js';

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

// GET /decisions?caller=&since=&limit= (spec §5.4): the decision log, newest first,
// the last 100 unless `limit` asks for up to 1000. `since` is any time `Date`
// reads, compared as the ISO time the log writes. Unfiltered by who asks, like
// /catalogue, and without the prompt text a `keep_prompts` caller leaves (D22).

const decisions_query = z.object({
  caller: z.string().min(1).optional(),
  since: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), 'since is a date or a time')
    .transform((value) => new Date(value).toISOString())
    .optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

type QueryResult = { ok: true; query: DecisionQuery } | { ok: false; reason: string };

export const parse_decisions_query = (query: unknown): QueryResult => {
  const result = decisions_query.safeParse(query);
  if (result.success) return { ok: true, query: result.data };
  return { ok: false, reason: result.error.issues.map(({ path, message }) => `${path.join('.')}: ${message}`).join('; ') };
};

type DecisionsBody = { decisions: DecisionRow[] };

export const decisions_body = (rows: readonly DecisionRow[]): DecisionsBody => ({ decisions: [...rows] });
