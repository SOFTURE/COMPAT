import { describe, expect, it } from "vitest";
import {
  applyAccept,
  type ClassifiedFinding,
  classifyMigrations,
  getBaseExplicitIds,
  type Migration,
} from "../../../src/layers/sql-migrations/classify.js";
import { type SqlDialect, splitStatements } from "../../../src/sql/statements.js";

const REVISION = { side: "revision" as const, ref: "v2", commit: "c".repeat(40) };

function migration(id: string, sql: string, dialect: SqlDialect = "postgres"): Migration {
  return { id, path: `db/${id}.sql`, statements: splitStatements(sql, dialect) };
}

function classify(
  migrations: Migration[],
  options: { dialect?: SqlDialect; baseTables?: string[] } = {},
): ClassifiedFinding[] {
  return classifyMigrations({
    sourceName: "app",
    dialect: options.dialect ?? "postgres",
    migrations,
    baseTables: new Set(options.baseTables ?? []),
    revision: REVISION,
  });
}

const summary = (items: ClassifiedFinding[]) =>
  items.map(({ finding }) => `${finding.id} ${finding.class} ${finding.subject}`);

describe("classifyMigrations", () => {
  it("makes indexes and foreign keys on a table created by the new migrations safe", () => {
    const items = classify([
      migration(
        "0002",
        [
          'CREATE TABLE "Flags" ("Id" uuid NOT NULL, "Key" text NOT NULL);',
          'CREATE UNIQUE INDEX "IX_Flags_Key" ON "Flags" ("Key");',
          'ALTER TABLE "Flags" ADD CONSTRAINT "FK_x" FOREIGN KEY ("Id") REFERENCES "Owners" ("Id");',
          'CREATE UNIQUE INDEX "IX_Owners_Mail" ON "Owners" ("Mail");',
        ].join("\n"),
      ),
    ]);
    expect(summary(items)).toEqual([
      "create-table safe 0002: Flags",
      "add-unique-index safe 0002: Flags",
      "add-constraint safe 0002: Flags",
      "add-unique-index needs-action 0002: Owners",
    ]);
    expect(items[1]?.finding.message).toBe(
      "adds a unique index on Flags; the table is created by these migrations, so no old build uses it",
    );
    expect(items[3]?.finding.evidence).toEqual([{ ...REVISION, path: "db/0002.sql", line: 4 }]);
  });

  it("describes safe follow-ups on a new table without the original rule's risk text", () => {
    const items = classify([
      migration(
        "0002",
        [
          'CREATE TABLE "Flags" ("Id" int NOT NULL, "Key" text NOT NULL);',
          'CREATE UNIQUE INDEX "IX_Flags_Key" ON "Flags" ("Key");',
          'INSERT INTO "Flags" ("Id", "Key") VALUES (1, \'a\');',
          'INSERT INTO "Flags" ("Id", "Key") VALUES (2, \'b\');',
        ].join("\n"),
      ),
    ]);
    expect(summary(items)).toEqual([
      "create-table safe 0002: Flags",
      "add-unique-index safe 0002: Flags",
      "insert-explicit-id safe 0002: Flags",
    ]);
    expect(items[2]?.finding.message).toBe(
      "inserts rows with explicit ids into Flags; the table is created by these migrations, so no old build uses it",
    );
    for (const { finding } of items.slice(1)) {
      expect(finding.message).not.toMatch(/start failing|precondition/);
    }
  });

  it("keeps a drop and recreate of an existing table breaking", () => {
    const items = classify([
      migration(
        "0002",
        'DROP TABLE "Pets";\nCREATE TABLE "Pets" ("Id" int);\nCREATE UNIQUE INDEX i ON "Pets" ("Id");',
      ),
    ]);
    expect(summary(items)).toEqual([
      "drop-table breaking 0002: Pets",
      "create-table safe 0002: Pets",
      "add-unique-index needs-action 0002: Pets",
    ]);
  });

  it("does not treat CREATE TABLE IF NOT EXISTS of a base table as new", () => {
    const sql = 'CREATE TABLE IF NOT EXISTS "Pets" ("Id" int);\nCREATE UNIQUE INDEX i ON "Pets" ("Id");';
    expect(summary(classify([migration("0002", sql)], { baseTables: ["public.pets"] }))[1]).toBe(
      "add-unique-index needs-action 0002: Pets",
    );
    expect(summary(classify([migration("0002", sql)]))[1]).toBe("add-unique-index safe 0002: Pets");
  });

  it("follows a rename of a table created by the new migrations", () => {
    const items = classify([
      migration("0002", 'CREATE TABLE "a" ("id" int);'),
      migration("0003", 'ALTER TABLE "a" RENAME TO "b";\nCREATE UNIQUE INDEX i ON "b" ("id");'),
    ]);
    expect(summary(items)).toEqual([
      "create-table safe 0002: a",
      "rename-table safe 0003: a",
      "add-unique-index safe 0003: b",
    ]);
  });

  it("reports a dropped view that is created again as a redefinition", () => {
    const items = classify([
      migration("0002", "DROP VIEW v_pets;\nCREATE OR REPLACE VIEW v_pets AS SELECT 1;\nDROP VIEW v_old;"),
    ]);
    expect(summary(items)).toEqual([
      "object-redefined needs-action 0002: v_pets",
      "drop-object breaking 0002: v_old",
    ]);
  });

  it("merges single-row explicit-id inserts into one finding per migration and table", () => {
    const sql = [1, 2, 3]
      .map((id) => `INSERT INTO "Breeds" ("Id", "Name") VALUES (${id}, 'b${id}');`)
      .join("\n");
    const items = classify([
      migration("0002", sql),
      migration("0003", 'INSERT INTO "Breeds" ("Id") VALUES (9);'),
    ]);
    expect(summary(items)).toEqual([
      "insert-explicit-id needs-action 0002: Breeds",
      "insert-explicit-id needs-action 0003: Breeds",
    ]);
    expect(items[0]?.finding.message).toContain("inserts 3 row(s) into Breeds with explicit Id 1-3");
    expect(items[0]?.finding.evidence[0]?.line).toBe(1);
  });

  describe("sequence reset after explicit-id inserts", () => {
    const INSERTS = [
      'INSERT INTO s."T" ("Id", "Name") VALUES (418, \'a\');',
      'INSERT INTO s."T" ("Id", "Name") VALUES (496, \'b\');',
    ].join("\n");
    const EF_SETVAL = [
      "DO $EF$",
      "BEGIN",
      '    IF NOT EXISTS(SELECT 1 FROM "__EFMigrationsHistory" WHERE "MigrationId" = \'0002\') THEN',
      "    PERFORM setval(",
      "        pg_get_serial_sequence('s.\"T\"', 'Id'),",
      "        GREATEST(",
      '            (SELECT MAX("Id") FROM s."T") + 1,',
      "            nextval(pg_get_serial_sequence('s.\"T\"', 'Id'))),",
      "        false);",
      "    END IF;",
      "END $EF$;",
    ].join("\n");

    it("keeps only the max(Id) precondition when an EF setval follows the inserts", () => {
      const items = classify([migration("0002", `${INSERTS}\n${EF_SETVAL}`)]);
      expect(summary(items)).toEqual(["insert-explicit-id needs-action 0002: s.T"]);
      expect(items[0]?.finding.message).toBe(
        "inserts 2 row(s) into s.T with explicit Id 418-496; precondition: production max(Id) < 418; the migration moves the identity sequence past them",
      );
      expect(items[0]?.finding.evidence).toEqual([
        { ...REVISION, path: "db/0002.sql", line: 1 },
        { ...REVISION, path: "db/0002.sql", line: 6 },
      ]);
    });

    it("keeps today's message without a setval", () => {
      const items = classify([migration("0002", INSERTS)]);
      expect(items[0]?.finding.message).toBe(
        "inserts 2 row(s) into s.T with explicit Id 418-496; precondition: production max(Id) < 418, and the identity sequence must continue after 496",
      );
      expect(items[0]?.finding.evidence).toHaveLength(1);
    });

    it("ignores a setval on another table or before the inserts", () => {
      const other = EF_SETVAL.replaceAll('s."T"', 's."U"');
      for (const sql of [`${INSERTS}\n${other}`, `${EF_SETVAL}\n${INSERTS}`]) {
        const items = classify([migration("0002", sql)]);
        expect(items[0]?.finding.message).toContain("the identity sequence must continue after 496");
        expect(items[0]?.finding.evidence).toHaveLength(1);
      }
    });

    it("accepts a literal restart above the last id and rejects one that is not", () => {
      const message = (reset: string) =>
        classify([migration("0002", `${INSERTS}\n${reset}`)])[0]?.finding.message ?? "";
      expect(message('ALTER SEQUENCE s."T_Id_seq" RESTART WITH 497;')).toContain(
        "moves the identity sequence",
      );
      expect(message('ALTER TABLE s."T" ALTER COLUMN "Id" RESTART WITH 497;')).toContain(
        "moves the identity sequence",
      );
      expect(message("SELECT setval('s.\"T_Id_seq\"', 496);")).toContain("moves the identity sequence");
      expect(message("SELECT setval('s.\"T_Id_seq\"', 496, false);")).toContain(
        "the identity sequence must continue after 496",
      );
      expect(message('ALTER SEQUENCE s."T_Id_seq" RESTART;')).toContain(
        "the identity sequence must continue after 496",
      );
    });
  });

  it("applies IDENTITY_INSERT only within the same migration", () => {
    const identity = migration(
      "A",
      "IF EXISTS (SELECT * FROM [sys].[identity_columns] WHERE [object_id] = OBJECT_ID(N'[Breeds]'))\n    SET IDENTITY_INSERT [Breeds] ON;\nINSERT INTO [Breeds] ([No]) VALUES (1);",
      "sqlserver",
    );
    const later = migration("B", "INSERT INTO [Breeds] ([No]) VALUES (2);", "sqlserver");
    expect(summary(classify([identity, later], { dialect: "sqlserver" }))).toEqual([
      "insert-explicit-id needs-action A: Breeds",
    ]);
  });

  it("reports nested EXEC statements at the line of the EXEC", () => {
    const items = classify(
      [
        migration(
          "A",
          "SELECT 1;\nIF SCHEMA_ID(N'system') IS NULL EXEC(N'CREATE SCHEMA [system];\nDROP TABLE [x];');",
          "sqlserver",
        ),
      ],
      { dialect: "sqlserver" },
    );
    expect(items.map(({ finding }) => [finding.id, finding.evidence[0]?.line])).toEqual([
      ["create-schema", 2],
      ["drop-table", 2],
    ]);
  });

  it("matches statements inside a drizzle DO block at their own line", () => {
    const sql = [
      'CREATE TABLE "a" ("id" serial);',
      "--> statement-breakpoint",
      "DO $$ BEGIN",
      ' ALTER TABLE "b" ADD CONSTRAINT "fk" FOREIGN KEY ("a_id") REFERENCES "a"("id");',
      "EXCEPTION",
      " WHEN duplicate_object THEN null;",
      "END $$;",
    ].join("\n");
    const items = classify([migration("0002", sql)]);
    expect(items.map(({ finding }) => [finding.id, finding.class, finding.evidence[0]?.line])).toEqual([
      ["create-table", "safe", 1],
      ["add-constraint", "needs-action", 4],
    ]);
  });

  it("reads EF Npgsql EnsureSchema inside a guard body", () => {
    const body =
      "IF NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'system') THEN\n    CREATE SCHEMA system;\nEND IF;";
    expect(summary(classify([migration("Init", body)]))).toEqual(["create-schema safe Init: system"]);
  });
});

