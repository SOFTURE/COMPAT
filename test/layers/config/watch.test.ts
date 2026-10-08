import { describe, expect, it } from "vitest";
import type { KeyIndex } from "../../../src/layers/config/classify.js";
import { applyWatch, createKeyMatcher } from "../../../src/layers/config/watch.js";
import type { Finding } from "../../../src/model/finding.js";

const finding = (subject: string, id: string, overrides: Partial<Finding> = {}): Finding => ({
  layer: "config",
  scope: "appsettings",
  id,
  subject,
  class: "safe",
  message: "new key with a default; the release runs without a value in production",
  evidence: [],
  ...overrides,
});

const index = (entries: Record<string, (string | null)[]>): KeyIndex =>
  new Map(
    Object.entries(entries).map(([key, defaults]) => [
      key,
      defaults.map((value, line) => ({ key, line: line + 1, default: value, source: "s", path: "a.json" })),
    ]),
  );

describe("createKeyMatcher", () => {
  it("matches normalized keys by a pattern in any spelling", () => {
    const matches = createKeyMatcher("Consumers:*", "normalized");
    expect(matches("CONSUMERS_PREFETCH_COUNT")).toBe(true);
    expect(matches("CONSUMERSX")).toBe(false);
    expect(createKeyMatcher("consumers__retry__count", "normalized")("CONSUMERS_RETRY_COUNT")).toBe(true);
    expect(createKeyMatcher("*_COUN?", "normalized")("CONSUMERS_RETRY_COUNT")).toBe(true);
  });

  it("matches keys as written in exact mode", () => {
    expect(createKeyMatcher("Consumers:*", "exact")("Consumers:PrefetchCount")).toBe(true);
    expect(createKeyMatcher("Consumers:*", "exact")("CONSUMERS_PREFETCH_COUNT")).toBe(false);
  });
});

describe("applyWatch", () => {
  const base = index({ CONSUMERS_RETRY_IS_EXPONENTIAL: ["true"], SHOP_URL: ["https://a"] });
  const revision = index({ CONSUMERS_PREFETCH_COUNT: ["1"], CONSUMERS_RETRY_IS_EXPONENTIAL: ["false"] });
  const watch = [{ key: "Consumers:*", class: "needs-action" as const, reason: "consumer throughput" }];

  it("raises added and changed watched keys and prints their defaults at both refs", () => {
    const result = applyWatch(
      [
        finding("CONSUMERS_PREFETCH_COUNT", "config-key-added-optional"),
        finding("CONSUMERS_RETRY_IS_EXPONENTIAL", "config-key-default-changed", { message: "changed" }),
        finding("SHOP_URL", "config-key-removed", { message: "removed" }),
      ],
      { watch, matching: "normalized", base, revision },
    );
    expect(result.map((f) => `${f.subject} ${f.class}`)).toEqual([
      "CONSUMERS_PREFETCH_COUNT needs-action",
      "CONSUMERS_RETRY_IS_EXPONENTIAL needs-action",
      "SHOP_URL safe",
    ]);
    expect(result[0]?.message).toBe(
      'new key with a default; the release runs without a value in production; watched key (Consumers:*): consumer throughput; default absent → "1"',
    );
    expect(result[1]?.message).toBe(
      'changed; watched key (Consumers:*): consumer throughput; default "true" → "false"',
    );
    expect(result[2]?.message).toBe("removed");
  });

  it("never lowers a class and leaves chain findings alone", () => {
    const result = applyWatch(
      [
        finding("CONSUMERS_PREFETCH_COUNT", "config-key-added-required", { class: "breaking", message: "m" }),
        finding("CONSUMERS_PREFETCH_COUNT", "config-chain-missing", { message: "chain" }),
      ],
      { watch: [{ key: "CONSUMERS_*", class: "needs-action" }], matching: "normalized", base, revision },
    );
    expect(result.map((f) => `${f.class} ${f.message}`)).toEqual([
      'breaking m; watched key (CONSUMERS_*); default absent → "1"',
      "safe chain",
    ]);
  });
});
