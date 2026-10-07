import type { Token } from "../persisted-enums/tokenize.js";
import {
  isPunctuation,
  readTypeShape,
  readTypes,
  type Scan,
  scan,
  type TypeMember,
} from "./read-typescript-client.js";

/** One file of a client's own sources. */
export type SourceFile = { path: string; text: string };

/** Where a client builds the request body it sends. */
export type SentSite = { path: string; line: number };

export type SentQuery = {
  sources: readonly SourceFile[];
  /** The generated client function that sends the body. */
  functionName: string;
  /** Position of the body among the function's arguments. */
  bodyIndex: number;
  /** Property names from the body down to the property. */
  memberPath: string[];
  /** Types of the generated client, by name; the sources' own types are added. */
  clientTypes: Map<string, Map<string, TypeMember>>;
};

type File = { path: string; s: Scan };
/** Tokens `[start, end)` of one file. */
type Range = { file: File; start: number; end: number };
type Context = { files: File[]; types: Map<string, Map<string, TypeMember>> };
type FunctionNode = { open: number; close: number; bodyEnd: number; name?: string };
type Binding = { position: number; key?: string };

/** How many times a body may be passed on through a parameter before the resolver gives up. */
const MAX_FORWARDING = 1;
const CONTROL = new Set(["if", "for", "while", "switch", "catch", "with", "return"]);
const MUTATE = new Set(["mutate", "mutateAsync"]);
const DECLARE = new Set(["const", "let", "var"]);
const CONVERSIONS = new Set(["as", "satisfies"]);
/** Tokens after which `{` opens a type, not a function body: `(): { a: string } {`. */
const TYPE_CONTINUES = new Set([":", "|", "&", "<", ",", "=>"]);

const scans = new WeakMap<readonly SourceFile[], File[]>();

function scanSources(sources: readonly SourceFile[]): File[] {
  let files = scans.get(sources);
  if (files === undefined) {
    files = sources.map((source) => ({ path: source.path, s: scan(source.text) }));
    scans.set(sources, files);
  }
  return files;
}

/**
 * The object literals a client's own code passes as the request body, when every one of them sets
 * the property to a value that cannot be `undefined` or `null`. A literal is the argument itself, a
 * `const` initialised with one, or one passed through a parameter of the enclosing function: a call of
 * that function, or `mutate`/`mutateAsync` of the hook that holds it as `mutationFn`. `undefined`
 * when any call, argument or value cannot be followed, so a resolver miss never proves "always sent".
 */
export function findSentLiterals(query: SentQuery): SentSite[] | undefined {
  const files = scanSources(query.sources);
  const types = new Map(query.clientTypes);
  for (const file of files) {
    for (const [name, members] of readTypes(file.s)) if (!types.has(name)) types.set(name, members);
  }
  const context: Context = { files, types };
  const calls = findCalls(context, query.functionName);
  if (calls === undefined || calls.length === 0) return undefined;
  const sites = new Map<string, SentSite>();
  for (const call of calls) {
    const argument = readArguments(call)[query.bodyIndex];
    if (argument === undefined) return undefined;
    const literals = resolveLiterals(context, argument, 0);
    if (literals === undefined) return undefined;
    for (const literal of literals) {
      const values = readPath(context, literal, query.memberPath);
      if (values === undefined || !values.every((value) => isNonNullish(context, value))) return undefined;
      const site = { path: literal.file.path, line: tokenAt(literal, literal.start).line };
      sites.set(`${site.path}:${site.line}`, site);
    }
  }
  return [...sites.values()];
}

function tokenAt(range: { file: File }, index: number): Token {
  return range.file.s.tokens[index] as Token;
}

function isIdentifier(token: Token | undefined, text?: string): boolean {
  return token?.kind === "identifier" && (text === undefined || token.text === text);
}

/** The `(` of every call of `name` in the sources; `undefined` when `name` is also used other than called. */
function findCalls(context: Context, name: string, declared?: Range): Range[] | undefined {
  const calls: Range[] = [];
  for (const file of context.files) {
    const { tokens, match } = file.s;
    for (let index = 0; index < tokens.length; index++) {
      if (!isIdentifier(tokens[index], name)) continue;
      if (declared?.file === file && declared.start === index) continue;
      if (isPunctuation(tokens[index + 1], "(")) {
        const close = match[index + 1] ?? -1;
        const after = tokens[close + 1];
        // `name(...) {` declares a method, it does not call one.
        if (close >= 0 && !isPunctuation(after, "{") && !isPunctuation(after, "=>")) {
          calls.push({ file, start: index + 1, end: close + 1 });
          continue;
        }
      }
      if (isImported(file, index)) continue;
      return undefined;
    }
  }
  return calls;
}