describe("classifyMigrations wrappers and order (impl review)", () => {
  it.each([
    [
      "RAISE EXCEPTION before the statement",
      "DO $$ BEGIN IF EXISTS (SELECT 1 FROM x) THEN RAISE EXCEPTION 'no'; END IF; DROP TABLE \"Pets\"; END $$;",
    ],
    ["LANGUAGE after the body", 'DO $$ BEGIN DROP TABLE "Pets"; END $$ LANGUAGE plpgsql;'],
    ["an ELSE branch", 'DO $$ BEGIN IF x THEN SELECT 1; ELSE DROP TABLE "Pets"; END IF; END $$;'],
  ])("finds a DROP TABLE in a DO block with %s", (_name, sql) => {
    expect(summary(classify([migration("0002", sql)]))).toEqual(["drop-table breaking 0002: Pets"]);
  });

  it("unwraps an EXEC literal that starts with SET IDENTITY_INSERT", () => {
    const sql = "EXEC(N'SET IDENTITY_INSERT [T] ON; INSERT INTO [T] ([Id]) VALUES (1); DROP TABLE [X]');";
    expect(summary(classify([migration("A", sql, "sqlserver")], { dialect: "sqlserver" }))).toEqual([
      "insert-explicit-id needs-action A: T",
      "drop-table breaking A: X",
    ]);
  });

  it("keeps a view that is created and then dropped a breaking drop", () => {
    const items = classify([
      migration("0002", "CREATE OR REPLACE VIEW v AS SELECT 1;"),
      migration("0003", "DROP VIEW v;"),
    ]);
    expect(summary(items)).toEqual(["drop-object breaking 0003: v"]);
  });

  it("stops treating inserts as explicit ids after IDENTITY_INSERT OFF", () => {
    const sql = [
      "SET IDENTITY_INSERT [T] ON;",
      "INSERT INTO [T] ([Id], [N]) VALUES (418, 'a');",
      "SET IDENTITY_INSERT [T] OFF;",
      "INSERT INTO [T] ([N]) VALUES ('b');",
    ].join("\n");
    const items = classify([migration("A", sql, "sqlserver")], { dialect: "sqlserver" });
    expect(items.map(({ finding }) => finding.message)).toEqual([expect.stringContaining("max(Id) < 418")]);
  });

  it("merges 150,000 single-row inserts quickly", () => {
    const sql = Array.from(
      { length: 150_000 },
      (_, index) => `INSERT INTO "B" ("Id") VALUES (${index + 1});`,
    ).join("\n");
    const started = performance.now();
    const items = classify([migration("0002", sql)]);
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(items.map(({ finding }) => finding.message)).toEqual([
      expect.stringContaining("150000 row(s) into B with explicit Id 1-150000"),
    ]);
  });

  it("reads one insert with 200,000 tuples without overflowing the stack", () => {
    const values = Array.from({ length: 200_000 }, (_, index) => `(${index + 1})`).join(", ");
    const items = classify([migration("0002", `INSERT INTO "B" ("Id") VALUES ${values};`)]);
    expect(items[0]?.finding.message).toContain("200000 row(s) into B with explicit Id 1-200000");
  });
});

