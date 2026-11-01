import type { Effort, Privacy } from '../config/index.js';
import type { Attachments, Endpoint, Hints, InputResult, Prefer, RouteCaller, RouteInput } from './types.js';

// Spec §5.2's `RouteInput` from an OpenAI chat or embeddings body (Anthropic is
// Stage B). The wire parses the body once and hands it here with the headers, never
// the request, so the body is read once (C4). Strings are measured where they lie
// and copied only up to the caps, so a 2 MB body costs no 2 MB of text.

// "4 k" and "1 k" as the house counts a context window: 64 k is 65536.
const TEXT_CAP = 4096;
const SYSTEM_CAP = 1024;

type Headers = Readonly<Record<string, string | string[] | undefined>>;

type Json = Record<string, unknown>;

type Refused = { ok: false; reason: string };

type Read<T> = { ok: true; value: T } | Refused;

type Fields = Pick<RouteInput, 'text' | 'system_text' | 'history_turns' | 'tokens_estimate' | 'tools' | 'attachments'>;

export type InputContext = {
  request_id: string;
  caller: RouteCaller;
  endpoint: Extract<Endpoint, 'chat' | 'embeddings'>;
};

const refused = (reason: string): Refused => ({ ok: false, reason });

const is_record = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const estimate = (chars: number): number => Math.ceil(chars / 4);

const total_length = (pieces: readonly string[]): number => pieces.reduce((sum, piece) => sum + piece.length, 0);

// The non-empty pieces joined by newlines, cut at `cap` chars; no piece is copied past it.
const capped = (pieces: readonly string[], cap: number): string => {
  let out = '';
  for (const piece of pieces) {
    if (piece === '') continue;
    const room = out === '' ? cap : cap - out.length - 1;
    if (room <= 0) break;
    out = out === '' ? piece.slice(0, room) : `${out}\n${piece.slice(0, room)}`;
  }
  return out;
};

// ── hints ─────────────────────────────────────────────────────────────────────

// Each set is exhaustive over its type, so a value the schema adds cannot be missed.
const PRIVACY: Record<Privacy, true> = { local: true, lan: true, cloud: true };
const PREFER: Record<Prefer, true> = { speed: true, quality: true };
const EFFORT: Record<Effort, true> = { low: true, medium: true, high: true, xhigh: true, max: true };

const HEADER: Record<keyof Hints, string> = {
  profile: 'x-penfield-profile',
  max_privacy: 'x-penfield-max-privacy',
  prefer: 'x-penfield-prefer',
  effort: 'x-penfield-effort',
};

type Found = { from: string; value: unknown } | undefined;

const header = (headers: Headers, name: string): string | undefined => {
  const raw = headers[name];
  const value = (Array.isArray(raw) ? raw.join(', ') : (raw ?? '')).trim();
  return value === '' ? undefined : value;
};

// A header wins over the body's `metadata.penfield`: the header is set by whatever
// sends the request to penfield, which may be a layer above the tool that wrote the body.
const find = (key: keyof Hints, headers: Headers, metadata: Json): Found => {
  const from_header = header(headers, HEADER[key]);
  if (from_header !== undefined) return { from: HEADER[key], value: from_header };
  const value = metadata[key];
  return value === undefined ? undefined : { from: `metadata.penfield.${key}`, value };
};

// An unreadable hint is refused rather than dropped, since dropping a stricter
// `max_privacy` would route the request above what its sender asked for (C11).
const name_hint = (found: Found): Read<string | undefined> => {
  if (found === undefined) return { ok: true, value: undefined };
  return typeof found.value === 'string' && found.value !== ''
    ? { ok: true, value: found.value }
    : refused(`${found.from} is not a profile name`);
};

const is_one_of = <T extends string>(allowed: Record<T, true>, value: unknown): value is T =>
  typeof value === 'string' && Object.hasOwn(allowed, value);

const choice_hint = <T extends string>(found: Found, allowed: Record<T, true>): Read<T | undefined> => {
  if (found === undefined) return { ok: true, value: undefined };
  const { from, value } = found;
  if (is_one_of(allowed, value)) return { ok: true, value };
  return refused(`${from} ${JSON.stringify(value)} is not one of ${Object.keys(allowed).join(', ')}`);
};

const penfield_metadata = (body: Json): Read<Json> => {
  const metadata = body['metadata'];
  const penfield = is_record(metadata) ? metadata['penfield'] : undefined;
  if (penfield === undefined) return { ok: true, value: {} };
  return is_record(penfield) ? { ok: true, value: penfield } : refused('metadata.penfield is not an object');
};

const read_hints = (headers: Headers, body: Json): Read<Hints> => {
  const metadata = penfield_metadata(body);
  if (!metadata.ok) return metadata;
  const at = (key: keyof Hints): Found => find(key, headers, metadata.value);
  const profile = name_hint(at('profile'));
  const max_privacy = choice_hint(at('max_privacy'), PRIVACY);
  const prefer = choice_hint(at('prefer'), PREFER);
  const effort = choice_hint(at('effort'), EFFORT);
  if (!profile.ok) return profile;
  if (!max_privacy.ok) return max_privacy;
  if (!prefer.ok) return prefer;
  if (!effort.ok) return effort;
  return {
    ok: true,
    value: {
      ...(profile.value === undefined ? {} : { profile: profile.value }),
      ...(max_privacy.value === undefined ? {} : { max_privacy: max_privacy.value }),
      ...(prefer.value === undefined ? {} : { prefer: prefer.value }),
      ...(effort.value === undefined ? {} : { effort: effort.value }),
    },
  };
};

