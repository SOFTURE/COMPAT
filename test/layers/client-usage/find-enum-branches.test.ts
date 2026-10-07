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

  it("matches several properties and returns each line once", () => {
    const found = findEnumBranches('if (a.kind === "x" && b.type === "y") {}\nswitch (c.kind) {}\n', {
      enumName: "NotificationType",
      properties: ["type", "kind"],
    });
    expect(found).toEqual([1, 2]);
  });
});
