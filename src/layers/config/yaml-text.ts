/** A YAML text with its comments blanked. */
export type MaskedYaml = {
  /** The input with every comment replaced by spaces; offsets and line breaks are unchanged. */
  text: string;
  /** 0-based indexes of lines that start inside a block scalar or a multi-line quoted scalar. */
  scalarLines: ReadonlySet<number>;
};

type LexState = {
  quote: '"' | "'" | null;
  /** Indent of the node that owns the open block scalar; its content is indented deeper. */
  blockOwnerIndent: number | null;
  flowDepth: number;
};

/**
 * Blanks YAML comments, keeping the rules a line-based comment stripper gets wrong: a quote opens
 * only at the start of a token (`it's` in a plain scalar is text), quoted scalars span lines, and
 * block scalar (`|`, `>`) content is text, so a ` #` there is not a comment. Explicit indentation
 * indicators and tab indentation are not modelled.
 */
export function maskYamlComments(text: string): MaskedYaml {
  const lines = text.split("\n");
  const scalarLines = new Set<number>();
  const state: LexState = { quote: null, blockOwnerIndent: null, flowDepth: 0 };
  const masked = lines.map((line, index) => {
    if (state.blockOwnerIndent !== null) {
      if (isBlank(line) || getIndent(line) > state.blockOwnerIndent) {
        scalarLines.add(index);
        return line;
      }
      state.blockOwnerIndent = null;
    }
    if (state.quote !== null) scalarLines.add(index);
    return maskLine(line, state);
  });
  return { text: masked.join("\n"), scalarLines };
}

export function getIndent(line: string): number {
  return /^ */.exec(line)?.[0].length ?? 0;
}

export function isBlank(line: string): boolean {
  return line.trim() === "";
}

function isSpace(char: string | undefined): boolean {
  return char === undefined || char === " " || char === "\t" || char === "\r";
}

/** Lexes one line, updating `state` for the next one, and returns it with its comment blanked. */
function maskLine(line: string, state: LexState): string {
  let isTokenStart = state.quote === null;
  let ownerIndent = getIndent(line);
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string;
    const next = line[index + 1];
    if (state.quote === '"') {
      if (char === "\\") index += 1;
      else if (char === '"') state.quote = null;
      continue;
    }
    if (state.quote === "'") {
      if (char === "'" && next === "'") index += 1;
      else if (char === "'") state.quote = null;
      continue;
    }
    if (char === "#" && (index === 0 || isSpace(line[index - 1]))) return blankFrom(line, index);
    if (isSpace(char)) continue;
    if (!isTokenStart) {
      if (char === ":" && (isSpace(next) || (state.flowDepth > 0 && /[,[\]{}]/.test(next ?? "")))) {
        isTokenStart = true;
      } else if (state.flowDepth > 0 && char === ",") {
        isTokenStart = true;
      } else if (state.flowDepth > 0 && (char === "]" || char === "}")) {
        state.flowDepth -= 1;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      if (state.flowDepth === 0) ownerIndent = index;
      state.quote = char;
      isTokenStart = false;
    } else if ((char === "-" || char === "?") && isSpace(next)) {
      if (state.flowDepth === 0) ownerIndent = index;
    } else if ((char === "|" || char === ">") && state.flowDepth === 0) {
      state.blockOwnerIndent = ownerIndent;
      return blankHeaderComment(line, index + 1);
    } else if (char === "[" || char === "{") {
      state.flowDepth += 1;
    } else if (char === "]" || char === "}") {
      state.flowDepth = Math.max(0, state.flowDepth - 1);
      isTokenStart = false;
    } else if (char === "," && state.flowDepth > 0) {
      // An empty flow entry; the next token starts after it.
    } else if (char === ":" && isSpace(next)) {
      // An empty key; the value starts after it.
    } else if (char === "&" || char === "!") {
      while (index + 1 < line.length && !isSpace(line[index + 1])) index += 1;
    } else {
      if (state.flowDepth === 0) ownerIndent = index;
      isTokenStart = false;
    }
  }
  return line;
}

/** Blanks the comment after a block scalar header (`| # note`), if any. */
function blankHeaderComment(line: string, from: number): string {
  for (let index = from; index < line.length; index += 1) {
    if (line[index] === "#" && isSpace(line[index - 1])) return blankFrom(line, index);
  }
  return line;
}

function blankFrom(line: string, start: number): string {
  return line.slice(0, start) + line.slice(start).replace(/[^\r]/g, " ");
}
