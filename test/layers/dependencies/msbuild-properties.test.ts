import { describe, expect, it } from "vitest";
import { evaluateMsbuildProperties } from "../../../src/layers/dependencies/msbuild-properties.js";
import { err, ok } from "../../../src/result.js";

const props = (body: string) => `<Project>\n  <PropertyGroup>${body}</PropertyGroup>\n</Project>`;

function createReader(files: Record<string, string>) {
  const reads: string[] = [];
  const readFile = async (path: string) => {
    reads.push(path);
    return ok(files[path] ?? null);
  };
  return { readFile, reads };
}

async function evaluate(path: string, files: Record<string, string>) {
  const evaluated = await evaluateMsbuildProperties({ path, readFile: createReader(files).readFile });
  if (!evaluated.ok) throw new Error(evaluated.error);
  return {
    properties: Object.fromEntries(evaluated.value.properties),
    skippedImports: evaluated.value.skippedImports,
  };
}

describe("evaluateMsbuildProperties", () => {
  it("reads only the nearest Directory.Build.props, as MSBuild does", async () => {
    const { properties } = await evaluate("src/Api/Api.csproj", {
      "Directory.Build.props": props(
        "<RootOnly>1.0.0</RootOnly><MassTransitVersion>7.0.0</MassTransitVersion>",
      ),
      "src/Directory.Build.props": props("<MassTransitVersion>8.1.0</MassTransitVersion>"),
      "src/Api/Api.csproj": "<Project />",
    });
    expect(properties).toEqual({ masstransitversion: "8.1.0" });
  });

  it("applies props, central props, the file and targets in order, the last definition winning", async () => {
    const { properties } = await evaluate("src/Api/Api.csproj", {
      "Directory.Build.props": props("<A>props</A><B>props</B><C>props</C><D>props</D>"),
      "Directory.Packages.props": props("<B>central</B><C>central</C><D>central</D>"),
      "src/Api/Api.csproj": props("<C>project</C><D>project</D>"),
      "src/Directory.Build.targets": props("<D>targets</D>"),
    });
    expect(properties).toEqual({ a: "props", b: "central", c: "project", d: "targets" });
  });

  it("follows relative and $(MSBuildThisFileDirectory) imports in document order", async () => {
    const { properties, skippedImports } = await evaluate("src/Api/Api.csproj", {
      "Directory.Build.props": [
        "<Project>",
        '  <Import Project="$(MSBuildThisFileDirectory)eng\\Versions.props" />',
        "  <PropertyGroup><Polly>8.0.0</Polly></PropertyGroup>",
        '  <Import Project="eng/Late.props" />',
        "</Project>",
      ].join("\n"),
      "eng/Versions.props": props("<Polly>7.0.0</Polly><Serilog>4.0.0</Serilog>"),
      "eng/Late.props": props("<Serilog>4.1.0</Serilog>"),
      "src/Api/Api.csproj": '<Project><Import Project="..\\..\\eng\\Shared.props" /></Project>',
      "eng/Shared.props": props("<Shared>2.0.0</Shared>"),
    });
    expect(properties).toEqual({ polly: "8.0.0", serilog: "4.1.0", shared: "2.0.0" });
    expect(skippedImports).toEqual([]);
  });

  it("follows a GetPathOfFileAbove chain to the parent Directory.Build.props", async () => {
    const { properties } = await evaluate("src/Api/Api.csproj", {
      "Directory.Build.props": props("<MassTransitVersion>8.2.0</MassTransitVersion><Npgsql>9.0.0</Npgsql>"),
      "src/Directory.Build.props": [
        "<Project>",
        "  <Import Project=\"$([MSBuild]::GetPathOfFileAbove('Directory.Build.props', '$(MSBuildThisFileDirectory)../'))\" />",
        "  <PropertyGroup><Npgsql>9.0.1</Npgsql></PropertyGroup>",
        "</Project>",
      ].join("\n"),
      "src/Api/Api.csproj": "<Project />",
    });
    expect(properties).toEqual({ masstransitversion: "8.2.0", npgsql: "9.0.1" });
  });

  it("resolves $(MSBuildProjectDirectory) from the evaluated file, also inside imports", async () => {
    const { properties } = await evaluate("src/Api/Api.csproj", {
      "Directory.Build.props":
        '<Project><Import Project="$(MSBuildProjectDirectory)/local.props" /></Project>',
      "src/Api/local.props": props("<Local>1.2.3</Local>"),
      "src/Api/Api.csproj": "<Project />",
    });
    expect(properties).toEqual({ local: "1.2.3" });
  });

  it("names every import it cannot follow and skips SDK imports and guarded missing files", async () => {
    const { properties, skippedImports } = await evaluate("Api.csproj", {
      "Api.csproj": [
        "<Project>",
        '  <Import Project="$(RepoRoot)eng/Versions.props" />',
        '  <Import Project="../outside.props" />',
        '  <Import Project="C:\\Build\\Versions.props" />',
        '  <Import Project="eng/*.props" />',
        '  <Import Project="missing.props" />',
        '  <Import Project="optional.props" Condition="Exists(\'optional.props\')" />',
        '  <Import Project="Sdk.props" Sdk="Microsoft.NET.Sdk" />',
        '  <!-- <Import Project="commented.props" /> -->',
        "  <PropertyGroup><Own>1.0.0</Own></PropertyGroup>",
        "</Project>",
      ].join("\n"),
    });
    expect(properties).toEqual({ own: "1.0.0" });
    expect(skippedImports).toEqual([
      "Api.csproj: $(RepoRoot)eng/Versions.props (a property in the path)",
      "Api.csproj: ../outside.props (outside the repository)",
      "Api.csproj: C:\\Build\\Versions.props (outside the repository)",
      "Api.csproj: eng/*.props (a wildcard in the path)",
      "Api.csproj: missing.props (file not found)",
    ]);
  });

  it("applies each file once when imports form a cycle", async () => {
    const { properties } = await evaluate("Api.csproj", {
      "Api.csproj": '<Project><Import Project="a.props" /></Project>',
      "a.props": '<Project><Import Project="b.props" /><PropertyGroup><A>1</A></PropertyGroup></Project>',
      "b.props": '<Project><Import Project="a.props" /><PropertyGroup><A>2</A></PropertyGroup></Project>',
    });
    expect(properties).toEqual({ a: "1" });
  });

  it("does not auto-import a file of its own name", async () => {
    const { properties } = await evaluate("src/Directory.Build.props", {
      "Directory.Build.props": props("<Parent>1.0.0</Parent>"),
      "src/Directory.Build.props": props("<Child>1.0.0</Child>"),
    });
    expect(properties).toEqual({ child: "1.0.0" });
  });

  it("fails with the operation and file when a read fails", async () => {
    const evaluated = await evaluateMsbuildProperties({
      path: "src/Api.csproj",
      readFile: async (path) => (path === "src/Api.csproj" ? ok("<Project />") : err("git failed")),
    });
    expect(evaluated).toEqual({
      ok: false,
      error: "cannot look for Directory.Build.props above src/Api.csproj: git failed",
    });
  });
});
