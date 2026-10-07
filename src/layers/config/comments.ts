export const COMMENT_STYLES = ["none", "hash", "slash"] as const;

export type CommentStyle = (typeof COMMENT_STYLES)[number];

/**
 * Replaces comments with spaces, keeping every newline, so offsets and line numbers of the
 * result match the input. `hash`: `#` at the start of a line or after whitespace. `slash`: `//`
 * to the end of the line and `/* ... *\/`. Markers inside `"` or `'` strings are kept. A backslash
 * escapes inside `"` strings, and inside `'` only for `slash` (YAML single quotes have no escapes).
 * The string state resets at each line end, so an unbalanced apostrophe affects one line only.
 */
export function stripComments(text: string, style: CommentStyle): string {
  if (style === "none") return text;
  const chars = text.split("");
  let quote: string | null = null;
  let isInBlockComment = false;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] as string;
    if (char === "\n") {
      quote = null;
      continue;
    }
    if (isInBlockComment) {
      if (char === "*" && chars[index + 1] === "/") {
        chars[index] = " ";
        chars[index + 1] = " ";
        index += 1;
        isInBlockComment = false;
        continue;
      }
      if (char !== "\r") chars[index] = " ";
      continue;
    }
    if (quote !== null) {
      // YAML single quotes have no backslash escapes; an escape never swallows a newline.
      const isEscape = char === "\\" && (quote === '"' || style === "slash") && chars[index + 1] !== "\n";
      if (isEscape) index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    const isLineComment =
      style === "hash"
        ? char === "#" && (index === 0 || /\s/.test(chars[index - 1] as string))
        : char === "/" && chars[index + 1] === "/";
    if (isLineComment) {
      index = blankToLineEnd(chars, index) - 1;
      continue;
    }
    if (style === "slash" && char === "/" && chars[index + 1] === "*") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 1;
      isInBlockComment = true;
    }
  }
  return chars.join("");
}

/** Blanks `chars` from `start` up to the next newline and returns the index of that newline (or the end). */
function blankToLineEnd(chars: string[], start: number): number {
  let index = start;
  while (index < chars.length && chars[index] !== "\n") {
    if (chars[index] !== "\r") chars[index] = " ";
    index += 1;
  }
  return index;
}

/** Returns a function mapping a character offset of `text` to its 1-based line number. */
export function createLineLocator(text: string): (offset: number) => number {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lineStarts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((lineStarts[middle] as number) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}
