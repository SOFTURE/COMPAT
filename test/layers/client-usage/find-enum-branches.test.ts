// biome-ignore-all lint/suspicious/noTemplateCurlyInString: TypeScript template literal holes are the test input
import { describe, expect, it } from "vitest";
import { findEnumBranches } from "../../../src/layers/client-usage/find-enum-branches.js";

const target = { enumName: "NotificationType", properties: ["type"] };
const lines = (...source: string[]) => findEnumBranches(source.join("\n"), target);

describe("findEnumBranches", () => {
  it("finds a switch over the property, also across lines", () => {
    expect(lines("switch (notification.type) {", '  case "Reminder": return 1;', "}")).toEqual([1]);
    expect(lines("switch (", "  item?.type", ") {}")).toEqual([1]);
  });

  it("finds a switch over the enum and case labels of the enum", () => {
    expect(lines("switch (asType(x) as NotificationType) {}")).toEqual([1]);
    expect(lines("switch (kind) {", "  case NotificationType.Reminder:", "}")).toEqual([2]);
  });

  it.each([
    ['if (n.type === "Reminder") {}'],
    ['if ("Reminder" !== n.type) {}'],
    ["const isReminder = n?.type == kind;"],
    ["if (kind != n.type) {}"],
    ['if (type === "Reminder") {}'],
    ["if (kind === NotificationType.Reminder) {}"],
    ['if (n.Type === "Reminder") {}'],
  ])("finds the comparison %s", (source) => {
    expect(lines(source)).toEqual([1]);
  });

  it("finds lookup maps keyed by the enum or the property", () => {
    expect(lines("const labels: Record<NotificationType, string> = {};")).toEqual([1]);
    expect(lines('const labels: Record<NotificationDto["type"], string> = {};')).toEqual([1]);
    expect(lines("type Labels = { [key in NotificationType]: string };")).toEqual([1]);
    expect(lines("const label = labels[notification.type];")).toEqual([1]);
  });

  it("ignores reads that do not branch", () => {
    expect(
      lines(
        "const type = notification.type;",
        "render(<Badge type={notification.type} />);",
        "const other = a === b;",
        "switch (status) { case Other.A: break; }",
        "const labels: Record<string, NotificationType> = {};",
        "const typed = labels[key];",
        "send({ type: notification.type });",
        "const subtype = x.subtype === 1;",
        "const isLow = n.type <= 3 || n.type >= 1;",
      ),
    ).toEqual([]);
  });

  it("ignores commented-out branches", () => {
    expect(lines("// if (n.type === 'Reminder') {}", "/* switch (n.type) {} */")).toEqual([]);
  });

  it("counts a branch inside a template literal hole through the raw-text net", () => {
    expect(lines('const label = `${n.type === "Reminder" ? "a" : "b"}`;')).toEqual([1]);
  });

  it("counts a branch the tokenizer lost after an unclosed literal", () => {
    // Invalid TypeScript: the unclosed template literal swallows the rest of the file for the scanner.
    expect(
      lines("const text = `never closed;", 'if (n.type === "Reminder") {}', "const t = n.type;"),
    ).toEqual([2]);
  });

  describe("string literal operands (issue #69)", () => {
    const withValues = { ...target, values: ["Reminder", "TermsChange", "unknown"] };
    const scan = (...source: string[]) => findEnumBranches(source.join("\n"), withValues);

    it("never reads a string literal as the property, whatever its text ends with", () => {
      expect(lines("if (key.toLowerCase() === 'content-type') {}")).toEqual([]);
      expect(lines("const header = ['content-type', 'x-type'].includes(key) ? 1 : 2;")).toEqual([]);
    });

    it.each([
      ["if (event.type === 'set') {}"],
      ['if ("dismissed" !== event?.type) {}'],
      ["const isSet = event.type == 'set' && other.type != \"x\";"],
      ['const label = event.type === "set" ? "a" : "b";'],
    ])("ignores the comparison %s against a string that is not a member", (source) => {
      expect(scan(source)).toEqual([]);
    });

    it.each([
      ["if (n.type === 'TermsChange') {}"],
      ['if ("Reminder" !== n.type) {}'],
      ["if (n.type === 'termschange') {}"],
      ["if (n.type === 'Unknown') {}"],
      ["if (n.type === kind) {}"],
      ["if (n.type === `${prefix}set`) {}"],
      ["if (n.type === 'se' + suffix) {}"],
      ["if (prefix + 'set' === n.type) {}"],
      ["if (n.type === 'set'.toUpperCase()) {}"],
      ["if (n.type === 'set' || n.type === other) {}"],
    ])("still counts the comparison %s", (source) => {
      expect(scan(source)).toEqual([1]);
    });

    it("counts a string comparison when the enum values are unknown", () => {
      expect(lines("if (event.type === 'set') {}")).toEqual([1]);
    });

    it("ignores a switch whose case labels are all strings that are not members", () => {
      expect(
        scan("switch (event.type) {", "  case 'set': break;", "  case 'dismissed': break;", "}"),
      ).toEqual([]);
    });

    it.each([
      [["switch (n.type) {", "  case 'Unknown': return 0;", "}"]],
      [["switch (n.type) {", "  case 'set': break;", "  case Kind.Other: break;", "}"]],
      [["switch (n.type) {", "  default: break;", "}"]],
      [["switch (n.type as NotificationType) {", "  case 'set': break;", "}"]],
    ])("still counts the switch %j", (source) => {
      expect(scan(...source)).toEqual([1]);
    });
  });

  it("matches several properties and returns each line once", () => {
    const found = findEnumBranches('if (a.kind === "x" && b.type === "y") {}\nswitch (c.kind) {}\n', {
      enumName: "NotificationType",
      properties: ["type", "kind"],
    });
    expect(found).toEqual([1, 2]);
  });
});
