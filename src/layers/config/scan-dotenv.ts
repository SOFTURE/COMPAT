import type { KeyDeclaration } from "./classify.js";
import { stripComments } from "./comments.js";

export type ScanDotenvOptions = {
  /** When true, a non-empty value is the key's default; otherwise values are placeholders. */
  valuesAreDefaults: boolean;
};

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/;

/** Reads `KEY=value` lines of a `.env`-style example file. */
export function scanDotenv(text: string, { valuesAreDefaults }: ScanDotenvOptions): KeyDeclaration[] {
  const declarations: KeyDeclaration[] = [];
  // Split on LF and drop a trailing CR, so CRLF files read the same and line numbers still count LFs.
  const lines = stripComments(text, "hash").split("\n");
  lines.forEach((line, index) => {
    const match = ASSIGNMENT.exec(line.endsWith("\r") ? line.slice(0, -1) : line);
    if (match === null) return;
    const value = unquote((match[2] as string).trim());
    declarations.push({
      key: match[1] as string,
      line: index + 1,
      default: valuesAreDefaults && value !== "" ? value : null,
    });
  });
  return declarations;
}

function unquote(value: string): string {
  const first = value[0];
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  return value;
}