describe("applyAccept", () => {
  const items = classify([
    migration("0002", 'ALTER TABLE "Pets" DROP COLUMN "A";\nALTER TABLE "Pets" DROP COLUMN "B";'),
  ]);

  it("accepts by rule and migration, keeping the class", () => {
    const { findings, usage } = applyAccept(items, [
      { id: "drop-column", migration: "0002", reason: "unused since 2.1" },
    ]);
    expect(findings.map((finding) => [finding.class, finding.accepted?.reason])).toEqual([
      ["breaking", "unused since 2.1"],
      ["breaking", "unused since 2.1"],
    ]);
    expect(usage[0]?.count).toBe(2);
  });

  it("narrows by object, case-insensitively, and reports unused entries", () => {
    const { findings, usage } = applyAccept(items, [
      { id: "drop-column", migration: "0002", object: "pets.a", reason: "r" },
      { id: "drop-column", migration: "0003", reason: "wrong migration" },
    ]);
    expect(findings.map((finding) => finding.accepted !== undefined)).toEqual([true, false]);
    expect(usage.map(({ count }) => count)).toEqual([1, 0]);
  });
});

describe("getBaseExplicitIds", () => {
  it("keeps the highest integer id per table with its line, unread ids and the first sequence reset", () => {
    const tables = getBaseExplicitIds(
      [
        migration(
          "0001",
          [
            'INSERT INTO dictionaries."PetBreeds" ("Id", "Name") VALUES (1, \'a\'), (417, \'b\');',
            'INSERT INTO dictionaries."PetBreeds" ("Id", "Name") VALUES (12, \'c\');',
            'INSERT INTO "Pets" ("Id", "Name") SELECT "Id", "Name" FROM "Old";',
            'INSERT INTO "Owners" ("Name") VALUES (\'x\');',
          ].join("\n"),
        ),
        migration(
          "0002",
          `SELECT setval(pg_get_serial_sequence('"Pets"', 'Id'), 5);\nALTER SEQUENCE "Pets_Id_seq" RESTART WITH 9;`,
        ),
      ],
      "postgres",
    );
    expect([...tables]).toEqual([
      [
        "dictionaries.petbreeds",
        { max: { id: 417, path: "db/0001.sql", line: 1 }, hasUnreadIds: false, sequenceReset: null },
      ],
      ["public.pets", { max: null, hasUnreadIds: true, sequenceReset: { path: "db/0002.sql", line: 1 } }],
    ]);
  });

  it("returns no table for migrations without explicit ids", () => {
    expect(getBaseExplicitIds([migration("0001", 'CREATE TABLE "Pets" ("Id" int);')], "postgres").size).toBe(
      0,
    );
  });
});

