import { describe, expect, it } from "vitest";
import { applySeedAccept, classifySeedFile } from "../../../src/layers/seed/classify.js";
import { readSeedStatements } from "../../../src/layers/seed/seed-statements.js";

const baseTree = { side: "base" as const, ref: "v1", commit: "a".repeat(40) };
const revisionTree = { side: "revision" as const, ref: "v2", commit: "b".repeat(40) };

function classify(
  base: string | null,
  revision: string | null,
  dialect: "postgres" | "sqlserver" = "postgres",
) {
  return classifySeedFile({
    sourceName: "db",
    path: "db/seed.sql",
    base: base === null ? null : readSeedStatements(base, dialect),
    revision: revision === null ? null : readSeedStatements(revision, dialect),
    baseTree,
    revisionTree,
  });
}

const summary = (items: ReturnType<typeof classify>) =>
  items.map(({ finding }) => [finding.id, finding.class, finding.subject]);

const upsert = (...tuples: string[]) =>
  `INSERT INTO "Templates" ("Id", "Type", "Body") VALUES\n${tuples.join(",\n")}\nON CONFLICT ("Id") DO UPDATE SET "Body" = EXCLUDED."Body";`;

describe("classifySeedFile: rows", () => {
  it("reports nothing for identical or reformatted files", () => {
    const seed = upsert("(1, 'A', 'a')", "(2, 'B', 'b')");
    expect(classify(seed, seed)).toEqual([]);
    expect(
      classify(
        seed,
        'INSERT INTO "Templates" ("Id","Type","Body")\nVALUES (2,\'B\',\'b\'), (1,  \'A\',\'a\') ON CONFLICT ("Id") DO UPDATE SET "Body" = EXCLUDED."Body";',
      ),
    ).toEqual([]);
  });

  it("F6: three new keys under DO UPDATE give one safe row-added finding", () => {
    const base = upsert("(1, 'Welcome', 'w')");
    const revision = upsert(
      "(1, 'Welcome', 'w')",
      "(501, 'TermsChange', 't1')",
      "(502, 'TermsChange', 't2')",
      "(503, 'TermsChange', 't3')",
    );
    const findings = classify(base, revision);
    expect(summary(findings)).toEqual([["row-added", "safe", "db/seed.sql: Templates"]]);
    expect(findings[0]?.finding.message).toContain("adds 3 row(s) to Templates (Id 501; 502; 503)");
    expect(findings[0]?.finding.evidence.map((evidence) => evidence.line)).toEqual([3, 4, 5]);
    expect(findings[0]?.finding.evidence[0]).toMatchObject({ side: "revision", path: "db/seed.sql" });
  });

  it("reports a changed value under DO UPDATE and under DO NOTHING", () => {
    expect(summary(classify(upsert("(1, 'A', 'a')"), upsert("(1, 'A', 'changed')")))).toEqual([
      ["row-changed", "needs-action", "db/seed.sql: Templates"],
    ]);
    const ignore = (body: string) => `INSERT INTO t (id, body) VALUES (1, '${body}') ON CONFLICT DO NOTHING;`;
    const findings = classify(ignore("a"), ignore("b"));
    expect(summary(findings)).toEqual([["row-change-ignored", "needs-action", "db/seed.sql: t"]]);
    expect(findings[0]?.finding.message).toContain("id 1");
  });

  it("reports a switch to DO UPDATE, a new column and a changed SET list as changed rows", () => {
    const nothing = "INSERT INTO t (id, a) VALUES (1, 'x') ON CONFLICT (id) DO NOTHING;";
    const update = "INSERT INTO t (id, a) VALUES (1, 'x') ON CONFLICT (id) DO UPDATE SET a = EXCLUDED.a;";
    expect(summary(classify(nothing, update))).toEqual([["row-changed", "needs-action", "db/seed.sql: t"]]);
    const wider =
      "INSERT INTO t (id, a, b) VALUES (1, 'x', 'y') ON CONFLICT (id) DO UPDATE SET a = EXCLUDED.a;";
    expect(summary(classify(update, wider))).toEqual([["row-changed", "needs-action", "db/seed.sql: t"]]);
    const moreSet =
      "INSERT INTO t (id, a) VALUES (1, 'x') ON CONFLICT (id) DO UPDATE SET a = EXCLUDED.a, active = true;";
    expect(summary(classify(update, moreSet))).toEqual([["row-changed", "needs-action", "db/seed.sql: t"]]);
  });

  it("reports a key that is gone as safe with base evidence", () => {
    const findings = classify(upsert("(1, 'A', 'a')", "(2, 'B', 'b')"), upsert("(1, 'A', 'a')"));
    expect(summary(findings)).toEqual([["row-removed", "safe", "db/seed.sql: Templates"]]);
    expect(findings[0]?.finding.evidence[0]).toMatchObject({ side: "base", line: 3 });
  });

  it("reports a key gone from a MERGE that deletes missing rows as row-deleted", () => {
    const merge = (...tuples: string[]) =>
      `MERGE INTO Settings AS tg USING (VALUES ${tuples.join(", ")}) AS s (Id, Name) ON tg.Id = s.Id WHEN MATCHED THEN UPDATE SET Name = s.Name WHEN NOT MATCHED THEN INSERT (Id, Name) VALUES (s.Id, s.Name) WHEN NOT MATCHED BY SOURCE THEN DELETE;`;
    expect(summary(classify(merge("(1, 'a')", "(2, 'b')"), merge("(1, 'a')"), "sqlserver"))).toEqual([
      ["row-deleted", "needs-action", "db/seed.sql: Settings"],
    ]);
  });

  it("reports a BY SOURCE DELETE added to an unchanged MERGE", () => {
    const merge = (extra: string) =>
      `MERGE INTO Settings AS tg USING (VALUES (1, 'a')) AS s (Id, Name) ON tg.Id = s.Id WHEN MATCHED THEN UPDATE SET Name = s.Name WHEN NOT MATCHED THEN INSERT (Id, Name) VALUES (s.Id, s.Name)${extra};`;
    const ids = summary(
      classify(merge(""), merge(" WHEN NOT MATCHED BY SOURCE THEN DELETE"), "sqlserver"),
    ).map(([id]) => id);
    expect(ids).toContain("delete-data");
  });

  it("reports new and changed unguarded rows, and stays silent on unchanged ones", () => {
    const plain = (body: string) => `INSERT INTO t (id, body) VALUES (1, 'same'), (2, '${body}');`;
    expect(classify(plain("a"), plain("a"))).toEqual([]);
    const findings = classify(plain("a"), `${plain("b")}\nINSERT INTO t (id, body) VALUES (3, 'new');`);
    expect(summary(findings)).toEqual([["insert-unguarded", "needs-action", "db/seed.sql: t"]]);
    expect(findings[0]?.finding.message).toContain("2 row(s)");
  });

  it("reports a row added to an IF NOT EXISTS block the base already had", () => {
    const block = (...inserts: string[]) =>
      `IF NOT EXISTS (SELECT 1 FROM Roles)\nBEGIN\n${inserts.join("\n")}\nEND`;
    const one = "INSERT INTO Roles (Id) VALUES (1);";
    const two = "INSERT INTO Roles (Id) VALUES (2);";
    expect(summary(classify(block(one), block(one, two), "sqlserver"))).toEqual([
      ["row-added-skipped", "needs-action", "db/seed.sql: Roles"],
    ]);
    const perRow = (id: number) =>
      `IF NOT EXISTS (SELECT 1 FROM Roles WHERE Id = ${id}) INSERT INTO Roles (Id) VALUES (${id});`;
    expect(summary(classify(perRow(1), `${perRow(1)}\n${perRow(2)}`, "sqlserver"))).toEqual([
      ["row-added", "safe", "db/seed.sql: Roles"],
    ]);
  });

  it("compares rows whole when keys repeat, assuming a change under an upsert", () => {
    const junction = (...tuples: string[]) =>
      `INSERT INTO role_permissions (role_id, permission) VALUES ${tuples.join(", ")} ON CONFLICT DO NOTHING;`;
    expect(summary(classify(junction("(1, 'read')"), junction("(1, 'read')", "(1, 'write')")))).toEqual([
      ["row-added", "safe", "db/seed.sql: role_permissions"],
    ]);
    const upserted = (...tuples: string[]) =>
      `INSERT INTO t (kind, value) VALUES ${tuples.join(", ")} ON CONFLICT ON CONSTRAINT pk DO UPDATE SET value = EXCLUDED.value;`;
    const findings = classify(upserted("(1, 'a')", "(1, 'b')"), upserted("(1, 'a')", "(1, 'c')"));
    expect(summary(findings)).toEqual([
      ["row-changed", "needs-action", "db/seed.sql: t"],
      ["row-removed", "safe", "db/seed.sql: t"],
    ]);
    expect(findings[0]?.finding.message).toContain("cannot be told apart");
  });

  it("lists at most 5 keys and 5 evidence lines", () => {
    const tuples = Array.from({ length: 8 }, (_, index) => `(${index + 10}, 'T', 'b')`);
    const findings = classify(upsert("(1, 'A', 'a')"), upsert("(1, 'A', 'a')", ...tuples));
    expect(findings[0]?.finding.message).toContain("Id 10; 11; 12; 13; 14 and 3 more");
    expect(findings[0]?.finding.evidence).toHaveLength(5);
  });
});

