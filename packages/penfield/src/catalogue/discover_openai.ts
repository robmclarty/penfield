import { z } from 'zod';

import { down, get_json } from './discover_http.js';
import type { DiscoverTarget, Discovery } from './types.js';

// An OpenAI-compatible node: `GET <base>/models` lists its model ids (D24). The
// list says nothing about what is loaded, so every model's residency is unknown.

const models_body = z.object({ data: z.array(z.object({ id: z.string().min(1) })) });

export const discover_openai = async (target: DiscoverTarget): Promise<Discovery> => {
  const listed = await get_json(target, '/models', models_body);
  if (!listed.ok) return down(target.name, listed.reason);
  return {
    node: target.name,
    state: 'up',
    models: listed.body.data.map(({ id }) => ({
      id,
      node: target.name,
      residency: 'unknown',
      size_bytes: null,
      context_length: null,
    })),
  };
};
