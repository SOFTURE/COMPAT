export const FINDING_CLASSES = ["safe", "needs-action", "rollback-risk", "breaking"] as const;

export type FindingClass = (typeof FINDING_CLASSES)[number];

export type Side = "base" | "revision";

/** `client` marks evidence read from a live client ref, not from the base or the revision. */
export type EvidenceSide = Side | "client";

export type Evidence = {
  side: EvidenceSide;
  ref: string;
  commit: string;
  path: string;
  line?: number;
};

/** An API whose DTO fields (`NotificationDto.type`) carry an enum to clients as a plain string. */
export type Exposure = { api: string; fields: string[] };

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
  /**
   * What the finding is about across layers, when it differs from `subject`: a seed row that writes
   * a new enum member carries the member (`NotificationType.TermsChange`), so the report shows both
   * layers' findings as one entry.
   */
  topic?: string;
  /** Set when a later layer changed `class`, for example `client-usage` on an `openapi` finding. */
  reclassified?: { from: FindingClass; by: string; reason: string };
  /** Set when a later layer tried to re-classify the finding and could not: why, and where it stopped. */
  reclassifyAttempt?: { reason: string; stoppedAt?: Evidence };
  /** Where a `persisted-enums` finding reaches clients; `client-usage` refines it by these fields. */
  exposure?: Exposure[];
  /** String literals the rows of a `seed` finding write; `persisted-enums` refines it by them. */
  literals?: string[];
  /**
   * Names and string values of the exposed enum's members at both refs, so `client-usage` can tell a
   * comparison against a member from one against an unrelated string.
   */
  enumValues?: string[];
};

/** The end of what a failed command printed, with its newlines, and where its full output was written. */
export type CommandOutput = { command: string; tail: string; log?: string };

export type LayerResult =
  | { layer: string; status: "ran"; findings: Finding[]; notes: string[] }
  | { layer: string; status: "skipped"; reason: string }
  /**
   * A layer that could not finish; the findings it made before failing still count for the gate. `outputs` holds
   * the output of the commands that failed, for the report to show as it was printed.
   */
  | {
      layer: string;
      status: "failed";
      error: string;
      findings: Finding[];
      notes: string[];
      outputs?: CommandOutput[];
    };

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