/** The identifier at `index` is a name in an `import { ... }` clause. */
function isImported(file: File, index: number): boolean {
  const { tokens } = file.s;
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const token = tokens[cursor] as Token;
    if (isIdentifier(token, "import")) return true;
    const isClause =
      isIdentifier(token) ||
      isPunctuation(token, ",") ||
      isPunctuation(token, "{") ||
      isPunctuation(token, "*");
    if (!isClause) return false;
  }
  return false;
}

/** The top-level items of the bracket opened at `range.start`, split at commas. */
function readArguments(range: Range): Range[] {
  const { match, tokens } = range.file.s;
  const close = match[range.start] ?? -1;
  const items: Range[] = [];
  if (close < 0) return items;
  let start = range.start + 1;
  for (let index = start; index <= close; index++) {
    const token = tokens[index] as Token;
    if (index < close && token.kind === "punctuation" && "([{".includes(token.text)) {
      index = Math.max(index, match[index] ?? index);
      continue;
    }
    if (index === close || isPunctuation(token, ",")) {
      if (index > start) items.push({ file: range.file, start, end: index });
      start = index + 1;
    }
  }
  return items;
}

/** The range without wrapping parentheses and trailing `as T` / `satisfies T`. */
function trim(range: Range): Range {
  let { start, end } = range;
  const { match, tokens } = range.file.s;
  for (;;) {
    for (let index = start; index < end; index++) {
      const token = tokens[index] as Token;
      if (token.kind === "punctuation" && "([{".includes(token.text)) {
        index = Math.max(index, match[index] ?? index);
        continue;
      }
      if (index > start && token.kind === "identifier" && CONVERSIONS.has(token.text)) {
        end = index;
        break;
      }
    }
    if (end - start >= 2 && isPunctuation(tokens[start], "(") && match[start] === end - 1) {
      start++;
      end--;
      continue;
    }
    return { file: range.file, start, end };
  }
}

/** The object literals an expression evaluates to, or `undefined` when it cannot be followed. */
function resolveLiterals(context: Context, expression: Range, depth: number): Range[] | undefined {
  const range = trim(expression);
  const { tokens, match } = range.file.s;
  if (isPunctuation(tokens[range.start], "{") && match[range.start] === range.end - 1) return [range];
  if (range.end - range.start !== 1 || !isIdentifier(tokens[range.start])) return undefined;
  return resolveIdentifier(context, range, depth);
}

function resolveIdentifier(context: Context, at: Range, depth: number): Range[] | undefined {
  const name = tokenAt(at, at.start).text;
  for (const node of findEnclosingFunctions(at.file, at.start)) {
    const binding = findBinding(at.file, node, name);
    if (binding === undefined) continue;
    if (depth >= MAX_FORWARDING) return undefined;
    const callers = findCallers(context, at.file, node, binding.position);
    if (callers === undefined || callers.length === 0) return undefined;
    const literals: Range[] = [];
    for (const caller of callers) {
      const resolved = resolveLiterals(context, caller, depth + 1);
      if (resolved === undefined) return undefined;
      for (const literal of resolved) {
        if (binding.key === undefined) {
          literals.push(literal);
          continue;
        }
        const value = findProperty(literal, binding.key);
        if (value === undefined) return undefined;
        const inner = resolveLiterals(context, value, depth + 1);
        if (inner === undefined) return undefined;
        literals.push(...inner);
      }
    }
    return literals;
  }
  return resolveConst(at.file, name);
}

/** The literals of every `const name = { ... }` in the file; `undefined` when `name` is also a `let` or `var`. */
function resolveConst(file: File, name: string): Range[] | undefined {
  const { tokens, match } = file.s;
  const literals: Range[] = [];
  for (let index = 0; index < tokens.length - 2; index++) {
    if (!DECLARE.has(tokens[index]?.text ?? "") || !isIdentifier(tokens[index + 1], name)) continue;
    if (tokens[index]?.text !== "const") return undefined;
    const equals = findInitializer(file, index + 2);
    const open = equals + 1;
    if (equals < 0 || !isPunctuation(tokens[open], "{") || (match[open] ?? -1) < 0) return undefined;
    literals.push({ file, start: open, end: (match[open] as number) + 1 });
  }
  return literals.length > 0 ? literals : undefined;
}

