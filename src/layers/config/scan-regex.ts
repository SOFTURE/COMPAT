import type { KeyDeclaration } from "./classify.js";
import { type CommentStyle, createLineLocator, stripComments } from "./comments.js";

export type ScanRegexOptions = {
  /** A global pattern (with `d` for the key's line) with a named group `key` and an optional named group `default`. */
  regex: RegExp;
  comments: CommentStyle;
};

/** Collects every match of a configured pattern; a match whose `default` group did not take part has no default. */
export function scanRegex(text: string, { regex, comments }: ScanRegexOptions): KeyDeclaration[] {
  const stripped = stripComments(text, comments);
  const getLine = createLineLocator(stripped);
  const declarations: KeyDeclaration[] = [];
  for (const match of stripped.matchAll(regex)) {
    const key = match.groups?.key?.trim();
    if (key === undefined || key === "") continue;
    const value = match.groups?.default;
    const keyOffset = match.indices?.groups?.key?.[0] ?? match.index;
    declarations.push({ key, line: getLine(keyOffset), default: value === undefined ? null : value });
  }
  return declarations;
}
