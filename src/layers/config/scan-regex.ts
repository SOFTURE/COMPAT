import type { KeyDeclaration } from "./classify.js";
import { type CommentStyle, createLineLocator, stripComments } from "./comments.js";
import { DEFAULT_KEY_TEMPLATE, getTemplatePlaceholders, renderKeyTemplate } from "./config.js";

export type ScanRegexOptions = {
  /** A global pattern (with `d` for the key's line) with the named groups the key template uses and an optional `default`. */
  regex: RegExp;
  comments: CommentStyle;
  /** How a match becomes a key, e.g. `{section}__{member}`; defaults to the group `key`. */
  key?: string;
  /** A global pattern whose nearest match before a key lends its named groups to the key template. */
  enclosing?: RegExp | null;
};

type EnclosingMatch = { index: number; groups: Record<string, string | undefined> };

/**
 * Collects every match of a configured pattern; a match whose `default` group did not take part
 * has no default. A placeholder no group fills becomes empty, and a match whose key is then empty
 * is skipped.
 */
export function scanRegex(
  text: string,
  { regex, comments, key = DEFAULT_KEY_TEMPLATE, enclosing = null }: ScanRegexOptions,
): KeyDeclaration[] {
  const stripped = stripComments(text, comments);
  const getLine = createLineLocator(stripped);
  const contexts = enclosing === null ? [] : findEnclosingMatches(stripped, enclosing);
  const placeholders = getTemplatePlaceholders(key);
  const declarations: KeyDeclaration[] = [];
  for (const match of stripped.matchAll(regex)) {
    const outer = findLastBefore(contexts, match.index);
    const name = renderKeyTemplate(key, (group) => match.groups?.[group] ?? outer?.groups[group]).trim();
    if (name === "") continue;
    const value = match.groups?.default;
    // The line is the one of the first placeholder this match fills itself, else the start of the match.
    const filled = placeholders.find((group) => match.indices?.groups?.[group] !== undefined);
    const keyOffset =
      (filled === undefined ? undefined : match.indices?.groups?.[filled]?.[0]) ?? match.index;
    declarations.push({ key: name, line: getLine(keyOffset), default: value === undefined ? null : value });
  }
  return declarations;
}

function findEnclosingMatches(text: string, enclosing: RegExp): EnclosingMatch[] {
  return [...text.matchAll(enclosing)].map((match) => ({ index: match.index, groups: match.groups ?? {} }));
}

/** The last match that starts before `offset`; `matches` are in text order. */
function findLastBefore(matches: EnclosingMatch[], offset: number): EnclosingMatch | undefined {
  let found: EnclosingMatch | undefined;
  for (const match of matches) {
    if (match.index >= offset) break;
    found = match;
  }
  return found;
}
