// What discovery reads from a node, as plain data (D24). Discovery never throws: a
// node it cannot read is `down` with the reason, so one dead node cannot stop a
// probe tick or a boot (D41).

// `resident`: loaded in memory now. `cold`: on disk, so placing it is a cold load.
// `unknown`: the node cannot say (an OpenAI-compatible `/v1/models` lists models,
// not residency).
export type Residency = 'resident' | 'cold' | 'unknown';

export type Model = {
  // The node's own id for it: an Ollama tag, or an OpenAI model id.
  id: string;
  node: string;
  residency: Residency;
  // On disk, when the node says.
  size_bytes: number | null;
  // The context the loaded instance runs with, when it is resident and the node
  // says; what Q1 (ollama-context-window) is read against.
  context_length: number | null;
};

export type Discovery =
  | { node: string; state: 'up'; models: Model[] }
  | { node: string; state: 'down'; models: []; reason: string };

// Where discovery reads a node. For an Ollama node `url` is the server's root; for
// an OpenAI-compatible one it is the OpenAI base, `/v1` included, as the file
// writes it (`https://openrouter.ai/api/v1`). The caller resolves `api_key` from
// the node's `api_key_env`, so discovery reads no environment.
export type DiscoverTarget = { name: string; url: string; timeout_ms: number; api_key?: string };
