import { describe, expect, it } from "vitest";
import {
  normalizeSql,
  readSeedStatements,
  type SeedStatement,
} from "../../../src/layers/seed/seed-statements.js";

type Rows = Extract<SeedStatement, { kind: "rows" }>;

function readRows(text: string, dialect: "postgres" | "sqlserver" = "postgres"): Rows {
  const statements = readSeedStatements(text, dialect);
  expect(statements.map((statement) => statement.kind)).toEqual(["rows"]);
  return statements[0] as Rows;
}

describe("readSeedStatements: inserts", () => {
  it("returns nothing for an empty script", () => {
    expect(readSeedStatements("", "postgres")).toEqual([]);
    expect(readSeedStatements("-- nothing\n", "sqlserver")).toEqual([]);
  });

  it("reads a multi-row upsert with keys, values, mode and a line per tuple", () => {
    const rows = readRows(
      [
        "-- templates",
        'INSERT INTO "EmailTemplates" ("Id", "Type", "Subject")',
        "VALUES",
        "  (501, 'TermsChange', 'New terms, (v2)'),",
        "  (502, 'TermsChange', lower('X')),",
        "  (503,'TermsChange','It''s here')",
        'ON CONFLICT ("Id") DO UPDATE SET "Subject" = EXCLUDED."Subject";',
      ].join("\n"),
    );
    expect(rows.table.key).toBe("public.emailtemplates");
    expect(rows.columns).toEqual(["Id", "Type", "Subject"]);
    expect(rows.keyColumns).toEqual(["Id"]);
    expect(rows.mode).toBe("update");
    expect(rows.deletesMissing).toBe(false);
    expect(rows.line).toBe(2);
    expect(rows.rows).toEqual([
      { key: "501", values: "501, 'TermsChange', 'New terms, (v2)'", line: 4 },
      { key: "502", values: "502, 'TermsChange', LOWER('X')", line: 5 },
      { key: "503", values: "503, 'TermsChange', 'It''s here'", line: 6 },
    ]);
  });

  it("reads DO NOTHING as ignore and a missing clause as none", () => {
    expect(readRows("INSERT INTO t (id, a) VALUES (1, 'x') ON CONFLICT DO NOTHING;").mode).toBe("ignore");
    expect(readRows("INSERT INTO t (id, a) VALUES (1, 'x');").mode).toBe("none");
  });

  it("keys by the conflict target, falling back to the first column", () => {
    const composite = readRows(
      "INSERT INTO t (a, code, lang) VALUES (1, 'x', 'en') ON CONFLICT (code, lang) DO UPDATE SET a = 1;",
    );
    expect(composite.keyColumns).toEqual(["code", "lang"]);
    expect(composite.rows[0]?.key).toBe("'x', 'en'");
    const constraint = readRows(
      "INSERT INTO t (id, a) VALUES (7, 'x') ON CONFLICT ON CONSTRAINT pk_t DO UPDATE SET a = 'x';",
    );
    expect(constraint.keyColumns).toEqual(["id"]);
    expect(constraint.rows[0]?.key).toBe("7");
    const foreign = readRows("INSERT INTO t (id, a) VALUES (7, 'x') ON CONFLICT (other) DO NOTHING;");
    expect(foreign.keyColumns).toEqual(["id"]);
  });

  it("does not read ON CONFLICT inside a value", () => {
    expect(readRows("INSERT INTO t (id, note) VALUES (1, 'ON CONFLICT DO UPDATE');").mode).toBe("none");
  });

  it("keys an insert without a column list by its first value", () => {
    const rows = readRows("INSERT INTO t VALUES (9, 'a'), (10, 'b');");
    expect(rows.columns).toEqual([]);
    expect(rows.keyColumns).toEqual([]);
    expect(rows.rows.map((row) => row.key)).toEqual(["9", "10"]);
  });

  it("reads INSERT ... SELECT as a query insert with its mode", () => {
    const guarded = readSeedStatements(
      "INSERT INTO t (id, a) SELECT 1, 'x' WHERE NOT EXISTS (SELECT 1 FROM t WHERE id = 1);",
      "postgres",
    );
    expect(guarded).toMatchObject([{ kind: "insert-query", mode: "ignore" }]);
    const upsert = readSeedStatements(
      "INSERT INTO t (id, a) SELECT id, a FROM s ON CONFLICT (id) DO UPDATE SET a = EXCLUDED.a;",
      "postgres",
    );
    expect(upsert).toMatchObject([{ kind: "insert-query", mode: "update" }]);
    expect(readSeedStatements("INSERT INTO t (id) SELECT id FROM s;", "postgres")).toMatchObject([
      { kind: "insert-query", mode: "none" },
    ]);
  });

  it("falls back to a query insert when a VALUES list cannot be read", () => {
    expect(readSeedStatements("INSERT INTO t (id) VALUES (1), (2;", "postgres")).toMatchObject([
      { kind: "insert-query", mode: "none" },
    ]);
  });
});

