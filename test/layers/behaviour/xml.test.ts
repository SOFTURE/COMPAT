import { describe, expect, it } from "vitest";
import { findElements, parseXml } from "../../../src/layers/behaviour/xml.js";

describe("parseXml", () => {
  it("reads elements, attributes, text, CDATA and entities, and drops namespace prefixes", () => {
    const parsed = parseXml(
      '﻿<?xml version="1.0"?>\n<!-- run --><t:root xmlns:t="urn:x" t:a="1 &lt; 2" b=\'&#x41;&#66;\'>' +
        "<child>a &amp; b<![CDATA[ <raw> ]]></child><empty/></t:root>",
    );
    expect(parsed).toEqual({
      ok: true,
      value: {
        name: "root",
        attributes: { t: "urn:x", a: "1 < 2", b: "AB" },
        text: "",
        children: [
          { name: "child", attributes: {}, children: [], text: "a & b <raw> " },
          { name: "empty", attributes: {}, children: [], text: "" },
        ],
      },
    });
  });

  it("keeps a '>' inside a quoted attribute value", () => {
    const parsed = parseXml('<r m="a > b"/>');
    expect(parsed.ok && parsed.value.attributes.m).toBe("a > b");
  });

  it("finds descendants by name in document order", () => {
    const parsed = parseXml("<a><b n='1'><b n='2'/></b><c><b n='3'/></c></a>");
    if (!parsed.ok) throw new Error(parsed.error);
    expect(findElements(parsed.value, "b").map((element) => element.attributes.n)).toEqual(["1", "2", "3"]);
  });

  it.each([
    ["a mismatched closing tag", "<a><b></a>", "closing tag </a> does not match <b> at line 1"],
    ["an unclosed element", "<a>\n<b>", "element <b> is not closed"],
    ["an unterminated tag", "<a\n<b/>", "unterminated tag at line 1"],
    ["two roots", "<a/><b/>", "more than one root element at line 1"],
    ["text outside the root", "oops", "text outside the root element at line 1"],
    ["an empty document", "", "no root element"],
    [
      "an internal DTD subset",
      '<!DOCTYPE a [<!ENTITY x "y">]><a/>',
      "a DOCTYPE with an internal subset is not supported at line 1",
    ],
    ["a malformed attribute", "<a b=c/>", "malformed tag at line 1"],
  ])("rejects %s", (_, xml, error) => {
    expect(parseXml(xml)).toEqual({ ok: false, error });
  });
});
