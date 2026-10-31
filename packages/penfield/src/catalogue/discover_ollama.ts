import { z } from 'zod';

import { down, get_json } from './discover_http.js';
import type { DiscoverTarget, Discovery, Model } from './types.js';

// An Ollama node: `GET /api/tags` lists what it has on disk, `GET /api/ps` what is
// loaded now (D24). Ollama sends more fields than these; the schemas let them pass.

const tags_body = z.object({
  models: z.array(z.object({ name: z.string().min(1), size: z.number().optional() })),
});

const ps_body = z.object({
  models: z.array(z.object({ name: z.string().min(1), context_length: z.number().optional() })),
});

type Loaded = z.output<typeof ps_body>['models'][number];

const model = (node: string, id: string, size: number | undefined, loaded: Loaded | undefined): Model => ({
  id,
  node,
  residency: loaded === undefined ? 'cold' : 'resident',
  size_bytes: size ?? null,
  context_length: loaded?.context_length ?? null,
});

export const discover_ollama = async (target: DiscoverTarget): Promise<Discovery> => {
  const [tags, ps] = await Promise.all([
    get_json(target, '/api/tags', tags_body),
    get_json(target, '/api/ps', ps_body),
  ]);
  if (!tags.ok) return down(target.name, tags.reason);
  if (!ps.ok) return down(target.name, ps.reason);
  const loaded = new Map(ps.body.models.map((entry) => [entry.name, entry]));
  const on_disk = new Set(tags.body.models.map((entry) => entry.name));
  // A model can stay loaded after its tag is removed; it is still in memory and served.
  const untagged = ps.body.models.filter((entry) => !on_disk.has(entry.name));
  return {
    node: target.name,
    state: 'up',
    models: [
      ...tags.body.models.map((entry) => model(target.name, entry.name, entry.size, loaded.get(entry.name))),
      ...untagged.map((entry) => model(target.name, entry.name, undefined, entry)),
    ],
  };
};
