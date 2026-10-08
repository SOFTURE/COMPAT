import type { KeyDeclaration } from "./classify.js";

export const DEFAULT_PLACEHOLDER = "placeholder|set-via-env|changeme|^$";

/** A leaf of an `appsettings*.json` file: its .NET configuration path, line and value as text. */
export type SettingLeaf = { key: string; line: number; value: string | null };

/**
 * Reads the leaves of a .NET `appsettings*.json` file as configuration paths joined with `:`
 * (`Stripe:SecretKey`, arrays by index: `Stripe:Plans:0:ProductId`). Comments and trailing commas
 * are allowed, as .NET allows them. `null` reads as `value: null`. Returns `null` when the text is
 * not JSON, so the caller can name the file.
 */
export function readSettingLeaves(text: string): SettingLeaf[] | null {
  const reader = new JsonReader(text);
  const leaves: SettingLeaf[] = [];
  try {
    reader.skipBlank();
    reader.readValue([], leaves);
    reader.skipBlank();
    if (!reader.isAtEnd()) return null;
  } catch {
    return null;
  }
  return leaves;
}

/**
 * Turns setting leaves into key declarations: a value that matches `placeholder` gives no default
 * (the key needs a value from the environment), any other value is the key's default.
 */
export function toDeclarations(leaves: SettingLeaf[], placeholder: RegExp): KeyDeclaration[] {
  return leaves.map((leaf) => ({
    key: leaf.key,
    line: leaf.line,
    default: leaf.value === null || placeholder.test(leaf.value) ? null : leaf.value,
  }));
}

class JsonSyntaxError extends Error {}

/** A minimal JSON reader with `//` and `/* *\/` comments and trailing commas, tracking line numbers. */
class JsonReader {
  private index = 0;
  private line = 1;

  constructor(private readonly text: string) {}

  isAtEnd(): boolean {
    return this.index >= this.text.length;
  }

  skipBlank(): void {
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      const next = this.text[this.index + 1];
      if (char === "\n") {
        this.line += 1;
        this.index += 1;
      } else if (char === " " || char === "\t" || char === "\r" || char === "﻿") {
        this.index += 1;
      } else if (char === "/" && next === "/") {
        while (this.index < this.text.length && this.text[this.index] !== "\n") this.index += 1;
      } else if (char === "/" && next === "*") {
        const end = this.text.indexOf("*/", this.index + 2);
        if (end === -1) throw new JsonSyntaxError("unclosed comment");
        this.countLines(this.index, end + 2);
        this.index = end + 2;
      } else {
        return;
      }
    }
  }

  readValue(path: string[], leaves: SettingLeaf[]): void {
    const char = this.text[this.index];
    if (char === "{") this.readObject(path, leaves);
    else if (char === "[") this.readArray(path, leaves);
    else {
      const line = this.line;
      const value = char === '"' ? this.readString() : this.readLiteral();
      if (path.length > 0) leaves.push({ key: path.join(":"), line, value });
    }
  }

  private readObject(path: string[], leaves: SettingLeaf[]): void {
    this.index += 1;
    for (;;) {
      this.skipBlank();
      if (this.text[this.index] === "}") {
        this.index += 1;
        return;
      }
      if (this.text[this.index] !== '"') throw new JsonSyntaxError("expected a key");
      const name = this.readString();
      this.skipBlank();
      this.expect(":");
      this.skipBlank();
      this.readValue([...path, name], leaves);
      this.skipBlank();
      if (this.text[this.index] === ",") this.index += 1;
      else if (this.text[this.index] !== "}") throw new JsonSyntaxError("expected , or }");
    }
  }

  private readArray(path: string[], leaves: SettingLeaf[]): void {
    this.index += 1;
    for (let item = 0; ; item += 1) {
      this.skipBlank();
      if (this.text[this.index] === "]") {
        this.index += 1;
        return;
      }
      this.readValue([...path, String(item)], leaves);
      this.skipBlank();
      if (this.text[this.index] === ",") this.index += 1;
      else if (this.text[this.index] !== "]") throw new JsonSyntaxError("expected , or ]");
    }
  }

  private readString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      if (char === "\\") this.index += 2;
      else if (char === '"') break;
      else if (char === "\n") throw new JsonSyntaxError("unclosed string");
      else this.index += 1;
    }
    if (this.index >= this.text.length) throw new JsonSyntaxError("unclosed string");
    this.index += 1;
    return JSON.parse(this.text.slice(start, this.index)) as string;
  }

  /** A number, `true`, `false` or `null`; `null` gives `null`, the rest their text. */
  private readLiteral(): string | null {
    const match = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(this.text.slice(this.index));
    if (match === null) throw new JsonSyntaxError("expected a value");
    this.index += match[0].length;
    return match[0] === "null" ? null : match[0];
  }

  private expect(char: string): void {
    if (this.text[this.index] !== char) throw new JsonSyntaxError(`expected ${char}`);
    this.index += 1;
  }

  private countLines(from: number, to: number): void {
    for (let index = from; index < to; index += 1) if (this.text[index] === "\n") this.line += 1;
  }
}