describe("readSeedStatements: MERGE", () => {
  const merge = (clauses: string, using = "(VALUES (1, N'a'), (2, N'b')) AS s (Id, Name)") =>
    `MERGE INTO dbo.Settings WITH (HOLDLOCK) AS tg USING ${using} ON tg.Id = s.Id ${clauses};`;

  it("reads a VALUES source with WHEN MATCHED THEN UPDATE as rows with mode update", () => {
    const rows = readRows(
      merge(
        "WHEN MATCHED THEN UPDATE SET Name = s.Name WHEN NOT MATCHED THEN INSERT (Id, Name) VALUES (s.Id, s.Name)",
      ),
      "sqlserver",
    );
    expect(rows.table.key).toBe("dbo.settings");
    expect(rows.columns).toEqual(["Id", "Name"]);
    expect(rows.keyColumns).toEqual(["Id"]);
    expect(rows.mode).toBe("update");
    expect(rows.rows.map((row) => [row.key, row.values])).toEqual([
      ["1", "1, N'a'"],
      ["2", "2, N'b'"],
    ]);
  });

  it("reads a merge that only inserts as ignore, and BY SOURCE DELETE as deletesMissing", () => {
    expect(
      readRows(merge("WHEN NOT MATCHED THEN INSERT (Id, Name) VALUES (s.Id, s.Name)"), "sqlserver").mode,
    ).toBe("ignore");
    const deleting = readRows(
      merge(
        "WHEN MATCHED THEN UPDATE SET Name = s.Name WHEN NOT MATCHED BY TARGET THEN INSERT (Id, Name) VALUES (s.Id, s.Name) WHEN NOT MATCHED BY SOURCE THEN DELETE",
      ),
      "sqlserver",
    );
    expect(deleting.deletesMissing).toBe(true);
    expect(deleting.mode).toBe("update");
  });

  it("reads a table source or a matched delete as a merge query", () => {
    expect(
      readSeedStatements(merge("WHEN MATCHED THEN UPDATE SET Name = s.Name", "staging AS s"), "sqlserver"),
    ).toMatchObject([{ kind: "merge-query", updates: true, deletes: false, inserts: false }]);
    expect(readSeedStatements(merge("WHEN MATCHED THEN DELETE"), "sqlserver")).toMatchObject([
      { kind: "merge-query", updates: false, deletes: true },
    ]);
  });
});

describe("readSeedStatements: other writes", () => {
  it("reads UPDATE, DELETE and TRUNCATE with normalised text", () => {
    const statements = readSeedStatements(
      "UPDATE t\n  SET a = 'x  y' WHERE id = 1;\nDELETE FROM s WHERE id = 2;\nTRUNCATE TABLE u;\nSELECT 1;",
      "postgres",
    );
    expect(
      statements.map((statement) => [
        statement.kind,
        "table" in statement ? statement.table.display : null,
        statement.line,
      ]),
    ).toEqual([
      ["update", "t", 1],
      ["delete", "s", 3],
      ["truncate", "u", 4],
    ]);
    expect(statements[0]).toMatchObject({ text: "UPDATE T SET A = 'x  y' WHERE ID = 1" });
  });
});