describe("classifySeedFile: other statements and files", () => {
  it("classifies new UPDATE, DELETE and TRUNCATE and ignores ones the base had", () => {
    const base = "UPDATE t SET a = 1 WHERE id = 1;";
    const revision = `${base}\nUPDATE t SET a = 1 WHERE id = 1;\nDELETE FROM s;\nTRUNCATE u;`;
    expect(summary(classify(base, revision))).toEqual([
      ["update-data", "needs-action", "db/seed.sql: t"],
      ["delete-data", "needs-action", "db/seed.sql: s"],
      ["truncate", "needs-action", "db/seed.sql: u"],
    ]);
    expect(classify(revision, base)).toEqual([]);
  });

  it("classifies new query inserts and merges by mode", () => {
    const revision = [
      "INSERT INTO a (id) SELECT id FROM x WHERE NOT EXISTS (SELECT 1 FROM a);",
      "INSERT INTO b (id) SELECT id FROM x ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id;",
      "INSERT INTO c (id) SELECT id FROM x;",
      "MERGE INTO d USING x AS s ON d.id = s.id WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id);",
      "MERGE INTO e USING x AS s ON e.id = s.id WHEN MATCHED THEN UPDATE SET v = s.v WHEN NOT MATCHED BY SOURCE THEN DELETE;",
    ].join("\n");
    expect(summary(classify("", revision)).map(([id, , subject]) => [id, subject])).toEqual([
      ["insert-query-added", "db/seed.sql: a"],
      ["upsert-query", "db/seed.sql: b"],
      ["insert-unguarded", "db/seed.sql: c"],
      ["insert-query-added", "db/seed.sql: d"],
      ["delete-data", "db/seed.sql: e"],
      ["upsert-query", "db/seed.sql: e"],
    ]);
  });

  it("reports an edited guarded query insert as a change existing databases skip", () => {
    const query = (name: string) =>
      `INSERT INTO a (id, name) SELECT 1, '${name}' WHERE NOT EXISTS (SELECT 1 FROM a WHERE id = 1);`;
    expect(summary(classify(query("x"), query("y")))).toEqual([
      ["row-change-ignored", "needs-action", "db/seed.sql: a"],
    ]);
  });

  it("reports a removed file once and treats a new file as all new", () => {
    const removed = classify(upsert("(1, 'A', 'a')"), null);
    expect(summary(removed)).toEqual([["seed-file-removed", "safe", "db/seed.sql: db/seed.sql"]]);
    expect(removed[0]?.finding.evidence[0]).toMatchObject({ side: "base", path: "db/seed.sql" });
    expect(summary(classify(null, upsert("(1, 'A', 'a')")))).toEqual([
      ["row-added", "safe", "db/seed.sql: Templates"],
    ]);
  });
});

describe("applySeedAccept", () => {
  it("accepts by id and by id plus object, and reports unused entries", () => {
    const classified = classify("", "UPDATE t SET a = 1;\nDELETE FROM s;");
    const { findings, usage } = applySeedAccept(classified, [
      { id: "update-data", reason: "reviewed" },
      { id: "delete-data", object: "S", reason: "cleanup" },
      { id: "truncate", reason: "unused" },
    ]);
    expect(findings.map((finding) => [finding.id, finding.class, finding.accepted?.reason])).toEqual([
      ["update-data", "needs-action", "reviewed"],
      ["delete-data", "needs-action", "cleanup"],
    ]);
    expect(usage.map(({ entry, count }) => [entry.id, count])).toEqual([
      ["update-data", 1],
      ["delete-data", 1],
      ["truncate", 0],
    ]);
  });
});