/** The `=` of a declaration whose name ends before `start`, past an optional type annotation; -1 when none. */
function findInitializer(file: File, start: number): number {
  const { tokens, match } = file.s;
  if (isPunctuation(tokens[start], "=")) return start;
  if (!isPunctuation(tokens[start], ":")) return -1;
  for (let index = start + 1; index < tokens.length; index++) {
    const token = tokens[index] as Token;
    if (token.kind === "punctuation" && "([{".includes(token.text)) {
      index = Math.max(index, match[index] ?? index);
      continue;
    }
    if (isPunctuation(token, "=") && !isPunctuation(tokens[index + 1], ">")) return index;
    if (isPunctuation(token, ";")) return -1;
  }
  return -1;
}

/** Functions whose body holds `index`, innermost first. */
function findEnclosingFunctions(file: File, index: number): FunctionNode[] {
  const nodes: FunctionNode[] = [];
  const { tokens, match } = file.s;
  for (let open = index - 1; open >= 0; open--) {
    if (!isPunctuation(tokens[open], "(")) continue;
    const close = match[open] ?? -1;
    if (close < 0 || close >= index || CONTROL.has(tokens[open - 1]?.text ?? "")) continue;
    const node = readFunction(file, open, close);
    if (node !== undefined && node.bodyEnd > index) nodes.push(node);
  }
  return nodes;
}

/** The function whose parameter list is `(open, close)`, or `undefined` when the parentheses are not one. */
function readFunction(file: File, open: number, close: number): FunctionNode | undefined {
  const { tokens, match } = file.s;
  let cursor = close + 1;
  if (isPunctuation(tokens[cursor], ":")) {
    // A return type annotation runs until the `=>` or the `{` of the body.
    for (cursor++; cursor < tokens.length; cursor++) {
      const token = tokens[cursor] as Token;
      if (isPunctuation(token, "=>")) break;
      if (isPunctuation(token, "{") && !TYPE_CONTINUES.has(tokens[cursor - 1]?.text ?? "")) break;
      if (isPunctuation(token, ";")) return undefined;
      if (token.kind === "punctuation" && "([{".includes(token.text))
        cursor = Math.max(cursor, match[cursor] ?? cursor);
    }
  }
  let bodyEnd: number;
  if (isPunctuation(tokens[cursor], "{")) bodyEnd = match[cursor] ?? -1;
  else if (isPunctuation(tokens[cursor], "=>")) {
    bodyEnd = isPunctuation(tokens[cursor + 1], "{")
      ? (match[cursor + 1] ?? -1)
      : findExpressionEnd(file, cursor + 1);
  } else return undefined;
  if (bodyEnd < 0) return undefined;
  const node: FunctionNode = { open, close, bodyEnd };
  const name = readFunctionName(file, open);
  if (name !== undefined) node.name = name;
  return node;
}

/** `name(`, `function name(`, `name = (`, `name: async (`; anything else is anonymous. */
function readFunctionName(file: File, open: number): string | undefined {
  const { tokens } = file.s;
  let cursor = open - 1;
  if (isIdentifier(tokens[cursor], "async")) cursor--;
  if (isIdentifier(tokens[cursor], "function")) cursor--;
  const token = tokens[cursor];
  if (isPunctuation(token, "=") || isPunctuation(token, ":")) {
    const name = tokens[cursor - 1];
    return isIdentifier(name) ? (name as Token).text : undefined;
  }
  if (isIdentifier(token) && !CONTROL.has((token as Token).text)) return (token as Token).text;
  return undefined;
}

/** The end of an expression starting at `start`: the first top-level `,` or `;`, or the enclosing closer. */
function findExpressionEnd(file: File, start: number): number {
  const { tokens, match } = file.s;
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index] as Token;
    if (token.kind !== "punctuation") continue;
    if ("([{".includes(token.text)) {
      index = Math.max(index, match[index] ?? index);
      continue;
    }
    if (",;)]}".includes(token.text)) return index;
  }
  return tokens.length;
}