describe("applyAccept with a migrations-only basis", () => {
  const insert = (
    basis: ClassifiedFinding["basis"],
    findingClass: "needs-action" | "breaking" = "needs-action",
  ): ClassifiedFinding => {
    const [item] = classify([migration("0002", 'INSERT INTO "Breeds" ("Id") VALUES (418);')], {
      baseTables: ["public.breeds"],
    });
    if (item === undefined) throw new Error("no finding");
    item.finding.class = findingClass;
    return basis === undefined ? item : { ...item, basis };
  };
  const entry = {
    id: "insert-explicit-id",
    migration: "0002",
    basis: "migrations-only" as const,
    reason: "dictionary",
  };

  it("accepts only while the basis holds, and records why it refused", () => {
    const { findings, usage } = applyAccept(
      [
        insert({ holds: true }),
        insert({ holds: false, reason: "no writers are configured for Breeds" }),
        insert(undefined),
        insert({ holds: true }, "breaking"),
      ],
      [entry],
    );
    expect(findings.map((finding) => finding.accepted?.reason ?? null)).toEqual([
      "dictionary",
      null,
      null,
      null,
    ]);
    expect(usage).toEqual([
      {
        entry,
        count: 1,
        refusals: [
          "no writers are configured for Breeds",
          "the finding carries no migrations-only evidence",
          "the finding is breaking",
        ],
      },
    ]);
  });
});
