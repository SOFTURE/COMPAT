import { describe, expect, it } from "vitest";
import { isSamePath } from "../../../src/layers/client-usage/paths.js";
import { readTypescriptClient } from "../../../src/layers/client-usage/read-typescript-client.js";
import {
  type ClientRefUsage,
  readPropertyPath,
  refineFindings,
} from "../../../src/layers/client-usage/refine.js";
import type { Finding } from "../../../src/model/finding.js";
import { createFinding } from "../../helpers/stub-layer.js";

const CLIENT = `
export const client = {
  addMedication(petId: string, body: AddMedication): Promise<void> {
    return fetch(\`/api/pets/\${petId}/medications\`, { method: "POST", body: JSON.stringify(body) });
  },
  updateMedication(petId: string, body?: AddMedication): Promise<void> {
    return fetch(\`/api/pets/\${petId}/medications\`, { method: "PUT", body: JSON.stringify(body) });
  },
};
export interface AddMedication {
  daysOfWeek: number[];
  notes: string | null;
  schedule: Schedule;
}
export interface Schedule {
  times: string[];
  zone?: string;
}
`;

function usage(overrides: Partial<ClientRefUsage> = {}): ClientRefUsage {
  return {
    client: "mobile",
    api: "b2c",
    ref: "2.2.4",
    commit: "c".repeat(40),
    clientPath: "app/client.ts",
    model: readTypescriptClient(CLIENT),
    ...overrides,
  };
}

const finding = (overrides: Partial<Finding>): Finding =>
  createFinding("breaking", { layer: "openapi", scope: "b2c", ...overrides });

const notNullable = (property: string, subject = "POST /api/pets/{PetId}/medications") =>
  finding({
    id: "request-property-became-not-nullable",
    subject,
    message: `the request property \`${property}\` became not nullable`,
  });

