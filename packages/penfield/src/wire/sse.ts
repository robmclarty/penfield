// OpenAI's server-sent events, as the proxy sees them pass (C4): it reads the
// node's own prompt count from the stream without holding the stream, and writes
// the one event of its own that a stream can carry, an error once bytes have gone.

export const is_event_stream = (content_type: string | null): boolean =>
  content_type?.toLowerCase().startsWith('text/event-stream') ?? false;

export type UsageReader = {
  push: (chunk: Uint8Array) => void;
  // The last `usage.prompt_tokens` the stream carried, the event still open included.
  end: () => number | null;
};

// An event longer than this is no usage event, and is not kept while it grows.
const MAX_EVENT = 64 * 1024;

const EVENT_END = /\r?\n\r?\n/;

const prompt_tokens_of = (data: string): number | null => {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== 'object' || parsed === null || !('usage' in parsed)) return null;
    const { usage } = parsed;
    if (typeof usage !== 'object' || usage === null || !('prompt_tokens' in usage)) return null;
    return typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null;
  } catch {
    return null;
  }
};

// Only the event in progress is held. An OpenAI stream sends `usage` only when the
// client asked with `stream_options.include_usage`, last before `[DONE]`; one
// without it ends with no count, which C1 keeps penfield from asking for.
export const create_usage_reader = (): UsageReader => {
  const decoder = new TextDecoder();
  let open = '';
  let prompt_tokens: number | null = null;
  const read_event = (event: string): void => {
    if (!event.includes('"prompt_tokens"')) return;
    for (const line of event.split(/\r?\n/)) {
      const tokens = line.startsWith('data:') ? prompt_tokens_of(line.slice('data:'.length)) : null;
      if (tokens !== null) prompt_tokens = tokens;
    }
  };
  return {
    push: (chunk) => {
      const events = (open + decoder.decode(chunk, { stream: true })).split(EVENT_END);
      open = events.pop() ?? '';
      if (open.length > MAX_EVENT) open = '';
      for (const event of events) read_event(event);
    },
    end: () => {
      read_event(open + decoder.decode());
      open = '';
      return prompt_tokens;
    },
  };
};

// One event, as `data: <json>` and the blank line that ends it.
export const sse_event = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`;
