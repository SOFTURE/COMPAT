export type PollUrlOptions = {
  url: string;
  headers?: Record<string, string>;
  /** Epoch milliseconds after which polling gives up. */
  deadline: number;
  intervalMs?: number;
  /** Whether a 2xx body is the awaited one; a starting app may answer 200 with a placeholder. */
  accept?: (body: string) => boolean;
  /** Checked before each attempt; a reason ends polling early (for example: the app exited). */
  getStopReason?: () => string | null;
};

export type PollUrlOutcome =
  | { status: "ready"; body: string }
  | { status: "stopped"; reason: string; lastObservation: string }
  | { status: "timed-out"; lastObservation: string };

const DEFAULT_INTERVAL_MS = 500;
const MAX_REQUEST_MS = 10_000;
const NO_RESPONSE_YET = "no response yet";
const REQUEST_TIMED_OUT = "request timed out";

/**
 * Fetches `url` until it answers 2xx with an accepted body. Each outcome other than `ready`
 * carries the last observation (`HTTP 401`, `connection refused`, ...) so errors can say why.
 */
export async function pollUrl(options: PollUrlOptions): Promise<PollUrlOutcome> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let lastObservation = NO_RESPONSE_YET;
  for (;;) {
    const stopReason = options.getStopReason?.() ?? null;
    if (stopReason !== null) return { status: "stopped", reason: stopReason, lastObservation };
    const remainingMs = options.deadline - Date.now();
    if (remainingMs <= 0) return { status: "timed-out", lastObservation };
    const requestMs = Math.min(remainingMs, MAX_REQUEST_MS);
    const attempt = await fetchOnce(options, requestMs);
    if (attempt.status === "ready") return attempt;
    // A request the deadline cut short says nothing new; keep the answer the app gave before it.
    const isCutByDeadline = attempt.observation === REQUEST_TIMED_OUT && requestMs < MAX_REQUEST_MS;
    if (!isCutByDeadline || lastObservation === NO_RESPONSE_YET) lastObservation = attempt.observation;
    const waitMs = Math.min(intervalMs, options.deadline - Date.now());
    if (waitMs > 0) await new Promise((done) => setTimeout(done, waitMs));
  }
}

type Attempt = { status: "ready"; body: string } | { status: "not-ready"; observation: string };

async function fetchOnce(options: PollUrlOptions, timeoutMs: number): Promise<Attempt> {
  let response: Response;
  try {
    response = await fetch(options.url, { headers: options.headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { status: "not-ready", observation: describeFetchError(error) };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { status: "not-ready", observation: `HTTP ${response.status}` };
  }
  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    return { status: "not-ready", observation: describeFetchError(error) };
  }
  if (options.accept && !options.accept(body)) {
    return {
      status: "not-ready",
      observation: `HTTP ${response.status} with a body that is not the awaited document`,
    };
  }
  return { status: "ready", body };
}

/** Why a fetch threw, in a few words: `request timed out`, `connection refused`, ... */
export function describeFetchError(error: unknown): string {
  const failure = error as { name?: string; cause?: { code?: string } };
  if (failure.name === "TimeoutError") return REQUEST_TIMED_OUT;
  const code = failure.cause?.code;
  if (code === "ECONNREFUSED") return "connection refused";
  if (code === "ECONNRESET") return "connection reset";
  return code ? `request failed (${code})` : "request failed";
}
