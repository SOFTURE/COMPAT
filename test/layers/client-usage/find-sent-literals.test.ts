import { describe, expect, it } from "vitest";
import { findSentLiterals, type SourceFile } from "../../../src/layers/client-usage/find-sent-literals.js";
import { err, ok } from "../../../src/result.js";

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
    expect(find(source(`client.postMedication({ name: "a", daysOfWeek: [] }, petId);`))).toEqual(
      ok([{ path: "app/medications.ts", line: 1 }]),
    );
  });

  it("accepts a conditional whose branches are a typed parameter and a literal", () => {
    const text = `
function save(petId: string, weekdays: boolean, days: DayOfWeek[]) {
  return client.postMedication(
    { daysOfWeek: weekdays ? days : [] },
    petId,
  );
}`;
    expect(find(source(text))).toEqual(ok([{ path: "app/medications.ts", line: 4 }]));
  });

  it("accepts a local const initialised with a literal", () => {
    const text = `
async function save(petId: string) {
  const request = { daysOfWeek: [1, 2] as DayOfWeek[] };
  await client.postMedication(request, petId);
}`;
    expect(find(source(text))).toEqual(ok([{ path: "app/medications.ts", line: 3 }]));
  });

  it("follows a body forwarded through a named function", () => {
    const text = `
const send = (request: AddMedication, petId: string) => client.postMedication(request, petId);
send({ daysOfWeek: [] }, "1");
send({ daysOfWeek: ["monday"] }, "2");`;
    expect(find(source(text))).toEqual(
      ok([
        { path: "app/medications.ts", line: 3 },
        { path: "app/medications.ts", line: 4 },
      ]),
    );
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
    expect(find(hook, screen)).toEqual(ok([{ path: "app/medications.ts", line: 5 }]));
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
    expect(find(hook)).toEqual(ok([{ path: "app/medications.ts", line: 7 }]));
  });

  const stop = (reason: string, line?: number) =>
    err(
      line === undefined
        ? { reason }
        : { reason: `${reason} at app/medications.ts:${line}`, site: { path: "app/medications.ts", line } },
    );

  it.each([
    [
      "a nullish fallback to undefined",
      `client.postMedication({ daysOfWeek: maybe ?? undefined });`,
      stop("cannot prove maybe ?? undefined non-null", 1),
    ],
    [
      "a spread",
      `client.postMedication({ ...defaults, daysOfWeek: [] });`,
      stop("cannot prove daysOfWeek is set", 1),
    ],
    [
      "a missing property",
      `client.postMedication({ name: "a" });`,
      stop("cannot prove daysOfWeek is set", 1),
    ],
    [
      "an optional parameter",
      `function f(days?: DayOfWeek[]) { client.postMedication({ daysOfWeek: days }); }`,
      stop("cannot prove days non-null", 1),
    ],
    [
      "a nullable parameter",
      `function f(days: DayOfWeek[] | null) { client.postMedication({ daysOfWeek: days }); }`,
      stop("cannot prove days non-null", 1),
    ],
    [
      "an untyped value",
      `client.postMedication({ daysOfWeek: form.values.days });`,
      stop("cannot prove form.values.days non-null", 1),
    ],
    [
      "an argument it cannot follow",
      `client.postMedication(buildRequest());`,
      stop("cannot follow the body argument", 1),
    ],
    [
      "a let variable",
      `let request = { daysOfWeek: [] }; client.postMedication(request);`,
      stop("cannot follow the body argument", 1),
    ],
    [
      "the function passed uncalled",
      `client.postMedication({ daysOfWeek: [] }); run(client.postMedication);`,
      stop("postMedication is used without a call", 1),
    ],
    ["no call at all", `const unused = 1;`, stop("no call of postMedication in sources")],
  ])("stops on %s and says where", (_, text, expected) => {
    expect(find(source(text))).toEqual(expected);
  });

  it("stops when one of several call sites cannot be proven", () => {
    const text = `
client.postMedication({ daysOfWeek: [] });
client.postMedication({ daysOfWeek: undefined });`;
    expect(find(source(text))).toEqual(stop("cannot prove undefined non-null", 3));
  });

  it("stops on a body forwarded twice and names the function", () => {
    const text = `
const send = (request: AddMedication) => client.postMedication(request);
const relay = (request: AddMedication) => send(request);
relay({ daysOfWeek: [] });`;
    expect(find(source(text))).toEqual(
      err({
        reason: "cannot follow request past relay (app/medications.ts:3)",
        site: { path: "app/medications.ts", line: 3 },
      }),
    );
  });

  describe("a generated client inside the sources (issue #82)", () => {
    const generated = source(
      `
export class MedicationsClient {
  constructor(private readonly axios: AxiosInstance) {}

  postMedication(addMedicationRequest: AddMedicationRequest, petId: PetId, $config?: AxiosRequestConfig): AxiosPromise<MedicationScheduleId> {
    return this.axios.request({ url: \`/api/pets/\${petId}/medications\`, method: "POST", data: addMedicationRequest, ...$config });
  }

  public async putMedication(body: UpdateMedicationRequest): Promise<void> {
    await this.axios.put("/api/medications", body);
  }
}`,
      "services/api/petseo.client.ts",
    );

    it("does not read a method declared with a return type as a call", () => {
      const screen = source(`client.postMedication({ name: "a", daysOfWeek: [] }, petId);`);
      expect(find(generated, screen)).toEqual(ok([{ path: "app/medications.ts", line: 1 }]));
    });

    it("still stops on a real call whose argument it cannot follow", () => {
      const screen = source(`client.postMedication(buildRequest(), petId);`);
      expect(find(generated, screen)).toEqual(stop("cannot follow the body argument", 1));
    });

    it("keeps a call in a conditional branch followed by a colon", () => {
      const screen = source(`const run = flag ? client.postMedication(request) : undefined;`);
      expect(find(screen)).toEqual(stop("cannot follow the body argument", 1));
    });
  });

  it("reads member chains through declared types", () => {
    const text = `
interface Form { days: DayOfWeek[]; note?: string }
function save(form: Form) {
  client.postMedication({ daysOfWeek: form.days });
}`;
    expect(find(source(text))).toEqual(ok([{ path: "app/medications.ts", line: 4 }]));
    const optional = text.replace("form.days", "form.note");
    expect(find(source(optional))).toEqual(stop("cannot prove form.note non-null", 4));
  });

  describe("members typed by a zod schema (issue #83)", () => {
    const schema = (days: string, side = "output") =>
      source(
        `
import { z } from "zod";
export const medicationSchema = z.object({
  name: z.string().min(1),
  days: ${days},
}).superRefine((value, ctx) => {});
export type MedicationFormData = z.${side}<typeof medicationSchema>;`,
        "schemas/medication.schema.ts",
      );
    const screen = source(`
const onSubmit = async (data: MedicationFormData) => {
  await client.postMedication({ daysOfWeek: data.frequencyMode === "weekdays" ? data.days : [] });
};`);

    it.each([
      ["z.output and a default", "z.array(z.string()).default([])", "output"],
      ["z.infer and a required member", "z.array(z.nativeEnum(DayOfWeek))", "infer"],
      ["an optional member with a default", "z.array(z.string()).optional().default([])", "output"],
    ])("proves a member read through %s", (_, days, side) => {
      expect(find(schema(days, side), screen)).toEqual(ok([{ path: "app/medications.ts", line: 3 }]));
    });

    it.each([
      ["z.input, where a default leaves the member optional", "z.array(z.string()).default([])", "input"],
      ["an optional member", "z.array(z.string()).optional()", "output"],
      ["a nullable member", "z.array(z.string()).nullable().default([])", "output"],
      ["a transformed member", 'z.string().transform((value) => value.split(","))', "output"],
      ["a union", "z.union([z.array(z.string()), z.null()])", "output"],
    ])("stops on %s", (_, days, side) => {
      expect(find(schema(days, side), screen)).toEqual(
        stop(`cannot prove data.frequencyMode === "weekdays" ? data.days : [] non-null`, 3),
      );
    });

    describe("derived from another schema const (issue #92)", () => {
      const derived = (chain: string, side = "output") =>
        source(
          `
import { z } from "zod";
export const medicationObjectSchema = z.object({
  days: z.array(z.string()).default([]),
});
${chain}
export type MedicationFormData = z.${side}<typeof medicationSchema>;`,
          "schemas/medication.schema.ts",
        );
      const stopped = stop(`cannot prove data.frequencyMode === "weekdays" ? data.days : [] non-null`, 3);

      it.each([
        [
          "one refinement",
          "export const medicationSchema = medicationObjectSchema.superRefine((data, ctx) => {});",
        ],
        [
          "two hops",
          `const refinedSchema = medicationObjectSchema.refine((data) => true);
export const medicationSchema = refinedSchema.superRefine((data, ctx) => {});`,
        ],
      ])("proves a member read through %s", (_, chain) => {
        expect(find(derived(chain), screen)).toEqual(ok([{ path: "app/medications.ts", line: 3 }]));
      });

      it.each([
        ["a partial schema", "export const medicationSchema = medicationObjectSchema.partial();", "output"],
        [
          "an extended schema",
          "export const medicationSchema = medicationObjectSchema.extend({});",
          "output",
        ],
        [
          "a call on the base",
          "export const medicationSchema = medicationObjectSchema.superRefine(check)(x);",
          "output",
        ],
        [
          "z.input and a default",
          "export const medicationSchema = medicationObjectSchema.superRefine(check);",
          "input",
        ],
        [
          "a cycle",
          `const medicationSchema = otherSchema.refine(check);
const otherSchema = medicationSchema.refine(check);`,
          "output",
        ],
      ])("stops on %s", (_, chain, side) => {
        expect(find(derived(chain, side), screen)).toEqual(stopped);
      });
    });

    it("stops when the schema spreads another shape", () => {
      const spread = schema("z.array(z.string()), ...base.shape");
      expect(find(spread, screen)).toEqual(
        stop(`cannot prove data.frequencyMode === "weekdays" ? data.days : [] non-null`, 3),
      );
    });
  });
});
