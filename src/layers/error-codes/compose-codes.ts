import { err, ok, type Result } from "../../result.js";
import type { CodeDeclaration, CodeSet } from "./classify.js";
import { type ComposedCodeSource, getTemplateParts } from "./config.js";

/** More codes than this at one ref means the part patterns are too broad. */
export const MAX_COMPOSED_CODES = 1000;

/**
 * Builds the codes of a composed source at one ref from the codes its part sources captured there: one code
 * per combination of part values. Evidence points at the last part, in template order, that supplied a value.
 */
export function composeCodes(
  source: ComposedCodeSource,
  found: ReadonlyMap<string, CodeSet>,
): Result<Map<string, CodeDeclaration>> {
  const placeholders = getTemplateParts(source.template);
  const order = [...new Set(placeholders)];
  const values = order.map((part) => [...(found.get(source.parts[part] as string) ?? new Map())]);
  const combinations = values.reduce((count, partValues) => count * partValues.length, 1);
  if (combinations > MAX_COMPOSED_CODES) {
    return err(`gives ${combinations} codes, more than ${MAX_COMPOSED_CODES}; narrow the part patterns`);
  }
  const codes = new Map<string, CodeDeclaration>();
  const last = order.indexOf(placeholders[placeholders.length - 1] as string);
  const walk = (depth: number, picked: [string, CodeDeclaration][]): void => {
    if (depth === order.length) {
      const code = source.template.replace(
        /\{([A-Za-z0-9_-]+)\}/g,
        (_, part: string) => picked[order.indexOf(part)]?.[0] ?? "",
      );
      const evidence = (picked[last] as [string, CodeDeclaration])[1].evidence;
      if (!codes.has(code)) codes.set(code, { source: source.name, evidence });
      return;
    }
    for (const value of values[depth] ?? []) walk(depth + 1, [...picked, value]);
  };
  walk(0, []);
  return ok(codes);
}
