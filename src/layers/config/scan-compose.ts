import type { KeyDeclaration } from "./classify.js";
import { createLineLocator } from "./comments.js";
import { findPassThroughKeys } from "./compose-environment.js";
import { maskYamlComments } from "./yaml-text.js";

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;

/**
 * Finds the variables a Compose file interpolates. `$VAR`, `${VAR}` and `${VAR:?err}` give no
 * default; `${VAR:-d}` gives `d`; `${VAR:+alt}` gives an empty default, since the value is
 * only used when set. References nested inside another reference's text get an empty default:
 * they are read only when the outer variable is unset. Pass-through `environment` entries
 * (`- KEY`, `KEY:`) give no default: the host supplies the value.
 */
export function scanCompose(text: string): KeyDeclaration[] {
  const masked = maskYamlComments(text);
  const getLine = createLineLocator(masked.text);
  const declarations: KeyDeclaration[] = [];
  scanRange(masked.text, 0, masked.text.length, false, (key, offset, value) =>
    declarations.push({ key, line: getLine(offset), default: value }),
  );
  declarations.push(...findPassThroughKeys(masked));
  return declarations;
}

type Emit = (key: string, offset: number, value: string | null) => void;

function scanRange(text: string, start: number, end: number, isNested: boolean, emit: Emit): void {
  let index = start;
  while (index < end) {
    if (text[index] !== "$") {
      index += 1;
      continue;
    }
    const next = text[index + 1];
    if (next === "$") {
      index += 2;
      continue;
    }
    if (next === "{") {
      index = scanBraced(text, index, end, isNested, emit);
      continue;
    }
    if (next !== undefined && NAME_START.test(next)) {
      let nameEnd = index + 2;
      while (nameEnd < end && NAME_CHAR.test(text[nameEnd] as string)) nameEnd += 1;
      emit(text.slice(index + 1, nameEnd), index, isNested ? "" : null);
      index = nameEnd;
      continue;
    }
    index += 1;
  }
}

/** Scans `${...}` starting at `start` (the `$`) and returns the offset to continue from. */
function scanBraced(text: string, start: number, end: number, isNested: boolean, emit: Emit): number {
  const close = findClosingBrace(text, start + 2, end);
  if (close === -1) return start + 2;
  const body = text.slice(start + 2, close);
  const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body)?.[0];
  if (name === undefined) return close + 1;
  const operator = /^(:?[-?+])?/.exec(body.slice(name.length))?.[0] ?? "";
  const rest = body.slice(name.length + operator.length);
  if (operator === "" && rest !== "") return close + 1;
  let value: string | null;
  if (isNested) value = "";
  else if (operator.endsWith("-")) value = rest;
  else if (operator.endsWith("+")) value = "";
  else value = null;
  emit(name, start, value);
  const restStart = start + 2 + name.length + operator.length;
  scanRange(text, restStart, close, true, emit);
  return close + 1;
}

/** The offset of the `}` closing a `${` whose body starts at `from`, honouring nested `${...}`. */
function findClosingBrace(text: string, from: number, end: number): number {
  let depth = 1;
  for (let index = from; index < end; index += 1) {
    const char = text[index];
    if (char === "\n") return -1;
    if (char === "$" && text[index + 1] === "$") {
      index += 1;
    } else if (char === "$" && text[index + 1] === "{") {
      depth += 1;
      index += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}
