import { describe, expect, it } from "vitest";
import { findSentLiterals, type SourceFile } from "../../../src/layers/client-usage/find-sent-literals.js";

const QUERY = {
  functionName: "postMedication",
  bodyIndex: 0,
  memberPath: ["daysOfWeek"],
  clientTypes: new Map(),
};

const find = (...sources: SourceFile[]) => findSentLiterals({ ...QUERY, sources });

const source = (text: string, path = "app/medications.ts"): SourceFile => ({ path, text });

describe("findSentLiterals", () => {
  it("accepts a literal argument whose property is an array literal", () => {
    expect(find(source(`client.postMedication({ name: "a", daysOfWeek: [] }, petId);`))).toEqual([
      { path: "app/medications.ts", line: 1 },
    ]);
  });

  it("accepts a conditional whose branches are a typed parameter and a literal", () => {
    const text = `
function save(petId: string, weekdays: boolean, days: DayOfWeek[]) {
  return client.postMedication(
    { daysOfWeek: weekdays ? days : [] },
    petId,
  );
}`;
    expect(find(source(text))).toEqual([{ path: "app/medications.ts", line: 4 }]);
  });

  it("accepts a local const initialised with a literal", () => {
    const text = `
async function save(petId: string) {
  const request = { daysOfWeek: [1, 2] as DayOfWeek[] };
  await client.postMedication(request, petId);
}`;
    expect(find(source(text))).toEqual([{ path: "app/medications.ts", line: 3 }]);
  });

  it("follows a body forwarded through a named function", () => {
    const text = `
const send = (request: AddMedication, petId: string) => client.postMedication(request, petId);
send({ daysOfWeek: [] }, "1");
send({ daysOfWeek: ["monday"] }, "2");`;
    expect(find(source(text))).toEqual([
      { path: "app/medications.ts", line: 3 },
      { path: "app/medications.ts", line: 4 },
    ]);
  });

  it("follows a destructured mutationFn parameter to the hook's mutateAsync calls in another file", () => {
    const hook = source(
      `
export const useUpsertMedication = () =>
  useMutation({
    mutationFn: async ({ petId, request }: UpsertParams) => {
      await client.postMedication(request, petId);
    },
  });`,
      "hooks/useMedications.ts",
    );
    const screen = source(`
import { useUpsertMedication } from "../hooks/useMedications";
export function Screen({ petId }: Props) {
  const upsert = useUpsertMedication();
  const submit = (days: DayOfWeek[]) => upsert.mutateAsync({ petId, request: { daysOfWeek: days } });
}`);
    expect(find(hook, screen)).toEqual([{ path: "app/medications.ts", line: 5 }]);
  });

  it("follows a destructured mutate function", () => {
    const hook = source(`
export function useUpsertMedication() {
  return useMutation({ mutationFn: (request: AddMedication) => client.postMedication(request) });
}
function Screen() {
  const { mutate: save } = useUpsertMedication();
  save({ daysOfWeek: [] });
}`);
    expect(find(hook)).toEqual([{ path: "app/medications.ts", line: 7 }]);
  });

  it.each([
    ["a nullish fallback to undefined", `client.postMedication({ daysOfWeek: maybe ?? undefined });`],
    ["a spread", `client.postMedication({ ...defaults, daysOfWeek: [] });`],
    ["a missing property", `client.postMedication({ name: "a" });`],
    [
      "an optional parameter",
      `function f(days?: DayOfWeek[]) { client.postMedication({ daysOfWeek: days }); }`,
    ],
    [
      "a nullable parameter",
      `function f(days: DayOfWeek[] | null) { client.postMedication({ daysOfWeek: days }); }`,
    ],
    ["an untyped value", `client.postMedication({ daysOfWeek: form.values.days });`],
    ["an argument it cannot follow", `client.postMedication(buildRequest());`],
    ["a let variable", `let request = { daysOfWeek: [] }; client.postMedication(request);`],
    [
      "the function passed uncalled",
      `client.postMedication({ daysOfWeek: [] }); run(client.postMedication);`,
    ],
    ["no call at all", `const unused = 1;`],
  ])("gives up on %s", (_, text) => {
    expect(find(source(text))).toBeUndefined();
  });

  it("gives up when one of several call sites cannot be proven", () => {
    const text = `
client.postMedication({ daysOfWeek: [] });
client.postMedication({ daysOfWeek: undefined });`;
    expect(find(source(text))).toBeUndefined();
  });

  it("gives up on a body forwarded twice", () => {
    const text = `
const send = (request: AddMedication) => client.postMedication(request);
const relay = (request: AddMedication) => send(request);
relay({ daysOfWeek: [] });`;
    expect(find(source(text))).toBeUndefined();
  });

  it("reads member chains through declared types", () => {
    const text = `
interface Form { days: DayOfWeek[]; note?: string }
function save(form: Form) {
  client.postMedication({ daysOfWeek: form.days });
}`;
    expect(find(source(text))).toEqual([{ path: "app/medications.ts", line: 4 }]);
    const optional = text.replace("form.days", "form.note");
    expect(find(source(optional))).toBeUndefined();
  });
});
