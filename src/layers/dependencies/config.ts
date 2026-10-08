import { z } from "zod";
import { FINDING_CLASSES } from "../../model/finding.js";

export const DEPENDENCY_FINDING_IDS = [
  "dependency-added",
  "dependency-removed",
  "dependency-upgraded",
  "dependency-downgraded",
  "dependency-changed",
] as const;

export type DependencyFindingId = (typeof DEPENDENCY_FINDING_IDS)[number];

export const DEFAULT_NUGET_FILES = ["**/*.{csproj,fsproj,vbproj,props,targets}"];

export const DEFAULT_NPM_FILES = ["**/package.json"];

export const NPM_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export type NpmSection = (typeof NPM_SECTIONS)[number];

const globs = z.array(z.string().min(1)).min(1);

/** Whether lockfiles next to the manifests are read; `false` compares the declared versions only. */
const lockfiles = z.boolean().default(true);

/** A package name or a glob over names (`SOFTURE.*`, `@softure-ai/*`); matched case-insensitively. */
const namePattern = z.string().min(1);

export const dependencySourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("nuget"), files: globs.default(DEFAULT_NUGET_FILES), lockfiles }),
  z.strictObject({
    kind: z.literal("npm"),
    files: globs.default(DEFAULT_NPM_FILES),
    lockfiles,
    sections: z
      .array(z.enum(NPM_SECTIONS))
      .min(1)
      .refine((sections) => new Set(sections).size === sections.length, "must not repeat a section")
      .default(["dependencies"]),
  }),
]);

export type DependencySource = z.infer<typeof dependencySourceSchema>;

export const watchEntrySchema = z
  .strictObject({
    name: namePattern,
    /** The least class every finding of a matching package gets. */
    class: z.enum(FINDING_CLASSES).optional(),
    /** Printed with the finding, for example the GitHub releases page of the package. */
    releaseNotes: z.url({ protocol: /^https?$/ }).optional(),
  })
  .refine((entry) => entry.class !== undefined || entry.releaseNotes !== undefined, {
    message: "needs a class, releaseNotes or both",
  });

export type WatchEntry = z.infer<typeof watchEntrySchema>;

export const dependencyAcceptEntrySchema = z.strictObject({
  id: z.enum(DEPENDENCY_FINDING_IDS),
  /** The exact package name; NuGet names match case-insensitively. */
  name: z.string().min(1),
  /** The base version this entry was reviewed for; without it the entry accepts any base version. */
  from: z.string().min(1).optional(),
  /** The revision version this entry was reviewed for; without it the entry accepts any later version. */
  to: z.string().min(1).optional(),
  reason: z.string().min(1),
});

export type DependencyAcceptEntry = z.infer<typeof dependencyAcceptEntrySchema>;

export const dependenciesConfigSchema = z.strictObject({
  sources: z
    .array(dependencySourceSchema)
    .min(1)
    .refine(
      (sources) => new Set(sources.map((source) => source.kind)).size === sources.length,
      "list each source kind once",
    )
    .default([
      { kind: "nuget", files: DEFAULT_NUGET_FILES, lockfiles: true },
      { kind: "npm", files: DEFAULT_NPM_FILES, lockfiles: true, sections: ["dependencies"] },
    ]),
  watch: z.array(watchEntrySchema).optional(),
  ignore: z.array(namePattern).optional(),
  accept: z.array(dependencyAcceptEntrySchema).optional(),
});

export type DependenciesConfig = z.infer<typeof dependenciesConfigSchema>;
