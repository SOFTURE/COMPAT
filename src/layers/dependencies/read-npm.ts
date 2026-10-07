import { err, ok, type Result } from "../../result.js";
import type { NpmSection } from "./config.js";
import { type Declaration, getLineAt } from "./declaration.js";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The line of `"name":` inside the section, or of the section itself when the key is not found as written. */
function findLine(text: string, section: string, name: string): number {
  const start = new RegExp(`"${escapeRegExp(section)}"\\s*:\\s*\\{`).exec(text);
  if (start === null) return 1;
  const key = new RegExp(`"${escapeRegExp(JSON.stringify(name).slice(1, -1))}"\\s*:`, "g");
  key.lastIndex = start.index;
  const match = key.exec(text);
  return getLineAt(text, match?.index ?? start.index);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads the dependencies of the given sections of a `package.json`. */
export function readNpm(text: string, path: string, sections: NpmSection[]): Result<Declaration[]> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    return err(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(manifest)) return err(`${path} is not a JSON object`);
  const declarations: Declaration[] = [];
  for (const section of sections) {
    const entries = manifest[section];
    if (entries === undefined) continue;
    if (!isRecord(entries)) return err(`${path}: "${section}" is not an object`);
    for (const [name, version] of Object.entries(entries)) {
      if (typeof version !== "string") return err(`${path}: "${section}.${name}" is not a string`);
      declarations.push({ ecosystem: "npm", name, version, path, line: findLine(text, section, name) });
    }
  }
  return ok(declarations);
}
