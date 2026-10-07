/**
 * Converts a repository-relative glob into a regular expression.
 * Supports `**` (any number of path segments), `*` (within one segment), `?` and `{a,b}`.
 */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  let index = 0;
  let braceDepth = 0;
  while (index < glob.length) {
    const char = glob[index] as string;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        const isWholeSegment = (index === 0 || glob[index - 1] === "/") && glob[index + 2] === "/";
        if (isWholeSegment) {
          source += "(?:.*/)?";
          index += 3;
          continue;
        }
        source += ".*";
        index += 2;
        continue;
      }
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{") {
      braceDepth += 1;
      source += "(?:";
    } else if (char === "}" && braceDepth > 0) {
      braceDepth -= 1;
      source += ")";
    } else if (char === "," && braceDepth > 0) {
      source += "|";
    } else {
      source += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }
    index += 1;
  }
  return new RegExp(`^${source}$`);
}

export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path);
}
