export const FINDING_CLASSES = ["safe", "needs-action", "rollback-risk", "breaking"] as const;

export type FindingClass = (typeof FINDING_CLASSES)[number];

export type Side = "base" | "revision";

export type Evidence = {
  side: Side;
  ref: string;
  commit: string;
  path: string;
  line?: number;
};

export type Finding = {
  layer: string;
  /** Part of the layer the finding belongs to, for example the API name. */
  scope: string;
  /** Stable rule id, for example an oasdiff check id. */
  id: string;
  /** What changed, for example `POST /api/pets`. */
  subject: string;
  class: FindingClass;
  message: string;
  evidence: Evidence[];
  accepted?: { reason: string };
};

export type LayerResult =
  | { layer: string; status: "ran"; findings: Finding[]; notes: string[] }
  | { layer: string; status: "skipped"; reason: string }
  /** A layer that could not finish; the findings it made before failing still count for the gate. */
  | { layer: string; status: "failed"; error: string; findings: Finding[]; notes: string[] };

export function getClassRank(findingClass: FindingClass): number {
  return FINDING_CLASSES.indexOf(findingClass);
}

/** Negative when `a` is less severe than `b`, zero when equal, positive when more severe. */
export function compareClass(a: FindingClass, b: FindingClass): number {
  return getClassRank(a) - getClassRank(b);
}

export function isFindingClass(value: string): value is FindingClass {
  return (FINDING_CLASSES as readonly string[]).includes(value);
}
