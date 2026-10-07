import { err, ok, type Result } from "../../result.js";

export type XmlElement = {
  /** The local name, without a namespace prefix. */
  name: string;
  /** Attributes by local name. */
  attributes: Record<string, string>;
  children: XmlElement[];
  /** Text directly inside the element (CDATA included), entities decoded. */
  text: string;
};

const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/**
 * Reads the XML of a test result file: elements, attributes, text, CDATA, comments and processing
 * instructions. It does not resolve DTDs or external entities. A malformed document is an error
 * that names the line.
 */
export function parseXml(source: string): Result<XmlElement> {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let index = 0;
  const lineAt = (position: number) => text.slice(0, position).split("\n").length;
  const fail = (message: string, position: number) => err(`${message} at line ${lineAt(position)}`);

  while (index < text.length) {
    const open = text.indexOf("<", index);
    const chunk = text.slice(index, open === -1 ? text.length : open);
    if (chunk.trim() !== "") {
      const current = stack.at(-1);
      if (current === undefined) return fail("text outside the root element", index);
      current.text += decodeEntities(chunk);
    }
    if (open === -1) break;

    if (text.startsWith("<!--", open)) {
      const end = text.indexOf("-->", open + 4);
      if (end === -1) return fail("unterminated comment", open);
      index = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", open)) {
      const end = text.indexOf("]]>", open + 9);
      if (end === -1) return fail("unterminated CDATA section", open);
      const current = stack.at(-1);
      if (current === undefined) return fail("CDATA outside the root element", open);
      current.text += text.slice(open + 9, end);
      index = end + 3;
      continue;
    }
    if (text.startsWith("<?", open)) {
      const end = text.indexOf("?>", open + 2);
      if (end === -1) return fail("unterminated processing instruction", open);
      index = end + 2;
      continue;
    }
    if (text.startsWith("<!", open)) {
      const end = text.indexOf(">", open);
      if (end === -1) return fail("unterminated declaration", open);
      if (text.slice(open, end).includes("[")) {
        return fail("a DOCTYPE with an internal subset is not supported", open);
      }
      index = end + 1;
      continue;
    }

    const tagEnd = findTagEnd(text, open + 1);
    if (tagEnd === -1) return fail("unterminated tag", open);
    const body = text.slice(open + 1, tagEnd);
    index = tagEnd + 1;

    if (body.startsWith("/")) {
      const name = getLocalName(body.slice(1).trim());
      const current = stack.pop();
      if (current === undefined || current.name !== name) {
        return fail(`closing tag </${name}> does not match <${current?.name ?? "nothing"}>`, open);
      }
      continue;
    }

    const isSelfClosing = body.endsWith("/");
    const tag = readTag(isSelfClosing ? body.slice(0, -1) : body);
    if (tag === null) return fail("malformed tag", open);
    const element: XmlElement = { name: tag.name, attributes: tag.attributes, children: [], text: "" };
    const parent = stack.at(-1);
    if (parent === undefined) {
      if (root !== undefined) return fail("more than one root element", open);
      root = element;
    } else {
      parent.children.push(element);
    }
    if (!isSelfClosing) stack.push(element);
  }

  if (stack.length > 0) return err(`element <${stack.at(-1)?.name}> is not closed`);
  if (root === undefined) return err("no root element");
  return ok(root);
}

/** Descendant elements named `name`, at any depth, in document order. */
export function findElements(element: XmlElement, name: string): XmlElement[] {
  const found: XmlElement[] = [];
  const visit = (current: XmlElement) => {
    for (const child of current.children) {
      if (child.name === name) found.push(child);
      visit(child);
    }
  };
  visit(element);
  return found;
}

export function findChild(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((child) => child.name === name);
}

/** The `>` that ends a tag starting at `from`, skipping quoted attribute values. */
function findTagEnd(text: string, from: number): number {
  let quote: string | null = null;
  for (let position = from; position < text.length; position += 1) {
    const char = text[position];
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return position;
    } else if (char === "<") {
      return -1;
    }
  }
  return -1;
}

function readTag(body: string): { name: string; attributes: Record<string, string> } | null {
  const nameMatch = /^\s*([^\s/>]+)/.exec(body);
  if (nameMatch === null) return null;
  const attributes: Record<string, string> = {};
  let rest = body.slice(nameMatch[0].length);
  const attribute = /^\s+([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/;
  for (;;) {
    const match = attribute.exec(rest);
    if (match === null) break;
    attributes[getLocalName(match[1] as string)] = decodeEntities(match[2] ?? match[3] ?? "");
    rest = rest.slice(match[0].length);
  }
  if (rest.trim() !== "") return null;
  return { name: getLocalName(nameMatch[1] as string), attributes };
}

function getLocalName(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith("#x")) return safeFromCodePoint(Number.parseInt(entity.slice(2), 16)) ?? whole;
    if (entity.startsWith("#")) return safeFromCodePoint(Number.parseInt(entity.slice(1), 10)) ?? whole;
    return NAMED_ENTITIES[entity] ?? whole;
  });
}

function safeFromCodePoint(codePoint: number): string | undefined {
  return codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : undefined;
}