/** The parameter of the function that binds `name`: directly, or as a key of a destructured object. */
function findBinding(file: File, node: FunctionNode, name: string): Binding | undefined {
  const { tokens, match } = file.s;
  const parameters = readArguments({ file, start: node.open, end: node.close + 1 });
  for (const [position, parameter] of parameters.entries()) {
    const first = tokens[parameter.start];
    if (isIdentifier(first, name)) return { position };
    if (!isPunctuation(first, "{")) continue;
    const pattern = { file, start: parameter.start, end: (match[parameter.start] ?? parameter.start) + 1 };
    for (const item of readArguments(pattern)) {
      const key = tokens[item.start];
      const isShorthand = item.end - item.start === 1 && isIdentifier(key, name);
      const isRenamed =
        item.end - item.start === 3 &&
        isPunctuation(tokens[item.start + 1], ":") &&
        isIdentifier(tokens[item.start + 2], name);
      if (isShorthand || isRenamed) return { position, key: (key as Token).text };
    }
  }
  return undefined;
}

/** The arguments passed at `position` to the function: by its callers, or by `mutate` of the hook holding it. */
function findCallers(
  context: Context,
  file: File,
  node: FunctionNode,
  position: number,
): Range[] | undefined {
  if (node.name === undefined) return undefined;
  let calls: Range[] | undefined;
  if (node.name === "mutationFn") {
    const hook = findEnclosingFunctions(file, node.open).find((outer) => outer.name !== undefined);
    if (hook?.name === undefined) return undefined;
    calls = findMutateCalls(context, hook.name);
  } else {
    const nameIndex = findNameIndex(file, node.open);
    calls = findCalls(
      context,
      node.name,
      nameIndex === undefined ? undefined : { file, start: nameIndex, end: nameIndex + 1 },
    );
  }
  if (calls === undefined) return undefined;
  const callers: Range[] = [];
  for (const call of calls) {
    const argument = readArguments(call)[position];
    if (argument === undefined) return undefined;
    callers.push(argument);
  }
  return callers;
}

function findNameIndex(file: File, open: number): number | undefined {
  const { tokens } = file.s;
  for (let cursor = open - 1; cursor >= Math.max(0, open - 4); cursor--) {
    const token = tokens[cursor] as Token;
    if (isIdentifier(token) && !["async", "function"].includes(token.text)) return cursor;
  }
  return undefined;
}

/**
 * The `(` of every `v.mutate(...)` / `v.mutateAsync(...)` where `const v = hook(...)`, and of every
 * `mutate(...)` destructured as `const { mutate } = hook(...)`. `undefined` when a mutate function is
 * used other than called, or the hook's result is used in a way the resolver does not read.
 */
function findMutateCalls(context: Context, hook: string): Range[] | undefined {
  const calls: Range[] = [];
  for (const file of context.files) {
    const { tokens, match } = file.s;
    for (let index = 0; index < tokens.length; index++) {
      if (!isIdentifier(tokens[index], hook) || !isPunctuation(tokens[index + 1], "(")) continue;
      if (!isPunctuation(tokens[index - 1], "=")) {
        if (isImported(file, index) || readFunctionName(file, index + 1) === hook) continue;
        return undefined;
      }
      const target = tokens[index - 2];
      let names: number[];
      if (isIdentifier(target) && DECLARE.has(tokens[index - 3]?.text ?? "")) {
        names = [];
        const found = findMemberCalls(file, (target as Token).text, calls);
        if (!found) return undefined;
      } else if (isPunctuation(target, "}")) {
        const open = match[index - 2] ?? -1;
        if (open < 0 || !DECLARE.has(tokens[open - 1]?.text ?? "")) return undefined;
        names = readMutateNames(file, open);
      } else return undefined;
      for (const name of names) {
        // The destructuring itself names the function once without calling it.
        const declared = { file, start: name, end: name + 1 };
        const direct = findCalls({ ...context, files: [file] }, (tokens[name] as Token).text, declared);
        if (direct === undefined) return undefined;
        calls.push(...direct);
      }
    }
  }
  return calls.length > 0 ? calls : undefined;
}