// ── chat ──────────────────────────────────────────────────────────────────────

type Message = Json & { role: string };

const SYSTEM_ROLES = new Set(['system', 'developer']);

const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|sql|zig|exs?|hs|ml|scala|lua|vue|svelte)$/i;

// A message's text, by reference: its content string, or its content's text parts.
const content_texts = (content: unknown): string[] => {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => (is_record(part) && typeof part['text'] === 'string' ? [part['text']] : []));
};

// The arguments of the tool calls an assistant message made, which count toward the estimate.
const call_texts = (calls: unknown): string[] =>
  Array.isArray(calls)
    ? calls.flatMap((call) => {
        const fn = is_record(call) ? call['function'] : undefined;
        return is_record(fn) && typeof fn['arguments'] === 'string' ? [fn['arguments']] : [];
      })
    : [];

const RANK: Record<Attachments, number> = { none: 0, docs: 1, code: 2, images: 3 };

const part_attachment = (part: unknown): Attachments => {
  if (typeof part === 'string') return part.includes('```') ? 'code' : 'none';
  if (!is_record(part)) return 'none';
  const { type } = part;
  if (type === 'image_url' || type === 'input_image') return 'images';
  if (type === 'text') return part_attachment(part['text']);
  if (type !== 'file') return 'none';
  const file = part['file'];
  const filename = is_record(file) ? file['filename'] : undefined;
  return typeof filename === 'string' && CODE_FILE.test(filename) ? 'code' : 'docs';
};

// What the user attached, across every user message: images outrank code, and code
// outranks docs, since each narrows the candidates more than the next.
const attachments_of = (messages: readonly Message[]): Attachments => {
  let found: Attachments = 'none';
  for (const { role, content } of messages) {
    if (role !== 'user') continue;
    for (const part of Array.isArray(content) ? content : [content]) {
      const kind = part_attachment(part);
      if (RANK[kind] > RANK[found]) found = kind;
    }
  }
  return found;
};

const is_message = (value: unknown): value is Message => is_record(value) && typeof value['role'] === 'string';

const read_messages = (body: Json): Read<Message[]> => {
  const messages: unknown = body['messages'];
  if (!Array.isArray(messages)) return refused('messages is not an array');
  const bad = messages.findIndex((message) => !is_message(message));
  return bad === -1 ? { ok: true, value: messages.filter(is_message) } : refused(`messages[${bad}] has no role`);
};

const listed = (value: unknown): boolean => Array.isArray(value) && value.length > 0;

const read_chat = (body: Json): Read<Fields> => {
  const messages = read_messages(body);
  if (!messages.ok) return messages;
  const all = messages.value;
  const system = all.filter(({ role }) => SYSTEM_ROLES.has(role));
  const conversation = all.filter(({ role }) => !SYSTEM_ROLES.has(role));
  const last_user = conversation.findLastIndex(({ role }) => role === 'user');
  const counted = all.flatMap((message) => [...content_texts(message['content']), ...call_texts(message['tool_calls'])]);
  return {
    ok: true,
    value: {
      text: last_user === -1 ? '' : capped(content_texts(conversation[last_user]?.['content']), TEXT_CAP),
      system_text: capped(
        system.flatMap((message) => content_texts(message['content'])),
        SYSTEM_CAP,
      ),
      history_turns: last_user === -1 ? conversation.length : last_user,
      tokens_estimate: estimate(total_length(counted)),
      // `functions` is the deprecated form of `tools`.
      tools: listed(body['tools']) || listed(body['functions']),
      attachments: attachments_of(all),
    },
  };
};

// ── embeddings ────────────────────────────────────────────────────────────────

// `input` is a string, strings, or token ids (one array, or one per input); a token
// id counts as a token as it stands.
const read_embeddings = (body: Json): Read<Fields> => {
  const input: unknown = body['input'];
  if (typeof input !== 'string' && !Array.isArray(input)) return refused('input is not a string or an array');
  const items: unknown[] = Array.isArray(input) ? input : [input];
  const strings = items.filter((item) => typeof item === 'string');
  const tokens = items.reduce<number>(
    (sum, item) => sum + (typeof item === 'number' ? 1 : Array.isArray(item) ? item.length : 0),
    0,
  );
  return {
    ok: true,
    value: {
      text: capped(strings, TEXT_CAP),
      system_text: '',
      history_turns: 0,
      tokens_estimate: estimate(total_length(strings)) + tokens,
      tools: false,
      attachments: 'none',
    },
  };
};

// ── the parse ─────────────────────────────────────────────────────────────────

export const parse_openai_input = (body: unknown, headers: Headers, context: InputContext): InputResult => {
  if (!is_record(body)) return refused('the body is not a JSON object');
  const { model } = body;
  if (typeof model !== 'string' || model === '') return refused('the body names no model');
  const hints = read_hints(headers, body);
  if (!hints.ok) return hints;
  const fields = context.endpoint === 'chat' ? read_chat(body) : read_embeddings(body);
  if (!fields.ok) return fields;
  const { request_id, caller, endpoint } = context;
  return {
    ok: true,
    input: { request_id, caller, format: 'openai', endpoint, model, ...fields.value, hints: hints.value },
  };
};
