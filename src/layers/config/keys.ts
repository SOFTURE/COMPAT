export const KEY_MATCHING_MODES = ["normalized", "exact"] as const;

export type KeyMatching = (typeof KEY_MATCHING_MODES)[number];

/** Maps a key as written in a source to the identity it is compared by. */
export type KeyIdentity = (key: string) => string;

/**
 * Splits a key into lowercase words: on every character that is not a letter or digit (`:`, `__`,
 * `.`, `_`, `-`) and on case changes, so `Shop:BaseUrl`, `Shop__BaseUrl`, `SHOP_BASE_URL` and
 * `shop.base_url` all give `shop`, `base`, `url`. An acronym stays one word (`APIKey` gives `api`, `key`).
 */
export function splitKeyWords(key: string): string[] {
  return key
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase());
}

/**
 * The canonical form of a key: its words in upper snake case, the spelling environment variables
 * and secret stores use (`Shop:BaseUrl` gives `SHOP_BASE_URL`). A key without letters or digits
 * stays as written.
 */
export function normalizeKey(key: string): string {
  const words = splitKeyWords(key);
  return words.length === 0 ? key : words.join("_").toUpperCase();
}

export function getKeyIdentity(matching: KeyMatching): KeyIdentity {
  return matching === "normalized" ? normalizeKey : (key) => key;
}