describe("readSeedStatements: guards and blocks", () => {
  it("reads a T-SQL IF NOT EXISTS insert as ignore", () => {
    const rows = readRows(
      "IF NOT EXISTS (SELECT 1 FROM [Roles] WHERE [Id] = 1)\n  INSERT INTO [Roles] ([Id], [Name]) VALUES (1, N'Admin');",
      "sqlserver",
    );
    expect(rows.mode).toBe("ignore");
    expect(rows.line).toBe(2);
  });

  it("carries a T-SQL guard through a BEGIN ... END block and stops after END", () => {
    const statements = readSeedStatements(
      [
        "IF NOT EXISTS (SELECT 1 FROM Roles WHERE Id = 1)",
        "BEGIN",
        "  INSERT INTO Roles (Id, Name) VALUES (1, 'Admin');",
        "  INSERT INTO Roles (Id, Name) VALUES (2, 'User');",
        "END",
        "INSERT INTO Roles (Id, Name) VALUES (3, 'Guest');",
      ].join("\n"),
      "sqlserver",
    );
    expect(statements.map((statement) => [statement.kind, (statement as Rows).mode, statement.line])).toEqual(
      [
        ["rows", "ignore", 3],
        ["rows", "ignore", 4],
        ["rows", "none", 6],
      ],
    );
  });

  it("does not treat another T-SQL condition as a guard", () => {
    const statements = readSeedStatements(
      "IF @env = 'dev' BEGIN INSERT INTO Roles (Id) VALUES (1); END\nIF NOT EXISTS (SELECT 1 FROM Roles) AND @x = 1 INSERT INTO Roles (Id) VALUES (2);",
      "sqlserver",
    );
    expect(statements.map((statement) => (statement as Rows).mode)).toEqual(["none", "none"]);
  });

  it("reads a Postgres DO block with an IF NOT EXISTS guard and true lines", () => {
    const statements = readSeedStatements(
      [
        "DO $$",
        "BEGIN",
        "  IF NOT EXISTS (SELECT 1 FROM roles WHERE id = 1) THEN",
        "    INSERT INTO roles (id, name) VALUES (1, 'admin');",
        "  ELSE",
        "    INSERT INTO roles (id, name) VALUES (4, 'other');",
        "  END IF;",
        "  INSERT INTO roles (id, name) VALUES (2, 'user');",
        "END $$;",
      ].join("\n"),
      "postgres",
    );
    expect(statements.map((statement) => [(statement as Rows).mode, statement.line])).toEqual([
      ["ignore", 4],
      ["none", 6],
      ["none", 8],
    ]);
  });

  it("records the guard condition and the action text", () => {
    const guarded = readRows(
      "IF NOT EXISTS (SELECT 1 FROM Roles)\n  INSERT INTO Roles (Id) VALUES (1);",
      "sqlserver",
    );
    expect(guarded.guard).toBe("(SELECT 1 FROM ROLES)");
    const upsert = readRows(
      "INSERT INTO t (id, a) VALUES (1, 'x') ON CONFLICT (id) DO UPDATE SET a = EXCLUDED.a;",
    );
    expect(upsert.guard).toBeNull();
    expect(upsert.action).toBe("ON CONFLICT (ID) DO UPDATE SET A = EXCLUDED.A");
  });

  it("reads past a nested block with its own EXCEPTION in a DO body", () => {
    const statements = readSeedStatements(
      [
        "DO $$",
        "BEGIN",
        "  BEGIN",
        "    INSERT INTO t (id) VALUES (1);",
        "  EXCEPTION WHEN unique_violation THEN NULL;",
        "  END;",
        "  UPDATE t SET a = CASE WHEN id = 1 THEN 'x' ELSE 'y' END;",
        "  DELETE FROM t WHERE id = 3;",
        "EXCEPTION WHEN others THEN DELETE FROM never;",
        "END $$;",
      ].join("\n"),
      "postgres",
    );
    expect(statements.map((statement) => [statement.kind, statement.line])).toEqual([
      ["rows", 4],
      ["update", 7],
      ["delete", 8],
    ]);
  });

  it("handles T-SQL END glued to the next block and nested END END", () => {
    const statements = readSeedStatements(
      [
        "IF @a = 1 BEGIN IF @b = 1 BEGIN UPDATE t SET x = 1; END END",
        "IF NOT EXISTS (SELECT 1 FROM r WHERE Id = 5) BEGIN INSERT INTO r (Id) VALUES (5); END",
        "INSERT INTO r (Id) VALUES (6);",
      ].join("\n"),
      "sqlserver",
    );
    expect(statements.map((statement) => [statement.kind, (statement as Rows).mode ?? null])).toEqual([
      ["update", null],
      ["rows", "ignore"],
      ["rows", "none"],
    ]);
  });

  it("reads a 2000-row VALUES list with true lines in linear time", () => {
    const tuples = Array.from({ length: 2000 }, (_, index) => `  (${index}, 'name ${index}', now())`);
    const started = performance.now();
    const rows = readRows(
      `INSERT INTO t (id, name, at) VALUES\n${tuples.join(",\n")}\nON CONFLICT (id) DO NOTHING;`,
    );
    expect(performance.now() - started).toBeLessThan(1000);
    expect(rows.rows).toHaveLength(2000);
    expect(rows.rows[1999]).toEqual({ key: "1999", values: "1999, 'name 1999', NOW()", line: 2001 });
  });

  it("does not end a Postgres E string at an escaped quote", () => {
    const rows = readRows(
      "INSERT INTO t (id, a) VALUES (1, E'it\\'s, (x'), (2, 'b') ON CONFLICT (id) DO NOTHING;",
    );
    expect(rows.rows.map((row) => row.key)).toEqual(["1", "2"]);
  });

  it("splits T-SQL statements written without semicolons", () => {
    const kinds = (text: string) =>
      readSeedStatements(text, "sqlserver").map((statement) => [
        statement.kind,
        "table" in statement ? statement.table.display : null,
        statement.line,
      ]);
    expect(
      kinds(
        "SET IDENTITY_INSERT dbo.R ON\nINSERT INTO dbo.R (Id, N) VALUES (1, 'a'),\n(2, 'b')\nSET IDENTITY_INSERT dbo.R OFF\nTRUNCATE TABLE dbo.Z",
      ),
    ).toEqual([
      ["rows", "dbo.R", 2],
      ["truncate", "dbo.Z", 5],
    ]);
    expect(
      kinds(
        "SET NOCOUNT ON\nMERGE INTO R AS t\nUSING (VALUES (1, 'x')) AS s (Id, N)\nON t.Id = s.Id\nWHEN MATCHED THEN\n  UPDATE SET N = s.N\nWHEN NOT MATCHED THEN\n  INSERT (Id, N) VALUES (s.Id, s.N)\nPRINT 'done'\nDELETE R WHERE Id = 9",
      ),
    ).toEqual([
      ["rows", "R", 2],
      ["delete", "R", 10],
    ]);
    expect(
      kinds(
        "UPDATE t\nSET a = CASE\n  WHEN b = 1 THEN 'x'\n  ELSE 'y'\nEND\nWHERE id = 1\nIF NOT EXISTS (SELECT 1 FROM r WHERE Id = 1)\n  INSERT INTO r (Id) VALUES (1)\nDELETE FROM s",
      ),
    ).toEqual([
      ["update", "t", 1],
      ["rows", "r", 8],
      ["delete", "s", 9],
    ]);
    const guarded = readSeedStatements(
      "IF NOT EXISTS (SELECT 1 FROM r WHERE Id = 1)\n  INSERT INTO r (Id) VALUES (1)\nINSERT INTO r (Id) VALUES (2)",
      "sqlserver",
    );
    expect(guarded.map((statement) => (statement as Rows).mode)).toEqual(["ignore", "none"]);
  });

  it("reads the bodies of T-SQL WHILE and PL/pgSQL loops", () => {
    expect(
      readSeedStatements("WHILE @i < 3 BEGIN UPDATE t SET a = @i; SET @i = @i + 1; END", "sqlserver"),
    ).toMatchObject([{ kind: "update" }]);
    expect(
      readSeedStatements(
        "DO $$ DECLARE r record; BEGIN FOR r IN SELECT id FROM s LOOP UPDATE t SET a = r.id; END LOOP; DELETE FROM u; END $$;",
        "postgres",
      ),
    ).toMatchObject([{ kind: "update" }, { kind: "delete" }]);
  });

  it("reports writes it cannot read as unknown writes, but not grants or row locks", () => {
    expect(
      readSeedStatements(
        "WITH x AS (SELECT 1 AS id) INSERT INTO t (id) SELECT id FROM x;\nGRANT INSERT, UPDATE ON t TO app;\nSELECT * FROM t FOR UPDATE;\nSELECT 'UPDATE';",
        "postgres",
      ),
    ).toMatchObject([{ kind: "unknown-write", line: 1 }]);
  });

  it("treats WHERE NOT EXISTS as a guard only when it reads the target table", () => {
    expect(
      readSeedStatements(
        "INSERT INTO a (id) SELECT id FROM x WHERE NOT EXISTS (SELECT 1 FROM b);",
        "postgres",
      ),
    ).toMatchObject([{ kind: "insert-query", mode: "none" }]);
  });

  it("splits SQL Server GO batches", () => {
    const statements = readSeedStatements("UPDATE a SET x = 1\nGO\nDELETE FROM b\nGO\n", "sqlserver");
    expect(statements.map((statement) => statement.kind)).toEqual(["update", "delete"]);
  });
});

describe("normalizeSql", () => {
  it("collapses whitespace and uppercases outside quotes, and drops spaces around parentheses and commas", () => {
    expect(normalizeSql("INSERT  INTO t ( a ,\n b )  VALUES ('x  y', [a  b])", "sqlserver")).toBe(
      "INSERT INTO T (A,B) VALUES ('x  y',[a  b])",
    );
  });
});
