/** One code a pattern captured, with the 1-based line of the capture. */
export type CodeOccurrence = { code: string; line: number };

/**
 * Every capture of the named group `code` in `text`, in text order; empty captures are skipped.
 * `regex` must carry the `g` and `d` flags.
 */
export function readCodes(text: string, regex: RegExp): CodeOccurrence[] {
  const lineStarts = [0];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    lineStarts.push(index + 1);
  }
  const getLine = (offset: number) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((lineStarts[middle] as number) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  const occurrences: CodeOccurrence[] = [];
  // A fresh copy, so a `lastIndex` left by an earlier caller never skips text.
  for (const match of text.matchAll(new RegExp(regex.source, regex.flags))) {
    const code = match.groups?.code?.trim();
    if (code === undefined || code === "") continue;
    const offset = match.indices?.groups?.code?.[0] ?? match.index;
    occurrences.push({ code, line: getLine(offset) });
  }
  return occurrences;
}
