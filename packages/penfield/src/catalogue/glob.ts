// The keys of `models:` are globs where `*` is the only wildcard and every other
// character is literal (D27), so a regex built from the key is all the matching
// needs. Keys are tried in file order and the first match wins (D24).

const literal = (text: string): string => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

export const glob_regex = (key: string): RegExp => new RegExp(`^${key.split('*').map(literal).join('.*')}$`);

export type Compiled<T> = { key: string; regex: RegExp; value: T };

export const compile_globs = <T>(entries: Record<string, T>): Compiled<T>[] =>
  Object.entries(entries).map(([key, value]) => ({ key, regex: glob_regex(key), value }));

// The first entry whose key matches any of `names`, in file order.
export const first_match = <T>(compiled: readonly Compiled<T>[], names: readonly string[]): Compiled<T> | undefined =>
  compiled.find(({ regex }) => names.some((name) => regex.test(name)));