/** Token indexes of the local names of `mutate` / `mutateAsync` in `{ mutate, mutateAsync: save }`. */
function readMutateNames(file: File, open: number): number[] {
  const { tokens } = file.s;
  const names: number[] = [];
  for (const item of readArguments({ file, start: open, end: open + 1 })) {
    if (!MUTATE.has(tokens[item.start]?.text ?? "")) continue;
    const isRenamed = isPunctuation(tokens[item.start + 1], ":") && isIdentifier(tokens[item.start + 2]);
    names.push(isRenamed ? item.start + 2 : item.start);
  }
  return names;
}

/** Adds the `(` of every `variable.mutate(` in the file; false when `variable.mutate` is used uncalled. */
function findMemberCalls(file: File, variable: string, calls: Range[]): boolean {
  const { tokens, match } = file.s;
  for (let index = 0; index < tokens.length - 3; index++) {
    if (!isIdentifier(tokens[index], variable) || !isPunctuation(tokens[index + 1], ".")) continue;
    if (!MUTATE.has(tokens[index + 2]?.text ?? "")) continue;
    if (!isPunctuation(tokens[index + 3], "(")) return false;
    const close = match[index + 3] ?? -1;
    if (close < 0) return false;
    calls.push({ file, start: index + 3, end: close + 1 });
  }
  return true;
}

/** The value of `key` set by an object literal; `undefined` when absent, spread over or computed. */
function findProperty(literal: Range, key: string): Range | undefined {
  const { tokens } = literal.file.s;
  let value: Range | undefined;
  for (const item of readArguments(literal)) {
    const first = tokens[item.start] as Token;
    // A spread or computed key may set the property to anything.
    if (isPunctuation(first, ".") || isPunctuation(first, "[")) return undefined;
    const isKey = (first.kind === "identifier" || first.kind === "string") && first.text === key;
    if (!isKey) continue;
    if (item.end - item.start === 1) value = item;
    else if (isPunctuation(tokens[item.start + 1], ":"))
      value = { file: item.file, start: item.start + 2, end: item.end };
    else return undefined;
  }
  return value;
}

/** The values the literal sets at the end of the path, walking nested literals; `undefined` when not readable. */
function readPath(context: Context, literal: Range, path: string[]): Range[] | undefined {
  const [key, ...rest] = path;
  if (key === undefined) return undefined;
  const value = findProperty(literal, key);
  if (value === undefined) return undefined;
  if (rest.length === 0) return [value];
  const inner = resolveLiterals(context, value, MAX_FORWARDING);
  if (inner === undefined) return undefined;
  const values: Range[] = [];
  for (const nested of inner) {
    const found = readPath(context, nested, rest);
    if (found === undefined) return undefined;
    values.push(...found);
  }
  return values;
}

/** The first index outside brackets in the range that passes `test`; -1 when none. */
function findTopLevel(range: Range, test: (index: number) => boolean): number {
  const { tokens, match } = range.file.s;
  for (let index = range.start; index < range.end; index++) {
    const token = tokens[index] as Token;
    if (token.kind === "punctuation" && "([{".includes(token.text)) {
      index = Math.max(index, match[index] ?? index);
      continue;
    }
    if (test(index)) return index;
  }
  return -1;
}

/** Whether an expression can never evaluate to `undefined` or `null`. */
function isNonNullish(context: Context, expression: Range): boolean {
  const range = trim(expression);
  const { tokens, match } = range.file.s;
  const isQuestion = (index: number) =>
    isPunctuation(tokens[index], "?") &&
    !isPunctuation(tokens[index + 1], "?") &&
    !isPunctuation(tokens[index - 1], "?");
  const question = findTopLevel(range, isQuestion);
  if (question >= 0) {
    let depth = 0;
    const colon = findTopLevel({ ...range, start: question + 1 }, (index) => {
      if (isQuestion(index)) depth++;
      else if (isPunctuation(tokens[index], ":") && depth-- === 0) return true;
      return false;
    });
    if (colon < 0) return false;
    return (
      isNonNullish(context, { ...range, start: question + 1, end: colon }) &&
      isNonNullish(context, { ...range, start: colon + 1 })
    );
  }
  // `a ?? b` and `a || b` are never nullish when `b` is not.
  const fallback = findTopLevel(
    range,
    (index) =>
      (isPunctuation(tokens[index], "?") && isPunctuation(tokens[index + 1], "?")) ||
      (isPunctuation(tokens[index], "|") && isPunctuation(tokens[index + 1], "|")),
  );
  if (fallback >= 0) return isNonNullish(context, { ...range, start: fallback + 2 });
  const first = tokens[range.start];
  if (first === undefined || range.end <= range.start) return false;
  const length = range.end - range.start;
  if ((isPunctuation(first, "[") || isPunctuation(first, "{")) && match[range.start] === range.end - 1)
    return true;
  if (length === 1) {
    if (first.kind === "string" || first.kind === "number") return true;
    if (first.kind !== "identifier") return false;
    if (first.text === "true" || first.text === "false") return true;
    if (first.text === "null" || first.text === "undefined") return false;
  }
  if (isIdentifier(first, "new") || isPunctuation(first, "!") || isIdentifier(first, "typeof")) return true;
  return isDeclaredNonNullish(context, range);
}

