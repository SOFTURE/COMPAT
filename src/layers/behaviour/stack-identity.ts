import { COMMIT_PLACEHOLDER, REF_PLACEHOLDER } from "./config.js";

/** A full git object id: SHA-1 (40) or SHA-256 (64) hex digits. */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
/** A hex word long enough to be an abbreviated commit id (git's own minimum is 7). */
const HEX_WORD = /(?<![0-9a-z])[0-9a-f]{7,64}(?![0-9a-z])/gi;
const MAX_SHOWN_CHARS = 200;

/** Replaces `{commit}` and `{ref}` in an `expect` template with the stack side's values. */
export function expandIdentity(template: string, identity: { commit: string; ref: string }): string {
  return template.replaceAll(COMMIT_PLACEHOLDER, identity.commit).replaceAll(REF_PLACEHOLDER, identity.ref);
}

/**
 * Whether what the stack reported proves the expected identity. The trimmed output must contain the expected value;
 * when the expected value is a full commit id, a hex word of at least 7 characters in the output that is a prefix of
 * it matches too (an image labelled with a short SHA). Hex digits compare without case.
 */
export function matchesIdentity(observed: string, expected: string): boolean {
  const output = observed.trim();
  if (output.includes(expected)) return true;
  if (!FULL_SHA.test(expected)) return false;
  const sha = expected.toLowerCase();
  return [...output.matchAll(HEX_WORD)].some((match) => sha.startsWith(match[0].toLowerCase()));
}

/** The reported value as error messages show it: trimmed, on one line and cut to a readable length. */
export function describeObserved(observed: string): string {
  const text = observed.trim().replace(/\s+/g, " ");
  if (text === "") return "nothing";
  const shown = text.length > MAX_SHOWN_CHARS ? `${text.slice(0, MAX_SHOWN_CHARS)}...` : text;
  return `"${shown}"`;
}
