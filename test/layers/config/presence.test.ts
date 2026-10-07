import { describe, expect, it } from "vitest";
import { normalizeKey } from "../../../src/layers/config/keys.js";
import {
  applyPresence,
  hasResolvableFindings,
  parsePresenceOutput,
  presenceSchema,
  readPresentKeys,
} from "../../../src/layers/config/presence.js";
import type { Finding } from "../../../src/model/finding.js";

const finding = (subject: string, id: string, findingClass: Finding["class"] = "needs-action"): Finding => ({
  layer: "config",
  scope: "compose",
  id,
  subject,
  class: findingClass,
  message: "base message",
  evidence: [],
});

describe("parsePresenceOutput", () => {
  it("keeps only key names, normalized, and drops values, comments, blank lines and export", () => {
    const keys = parsePresenceOutput(
      "SHOP_API_KEY=secret\r\n\n# comment\nexport Shop__BaseUrl=x=y\n  Logging:Level  \n",
      normalizeKey,
    );
    expect([...keys]).toEqual(["SHOP_API_KEY", "SHOP_BASE_URL", "LOGGING_LEVEL"]);
  });

  it("returns an empty set for empty output", () => {
    expect(parsePresenceOutput("", normalizeKey).size).toBe(0);
  });
});

describe("applyPresence", () => {
  it("makes a listed required key safe and marks an unlisted one missing", () => {
    const result = applyPresence(
      [
        finding("SHOP_API_KEY", "config-key-added-required"),
        finding("SHOP_BASE_URL", "config-key-added-required"),
        finding("LOGGING_LEVEL", "config-key-default-removed"),
        finding("OLD", "config-key-removed", "safe"),
      ],
      new Set(["SHOP_API_KEY", "LOGGING_LEVEL", "OLD"]),
    );
    expect(result.map((f) => `${f.subject} ${f.class} ${f.message}`)).toEqual([
      "SHOP_API_KEY safe base message; present in the target environment (presence command)",
      "SHOP_BASE_URL needs-action base message; missing in the target environment (presence command)",
      "LOGGING_LEVEL safe base message; present in the target environment (presence command)",
      "OLD safe base message",
    ]);
  });

  it("detects whether any finding needs a value in production", () => {
    expect(hasResolvableFindings([finding("OLD", "config-key-removed", "safe")])).toBe(false);
    expect(hasResolvableFindings([finding("NEW", "config-key-added-required")])).toBe(true);
  });
});

describe("readPresentKeys", () => {
  const read = (run: string, timeoutSeconds?: number) =>
    readPresentKeys({
      presence: { run, timeoutSeconds },
      cwd: process.cwd(),
      env: process.env,
      identify: normalizeKey,
    });

  it("lists the keys a command prints", async () => {
    const result = await read("printf 'A=1\\nB\\n'");
    expect(result.ok && [...result.value]).toEqual(["A", "B"]);
  });

  it("reports a non-zero exit without quoting the output", async () => {
    const result = await read("echo A=secret; echo secret >&2; exit 3");
    expect(result).toEqual({ ok: false, error: "presence command exited 3" });
  });

  it("reports a timeout", async () => {
    const result = await read("sleep 5", 1);
    expect(result).toEqual({ ok: false, error: "presence command timed out after 1 s" });
  });
});

describe("presenceSchema", () => {
  it("accepts a command with an optional timeout and rejects unknown fields", () => {
    expect(presenceSchema.parse({ run: "gh secret list", timeoutSeconds: 30 })).toEqual({
      run: "gh secret list",
      timeoutSeconds: 30,
    });
    expect(presenceSchema.safeParse({ run: "x", values: true }).success).toBe(false);
    expect(presenceSchema.safeParse({ run: "" }).success).toBe(false);
  });
});
