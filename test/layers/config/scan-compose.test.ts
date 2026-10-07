// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose interpolation syntax is the test input
import { describe, expect, it } from "vitest";
import { scanCompose } from "../../../src/layers/config/scan-compose.js";

describe("scanCompose", () => {
  it("reads every interpolation form", () => {
    const text = [
      "a: ${PLAIN}",
      "b: ${WITH_DEFAULT:-x y}",
      "c: ${UNSET_DEFAULT-z}",
      "d: ${REQUIRED:?must be set}",
      "e: ${REQUIRED_UNSET?err}",
      "f: ${ALT:+on}",
      "g: ${ALT_UNSET+on}",
      "h: $BARE and ${EMPTY_DEFAULT:-}",
    ].join("\n");
    expect(scanCompose(text)).toEqual([
      { key: "PLAIN", line: 1, default: null },
      { key: "WITH_DEFAULT", line: 2, default: "x y" },
      { key: "UNSET_DEFAULT", line: 3, default: "z" },
      { key: "REQUIRED", line: 4, default: null },
      { key: "REQUIRED_UNSET", line: 5, default: null },
      { key: "ALT", line: 6, default: "" },
      { key: "ALT_UNSET", line: 7, default: "" },
      { key: "BARE", line: 8, default: null },
      { key: "EMPTY_DEFAULT", line: 8, default: "" },
    ]);
  });

  it("skips escaped dollars", () => {
    expect(scanCompose('command: sh -c "echo $$HOME $${NOPE}"')).toEqual([]);
  });

  it("gives references nested in a default an empty default", () => {
    expect(scanCompose("a: ${OUTER:-${INNER}-$BARE}")).toEqual([
      { key: "OUTER", line: 1, default: "${INNER}-$BARE" },
      { key: "INNER", line: 1, default: "" },
      { key: "BARE", line: 1, default: "" },
    ]);
  });

  it("ignores commented-out lines and trailing comments", () => {
    const text = "# token: ${LEGACY_TOKEN}\na: ${KEPT} # was ${OLD}\n  #b: ${INDENTED}";
    expect(scanCompose(text)).toEqual([{ key: "KEPT", line: 2, default: null }]);
  });

  it("skips invalid names, unsupported modifiers and unterminated references", () => {
    expect(scanCompose("a: ${1}\nb: ${A/x/y}\nc: ${OPEN\nd: ${}\ne: $1")).toEqual([]);
  });

  it("reads references inside block scalars, also after a hash", () => {
    const text = [
      "command: | # ${HEADER_NOTE}",
      "  run ${FIRST} # ${AFTER_HASH}",
      "  # ${HASH_LINE}",
      "b: 1 # ${DROPPED}",
    ];
    expect(scanCompose(text.join("\n"))).toEqual([
      { key: "FIRST", line: 2, default: null },
      { key: "AFTER_HASH", line: 2, default: null },
      { key: "HASH_LINE", line: 3, default: null },
    ]);
  });

  it("reads references on continuation lines of multi-line quoted scalars", () => {
    const text = ['a: "start ${ONE}', "  # ${TWO}", '  end" # ${DROPPED}', "b: 'x", "  #${THREE}'"];
    expect(scanCompose(text.join("\n"))).toEqual([
      { key: "ONE", line: 1, default: null },
      { key: "TWO", line: 2, default: null },
      { key: "THREE", line: 5, default: null },
    ]);
  });

  it("drops a trailing comment after an apostrophe in a plain scalar", () => {
    expect(scanCompose("command: echo it's ${KEPT} # ${OLD}")).toEqual([
      { key: "KEPT", line: 1, default: null },
    ]);
  });

  it("reads pass-through environment entries as keys without a default", () => {
    const text = [
      "services:",
      "  app:",
      "    environment:",
      "      - API_KEY",
      "      - LOG=${LOG_LEVEL:-info}",
    ];
    expect(scanCompose(text.join("\n"))).toEqual([
      { key: "LOG_LEVEL", line: 5, default: "info" },
      { key: "API_KEY", line: 4, default: null },
    ]);
  });

  it("returns nothing for an empty file", () => {
    expect(scanCompose("")).toEqual([]);
  });
});
