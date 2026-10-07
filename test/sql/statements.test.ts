import { describe, expect, it } from "vitest";
import {
  findClosingParen,
  getLineAt,
  maskComments,
  maskLiterals,
  splitStatements,
  splitTopLevel,
} from "../../src/sql/statements.js";

const sqls = (text: string, dialect: "postgres" | "sqlserver" = "postgres") =>
  splitStatements(text, dialect).map((statement) => statement.sql);

describe("splitStatements", () => {
  it("returns nothing for empty or whitespace-only input", () => {
    expect(splitStatements("", "postgres")).toEqual([]);
    expect(splitStatements(" \n\t;\n", "sqlserver")).toEqual([]);
  });

  it("keeps a last statement without a terminating semicolon", () => {
    expect(sqls("SELECT 1; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("does not split inside strings, quoted identifiers or comments", () => {
    const text = [
      "INSERT INTO t VALUES ('a;b', 'it''s;');",
      `SELECT "a;b" FROM x; -- trailing ; comment`,
      "/* outer /* nested ; */ still ; comment */ SELECT 3;",
    ].join("\n");
    expect(sqls(text)).toEqual(["INSERT INTO t VALUES ('a;b', 'it''s;')", `SELECT "a;b" FROM x`, "SELECT 3"]);
  });

  it("honours backslash escapes only in Postgres E strings", () => {
    expect(sqls("SELECT E'\\';x'; SELECT 2")).toEqual(["SELECT E'\\';x'", "SELECT 2"]);
    expect(sqls("SELECT 'a\\'; SELECT 2")).toEqual(["SELECT 'a\\'", "SELECT 2"]);
    expect(sqls("SELECT name'x'; SELECT 2")).toEqual(["SELECT name'x'", "SELECT 2"]);
  });

  it("treats square brackets as identifiers only in SQL Server", () => {
    expect(sqls("SELECT [a;b] FROM t; SELECT 2", "sqlserver")).toEqual(["SELECT [a;b] FROM t", "SELECT 2"]);
    expect(sqls("SELECT [a]]; b] FROM t", "sqlserver")).toEqual(["SELECT [a]]; b] FROM t"]);
  });

  it("keeps Postgres dollar-quoted bodies whole", () => {
    const text = [
      "DO $EF$",
      "BEGIN",
      "    IF NOT EXISTS(SELECT 1) THEN",
      "    CREATE TABLE x (id int);",
      "    END IF;",
      "END $EF$;",
      "DO $$ BEGIN PERFORM 1; END $$;",
      "SELECT a$b$c FROM t; SELECT $1;",
    ].join("\n");
    const statements = sqls(text);
    expect(statements).toHaveLength(4);
    expect(statements[0]).toMatch(/^DO \$EF\$[\s\S]*END \$EF\$$/);
    expect(statements[1]).toBe("DO $$ BEGIN PERFORM 1; END $$");
    expect(statements.slice(2)).toEqual(["SELECT a$b$c FROM t", "SELECT $1"]);
  });

  it("splits SQL Server batches at GO lines, but not in strings or in Postgres", () => {
    const text = "CREATE TABLE a (id int)\nGO\nSELECT 'x\nGO\ny'\n go 2 \nSELECT 3";
    expect(sqls(text, "sqlserver")).toEqual(["CREATE TABLE a (id int)", "SELECT 'x\nGO\ny'", "SELECT 3"]);
    expect(sqls("SELECT 1\nGO\nSELECT 2", "postgres")).toEqual(["SELECT 1\nGO\nSELECT 2"]);
  });

  it("splits at GO lines with CRLF line ends", () => {
    expect(sqls("SELECT 1\r\nGO\r\nSELECT 2\r\n", "sqlserver")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("keeps a procedure batch whole in SQL Server", () => {
    const text = [
      "CREATE OR ALTER PROCEDURE p AS",
      "BEGIN",
      "  UPDATE t SET a = 1;",
      "  DELETE FROM t;",
      "END;",
      "GO",
      "UPDATE t SET b = 2;",
    ].join("\n");
    const statements = sqls(text, "sqlserver");
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^CREATE OR ALTER PROCEDURE p AS[\s\S]*END$/);
    expect(statements[1]).toBe("UPDATE t SET b = 2");
  });

  it("reports the line and offset of each statement's first character", () => {
    const text = "SELECT 1;\n/* a\n multi-line\n comment */\n\n  DROP TABLE x;";
    const statements = splitStatements(text, "postgres");
    expect(statements[1]).toEqual({ sql: "DROP TABLE x", line: 6, offset: text.indexOf("DROP") });
  });

  it("splits drizzle statement breakpoints", () => {
    const text =
      'CREATE TABLE "a" ("id" serial);\n--> statement-breakpoint\nCREATE INDEX "i" ON "a" ("id");\n';
    expect(splitStatements(text, "postgres")).toEqual([
      { sql: 'CREATE TABLE "a" ("id" serial)', line: 1, offset: 0 },
      { sql: 'CREATE INDEX "i" ON "a" ("id")', line: 3, offset: text.indexOf("CREATE INDEX") },
    ]);
  });

  it("returns the rest of the script as one statement after an unterminated string", () => {
    expect(sqls("SELECT 1; SELECT 'oops; DROP TABLE x;")).toEqual(["SELECT 1", "SELECT 'oops; DROP TABLE x"]);
  });
});

describe("splitStatements performance", () => {
  it("splits a 5 MB SQL Server script with many GO lines in linear time", () => {
    const batch =
      "IF NOT EXISTS (SELECT * FROM [h] WHERE [Id] = N'x')\nBEGIN\n    CREATE TABLE [a] ([b] int);\nEND;\nGO\n\n";
    const text = batch.repeat(Math.ceil(5_000_000 / batch.length));
    const started = performance.now();
    const statements = splitStatements(text, "sqlserver");
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(statements.length).toBeGreaterThan(50_000);
  });
});

describe("maskLiterals", () => {
  it("blanks strings, quoted identifiers and dollar bodies", () => {
    expect(maskLiterals("a 'x' \"y\" $$z$$ b", "postgres")).toBe(`a${" ".repeat(15)}b`);
    expect(maskLiterals("[d] e", "sqlserver")).toBe("    e");
  });
});

describe("maskComments", () => {
  it("replaces comments with spaces and keeps newlines and length", () => {
    const text = "a -- x\nb /* y\nz */ c '--not'";
    const masked = maskComments(text, "postgres");
    expect(masked).toBe("a     \nb     \n     c '--not'");
    expect(masked).toHaveLength(text.length);
  });
});

describe("splitTopLevel", () => {
  it("splits outside parentheses, strings and quoted identifiers", () => {
    expect(splitTopLevel("(1, 'a,b'), (2, f(3, 4)), (\"x,y\", N'it''s, ok')", "sqlserver")).toEqual([
      "(1, 'a,b')",
      "(2, f(3, 4))",
      "(\"x,y\", N'it''s, ok')",
    ]);
    expect(splitTopLevel("[a,b], c", "sqlserver")).toEqual(["[a,b]", "c"]);
    expect(splitTopLevel("", "postgres")).toEqual([]);
  });
});

describe("findClosingParen", () => {
  it("finds the matching parenthesis and ignores quoted ones", () => {
    const text = "VALUES (1, ')', (2)) tail";
    expect(findClosingParen(text, text.indexOf("("), "postgres")).toBe(text.indexOf(" tail") - 1);
  });

  it("returns -1 when the parenthesis is not closed", () => {
    expect(findClosingParen("(1, (2)", 0, "postgres")).toBe(-1);
  });
});

describe("getLineAt", () => {
  it("counts lines from 1", () => {
    expect(getLineAt("a\nb\nc", 0)).toBe(1);
    expect(getLineAt("a\nb\nc", 4)).toBe(3);
  });
});
