import { describe, expect, it } from "vitest";
import { readNpm } from "../../../src/layers/dependencies/read-npm.js";
import { readNuget } from "../../../src/layers/dependencies/read-nuget.js";

const summary = (declarations: { name: string; version: string; line: number }[]) =>
  declarations.map(({ name, version, line }) => `${name}@${version}:${line}`);

describe("readNuget", () => {
  it("reads central versions, resolves properties and skips comments and versionless references", () => {
    const text = [
      "<Project>",
      "  <PropertyGroup><Ef>9.0.1</Ef><EfFull>$(Ef)</EfFull></PropertyGroup>",
      "  <ItemGroup>",
      '    <PackageVersion Include="Npgsql" Version="3.1.0" />',
      '    <PackageVersion Include="Microsoft.EntityFrameworkCore" Version="$(EfFull)" />',
      '    <!-- <PackageVersion Include="Old" Version="1.0.0" /> -->',
      '    <PackageReference Include="Serilog" />',
      '    <GlobalPackageReference Include="Nerdbank.GitVersioning" Version="3.6.0" />',
      "  </ItemGroup>",
      "</Project>",
    ].join("\n");
    expect(summary(readNuget(text, "Directory.Packages.props"))).toEqual([
      "Npgsql@3.1.0:4",
      "Microsoft.EntityFrameworkCore@9.0.1:5",
      "Nerdbank.GitVersioning@3.6.0:8",
    ]);
  });

  it("reads versions from attributes, child elements and overrides", () => {
    const text = [
      "<Project>",
      "  <ItemGroup>",
      "    <PackageReference Include='Dapper' Version='2.1.0' />",
      '    <PackageReference Include="Polly">',
      "      <Version>8.4.0</Version>",
      "    </PackageReference>",
      '    <PackageReference Include="Npgsql" VersionOverride="3.0.0" />',
      '    <PackageReference Update="Serilog" Version="4.0.0" />',
      '    <PackageReference Include="Unresolved" Version="$(Nope)" />',
      "  </ItemGroup>",
      "</Project>",
    ].join("\n");
    expect(summary(readNuget(text, "Api.csproj"))).toEqual([
      "Dapper@2.1.0:3",
      "Polly@8.4.0:4",
      "Npgsql@3.0.0:7",
      "Serilog@4.0.0:8",
      "Unresolved@$(Nope):9",
    ]);
  });
});

describe("readNpm", () => {
  const text = [
    "{",
    '  "name": "app",',
    '  "dependencies": {',
    '    "zod": "^4.6.5",',
    '    "@softure-ai/compat": "0.1.1"',
    "  },",
    '  "devDependencies": {',
    '    "zod": "^4.0.0",',
    '    "vitest": "^5.0.0"',
    "  }",
    "}",
  ].join("\n");

  it("reads the requested sections with the line of each key", () => {
    const read = readNpm(text, "package.json", ["dependencies"]);
    expect(read.ok && summary(read.value)).toEqual(["zod@^4.6.5:4", "@softure-ai/compat@0.1.1:5"]);
    const dev = readNpm(text, "package.json", ["devDependencies"]);
    expect(dev.ok && summary(dev.value)).toEqual(["zod@^4.0.0:8", "vitest@^5.0.0:9"]);
  });

  it("fails on invalid JSON and on a section that is not an object", () => {
    expect(readNpm("{", "package.json", ["dependencies"])).toMatchObject({ ok: false });
    expect(readNpm('{"dependencies": []}', "a/package.json", ["dependencies"])).toEqual({
      ok: false,
      error: 'a/package.json: "dependencies" is not an object',
    });
  });
});