/** `a` or `a.b.c` whose declared types have neither `undefined` nor `null` on the way. */
function isDeclaredNonNullish(context: Context, range: Range): boolean {
  const { tokens } = range.file.s;
  const chain: string[] = [];
  for (let index = range.start; index < range.end; index += 2) {
    if (!isIdentifier(tokens[index])) return false;
    chain.push((tokens[index] as Token).text);
    if (index + 1 < range.end && !isPunctuation(tokens[index + 1], ".")) return false;
  }
  const [root, ...members] = chain;
  if (root === undefined) return false;
  const declarations = readDeclarations(context, range.file, root);
  if (declarations.length === 0 || declarations.some((declaration) => !declaration.isNonNullish))
    return false;
  if (members.length === 0) return true;
  let typeName = declarations[0]?.typeName;
  if (typeName === undefined || declarations.some((declaration) => declaration.typeName !== typeName))
    return false;
  for (const member of members) {
    const declared: TypeMember | undefined = context.types.get(typeName as string)?.get(member);
    if (declared === undefined || declared.isOptional || declared.isNullable) return false;
    typeName = declared.typeName;
  }
  return true;
}

type Declaration = { isNonNullish: boolean; typeName?: string };

/** Every declaration of `name` in the file: typed parameters and `const` / `let` / `var`. */
function readDeclarations(context: Context, file: File, name: string): Declaration[] {
  const { tokens, match } = file.s;
  const declarations: Declaration[] = [];
  const fromAnnotation = (start: number, end: number, isOptional: boolean): Declaration => {
    const shape = readTypeShape(tokens.slice(start, end));
    const declaration: Declaration = {
      isNonNullish: !isOptional && !shape.isNullable && !shape.isUndefinable,
    };
    if (shape.typeName !== undefined) declaration.typeName = shape.typeName;
    return declaration;
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as Token;
    if (DECLARE.has(token.text) && isIdentifier(tokens[index + 1], name)) {
      const equals = findInitializer(file, index + 2);
      if (isPunctuation(tokens[index + 2], ":")) {
        declarations.push(
          fromAnnotation(index + 3, equals < 0 ? findExpressionEnd(file, index + 3) : equals, false),
        );
      } else if (token.text === "const" && equals >= 0) {
        const end = findExpressionEnd(file, equals + 1);
        declarations.push({ isNonNullish: isNonNullish(context, { file, start: equals + 1, end }) });
      } else declarations.push({ isNonNullish: false });
      continue;
    }
    if (!isPunctuation(token, "(") || CONTROL.has(tokens[index - 1]?.text ?? "")) continue;
    const close = match[index] ?? -1;
    if (close < 0 || readFunction(file, index, close) === undefined) continue;
    for (const parameter of readArguments({ file, start: index, end: close + 1 })) {
      if (!isIdentifier(tokens[parameter.start], name)) continue;
      let cursor = parameter.start + 1;
      const isOptional = isPunctuation(tokens[cursor], "?");
      if (isOptional) cursor++;
      if (!isPunctuation(tokens[cursor], ":")) {
        declarations.push({ isNonNullish: false });
        continue;
      }
      const defaultAt = findTopLevel({ file, start: cursor + 1, end: parameter.end }, (at) =>
        isPunctuation(tokens[at], "="),
      );
      declarations.push(
        fromAnnotation(cursor + 1, defaultAt < 0 ? parameter.end : defaultAt, isOptional && defaultAt < 0),
      );
    }
  }
  return declarations;
}