describe("refineFindings", () => {
  it("drops a not-nullable finding to safe when the typed body never allows null", () => {
    const { revisions, toSafe } = refineFindings([notNullable("daysOfWeek")], [usage()]);
    expect(toSafe).toBe(1);
    expect(revisions[0]?.finding).toMatchObject({
      class: "safe",
      reclassified: {
        from: "breaking",
        by: "client-usage",
        reason: "`daysOfWeek` is always sent non-null by mobile@2.2.4",
      },
    });
    expect(revisions[0]?.finding.evidence.at(-1)).toEqual({
      side: "client",
      ref: "2.2.4",
      commit: "c".repeat(40),
      path: "app/client.ts",
      line: 11,
    });
  });

  it("keeps a not-nullable finding when the property type allows null", () => {
    const { revisions, withEvidence } = refineFindings([notNullable("notes")], [usage()]);
    expect(withEvidence).toBe(1);
    expect(revisions[0]?.finding.class).toBe("breaking");
    expect(revisions[0]?.finding.message).toBe(
      "the request property `notes` became not nullable; mobile@2.2.4 may send it without `notes` or with null (client-usage)",
    );
  });

  it("walks nested properties through named types", () => {
    const required = (property: string) =>
      finding({
        id: "request-property-became-required",
        subject: "POST /api/pets/{petId}/medications",
        message: `the request property \`${property}\` became required`,
      });
    const [times, zone] = refineFindings(
      [required("schedule/times"), required("schedule/zone")],
      [usage()],
    ).revisions;
    expect(times?.finding.class).toBe("safe");
    expect(zone?.finding.class).toBe("breaking");
  });

  it("keeps a property finding when the body parameter is optional", () => {
    const { revisions } = refineFindings(
      [notNullable("daysOfWeek", "PUT /api/pets/{petId}/medications")],
      [usage()],
    );
    expect(revisions[0]?.finding.class).toBe("breaking");
  });

  it("needs every calling ref of every client of the API to send the property", () => {
    const old = usage({
      ref: "2.0.1",
      model: readTypescriptClient(CLIENT.replace("daysOfWeek:", "daysOfWeek?:")),
    });
    const { revisions } = refineFindings(
      [
        finding({
          id: "request-property-became-required",
          subject: "POST /api/pets/{petId}/medications",
          message: "the request property `daysOfWeek` became required",
        }),
      ],
      [old, usage(), usage({ client: "admin", ref: "1.0.0" })],
    );
    expect(revisions[0]?.finding.class).toBe("breaking");
    expect(revisions[0]?.finding.message).toContain(
      "; mobile@2.0.1 may send it without `daysOfWeek` (client-usage)",
    );
  });

  describe("a property under allOf (issue #70)", () => {
    const allOf = notNullable("allOf[subschema #2]/daysOfWeek");
    const intersection = (daysOfWeek: string) => `
export const addMedication = (petId: string, body: AddMedication) =>
  fetch(\`/api/pets/\${petId}/medications\`, { method: "POST", body: JSON.stringify(body) });
export type AddMedication = MedicationBase & { ${daysOfWeek} };
export interface MedicationBase { name: string }
`;

    it("drops the finding to safe when the flattened body always sends the property", () => {
      const { revisions } = refineFindings([allOf], [usage()]);
      expect(revisions[0]?.finding).toMatchObject({
        class: "safe",
        reclassified: { reason: "`allOf[subschema #2]/daysOfWeek` is always sent non-null by mobile@2.2.4" },
      });
    });

    it("drops the finding to safe when an intersection body always sends the property", () => {
      const model = readTypescriptClient(intersection("daysOfWeek: DayOfWeek[]"));
      expect(refineFindings([allOf], [usage({ model })]).revisions[0]?.finding.class).toBe("safe");
    });

    it("keeps the class and names the refs when the property is optional", () => {
      const model = readTypescriptClient(intersection("daysOfWeek?: DayOfWeek[]"));
      const { revisions } = refineFindings([allOf], [usage({ model })]);
      expect(revisions[0]?.finding.class).toBe("breaking");
      expect(revisions[0]?.finding.message).toBe(
        "the request property `allOf[subschema #2]/daysOfWeek` became not nullable; mobile@2.2.4 may send it without `allOf[subschema #2]/daysOfWeek` or with null (client-usage)",
      );
    });

    it("keeps the class under oneOf or anyOf, which cannot be proven always sent", () => {
      const findings = [
        notNullable("oneOf[subschema #1]/daysOfWeek"),
        notNullable("anyOf[subschema #1]/daysOfWeek"),
      ];
      const { revisions } = refineFindings(findings, [usage()]);
      expect(revisions.map((revision) => revision.finding.class)).toEqual(["breaking", "breaking"]);
    });
  });

  describe("call sites that always send the property (issue #75)", () => {
    const allOf = notNullable("allOf[subschema #2]/daysOfWeek");
    const GENERATED = `
export const petsClient = {
  postMedicationEndpoint(body: AddMedicationRequest, petId: string): Promise<void> {
    return fetch(\`/api/pets/\${petId}/medications\`, { method: "POST", body: JSON.stringify(body) });
  },
};
export interface AddMedicationRequest { name: string; daysOfWeek?: DayOfWeek[] }
`;
    const model = readTypescriptClient(GENERATED);
    const withSources = (...texts: string[]) =>
      usage({
        model,
        sourceIdentifiers: new Set(["postMedicationEndpoint"]),
        sources: texts.map((text, index) => ({ path: `app/screen${index}.tsx`, text })),
      });

    it("drops the finding to safe when the only literal always sets the property", () => {
      const screen = `
function save(petId: string, weekdays: boolean, days: DayOfWeek[]) {
  return petsClient.postMedicationEndpoint({ name: "a", daysOfWeek: weekdays ? days : [] }, petId);
}`;
      const { revisions } = refineFindings([allOf], [withSources(screen)]);
      expect(revisions[0]?.finding).toMatchObject({
        class: "safe",
        reclassified: {
          reason:
            "`allOf[subschema #2]/daysOfWeek` is always sent non-null by the call sites of mobile@2.2.4",
        },
      });
      expect(revisions[0]?.finding.evidence.at(-1)).toEqual({
        side: "client",
        ref: "2.2.4",
        commit: "c".repeat(40),
        path: "app/screen0.tsx",
        line: 3,
      });
    });

    it("drops the finding to safe when the body is forwarded through mutationFn", () => {
      const hook = `
export const useUpsertMedication = () =>
  useMutation({
    mutationFn: async ({ petId, request }: UpsertParams) => {
      await petsClient.postMedicationEndpoint(request, petId);
    },
  });`;
      const screen = `
function Screen({ petId }: Props) {
  const upsert = useUpsertMedication();
  const submit = (weekdays: boolean, days: DayOfWeek[]) =>
    upsert.mutateAsync({ petId, request: { name: "a", daysOfWeek: weekdays ? days : [] } });
}`;
      const { revisions } = refineFindings([allOf], [withSources(hook, screen)]);
      expect(revisions[0]?.finding.class).toBe("safe");
      expect(revisions[0]?.finding.evidence.at(-1)).toMatchObject({ path: "app/screen1.tsx", line: 5 });
    });

    it.each([
      ["may be undefined", "{ name: 'a', daysOfWeek: maybe ?? undefined }"],
      ["spreads another object", "{ ...defaults, daysOfWeek: [] }"],
      ["passes a value it cannot follow", "buildRequest()"],
    ])("keeps the class and names the ref when the call site %s", (_, body) => {
      const screen = `petsClient.postMedicationEndpoint(${body}, petId);`;
      const { revisions } = refineFindings([allOf], [withSources(screen)]);
      expect(revisions[0]?.finding.class).toBe("breaking");
      expect(revisions[0]?.finding.message).toContain("; mobile@2.2.4 may send it without");
    });
  });

  it("drops an operation no client ref calls to safe and lists every ref", () => {
    const { revisions } = refineFindings(
      [finding({ id: "api-path-removed-without-deprecation", subject: "DELETE /api/pets/{petId}" })],
      [usage({ ref: "2.0.1" }), usage(), usage({ client: "admin", ref: "1.0.0" })],
    );
    expect(revisions[0]?.finding.reclassified?.reason).toBe("not called by mobile@2.0.1, 2.2.4; admin@1.0.0");
    expect(revisions[0]?.finding.evidence.filter((item) => item.side === "client")).toHaveLength(3);
  });

  it("marks a finding called only by clients deployed with the server as a stale bundle gap", () => {
    const removed = finding({
      id: "api-path-removed-without-deprecation",
      subject: "POST /api/pets/{petId}/medications",
    });
    const coDeployed = refineFindings([removed], [usage({ deployedWith: "revision" })]).revisions[0]?.finding;
    expect(coDeployed?.class).toBe("breaking");
    expect(coDeployed?.message).toBe(
      `${removed.message}; called by mobile@2.2.4 (client-usage); stale bundle only: the client deploys with the server, so only tabs opened before the deploy run these builds`,
    );
    const mixed = refineFindings(
      [removed],
      [usage({ deployedWith: "revision" }), usage({ client: "admin", ref: "1.0.0" })],
    ).revisions[0]?.finding;
    expect(mixed?.message).not.toContain("stale bundle only");
  });

  it("counts a path without a readable method as called with every method", () => {
    const model = readTypescriptClient('export const ROUTE = "/api/pets/{id}";');
    const { revisions } = refineFindings(
      [finding({ id: "api-path-removed-without-deprecation", subject: "DELETE /api/pets/{petId}" })],
      [usage({ model })],
    );
    expect(revisions[0]?.finding.class).toBe("breaking");
    expect(revisions[0]?.finding.message).toContain("called by mobile@2.2.4");
  });

  it("uses sources to tell called functions from generated ones", () => {
    const subject = "POST /api/pets/{petId}/medications";
    const removed = finding({ id: "api-path-removed-without-deprecation", subject });
    expect(
      refineFindings([removed], [usage({ sourceIdentifiers: new Set(["other"]) })]).revisions[0]?.finding
        .class,
    ).toBe("safe");
    expect(
      refineFindings([removed], [usage({ sourceIdentifiers: new Set(["addMedication"]) })]).revisions[0]
        ?.finding.class,
    ).toBe("breaking");
  });

  it("leaves accepted, safe, other-API, other-layer and non-operation findings alone", () => {
    const findings = [
      finding({ subject: "DELETE /x", accepted: { reason: "reviewed" } }),
      finding({ subject: "DELETE /x", class: "safe" }),
      finding({ subject: "DELETE /x", scope: "admin" }),
      finding({ subject: "DELETE /x", layer: "seed" }),
      finding({ id: "api-removed", subject: "api/b2c.yaml" }),
    ];
    expect(refineFindings(findings, [usage()])).toEqual({ revisions: [], toSafe: 0, withEvidence: 0 });
  });

  it("keeps the index of the finding it revises", () => {
    const findings = [finding({ subject: "DELETE /x", class: "safe" }), finding({ subject: "DELETE /x" })];
    expect(refineFindings(findings, [usage()]).revisions.map((revision) => revision.index)).toEqual([1]);
  });
});

describe("readPropertyPath", () => {
  it.each([
    ["the request property `a/b` became required", ["a", "b"]],
    ["the request property `daysOfWeek` became not nullable", ["daysOfWeek"]],
    ["api path removed without deprecation", undefined],
  ])("%s", (message, expected) => {
    expect(readPropertyPath(message)).toEqual(expected);
  });
});

describe("isSamePath", () => {
  it.each([
    ["/api/pets/{}", "/api/pets/{}", true],
    ["/pets/{}", "/api/pets/{}", true],
    ["/api/pets/{}", "/pets/{}", true],
    ["/api/pets", "/api/pets/{}", false],
    ["/{}", "/api/pets/{}", false],
    ["/apipets", "/api/pets", false],
  ])("%s against %s is %s", (client, spec, expected) => {
    expect(isSamePath(client, spec)).toBe(expected);
  });
});
