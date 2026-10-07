/**
 * Applying the reviewer's verdicts to the threads the round handed it: closing
 * the ones it ruled settled, re-opening the ones it ruled still wrong and
 * replying on them with its reason, leaving the rest as they are.
 *
 * A verdict reaches its thread by the GraphQL `PRRT_` node id and by nothing
 * else. It is the only identifier the resolve mutations take, and a verdict read
 * off its position in a list closes whichever thread happens to sit there.
 *
 * Nothing here throws, and nothing is sent on the strength of an identifier the
 * round did not hand over. Every failure arrives as a value, because the round
 * around this has to exit 0 whatever GitHub did.
 */

import { renderOpenReason } from "../findings/comment.ts";
import { defaultVerdict, type Verdict } from "../findings/status.ts";
import type { GhCall } from "../github/gh.ts";
import { reopenThread, replyInThread, resolveThread, type ThreadAction } from "../github/thread-actions.ts";
import type { ThreadVerdict } from "../reviewers/adapter.ts";

/**
 * A thread as the round handed it to the reviewer.
 *
 * Structural, so the round's read-back of the pull request goes straight in.
 * Whether the thread was closed at hand-over is all an `open` verdict needs of
 * it, and nothing else about a thread decides what a verdict does to it.
 */
export type HandedOverThread = {
  readonly id: string;
  readonly isResolved: boolean;
};

/**
 * What became of one thread.
 *
 * `left-open` is a thread that was open and was ruled open, so nothing was sent
 * at all. `failed` is a mutation that did not do the work, and it is never read
 * as one that did.
 */
export type VerdictOutcome =
  | { readonly outcome: "closed" }
  | { readonly outcome: "reopened" }
  | { readonly outcome: "left-open" }
  | { readonly outcome: "failed"; readonly reason: string };

/** One thread, what the reviewer ruled on it, and what the round did about it. */
export type AppliedVerdict = {
  readonly thread: string;
  /**
   * What the reviewer ruled, `null` where it returned no verdict for the
   * thread.
   *
   * Carried as it arrived rather than with the default already applied, so that
   * a reader can still tell a thread the reviewer ruled open from one it passed
   * over.
   */
  readonly ruled: Verdict | null;
  /**
   * What became of the reviewer's reply giving its reason, on a thread it ruled
   * `open`. Absent on every other thread, which is owed no reply.
   *
   * A reply that failed leaves the verdict standing: the thread is in the state
   * it was ruled into either way.
   */
  readonly reply?: ThreadAction;
} & VerdictOutcome;

/**
 * A verdict the round did not apply, and the reason it did not.
 *
 * Only the thread and the ruling are kept. An `open` ruling's own reason is not
 * posted, and would otherwise share a name with why it was not applied.
 */
export type UnappliedVerdict = Pick<ThreadVerdict, "thread" | "verdict"> & { readonly reason: string };

/** What the round did to the threads it handed over, and what it refused to do. */
export type AppliedVerdicts = {
  /** One entry per thread handed over, in that order, ruled on or not. */
  readonly threads: readonly AppliedVerdict[];
  readonly unapplied: readonly UnappliedVerdict[];
};

/**
 * Apply each verdict to the thread it names, and hand back what happened to
 * every thread.
 *
 * `fixed` and `withdrawn` close the thread. `open` re-opens one that was closed
 * and leaves an open one alone, then posts the reviewer's reason as a reply on
 * it. A thread the reviewer returned no verdict for takes the default, which is
 * what stops a thread it forgot from being closed by the forgetting, and is
 * replied on by nobody: the reviewer gave no reason.
 *
 * A verdict naming a thread that was not handed over is reported and never
 * sent.
 *
 * Never throws. A mutation that failed, including one GitHub refused inside an
 * HTTP 200, comes back as `failed` on its own thread and leaves the others
 * alone.
 */
export function applyVerdicts(
  handedOver: readonly HandedOverThread[],
  verdicts: readonly ThreadVerdict[],
  call: GhCall,
): AppliedVerdicts {
  const rulings = rulingsFor(handedOver, verdicts);
  const threads = handedOver.map((thread) =>
    apply(thread, rulings.byThread.get(thread.id) ?? null, call),
  );
  return { threads, unapplied: rulings.unapplied };
}

/**
 * The verdict `applyVerdicts` will apply to each thread, by thread id, read
 * before anything is sent.
 */
export function rulingsOn(
  handedOver: readonly HandedOverThread[],
  verdicts: readonly ThreadVerdict[],
): Record<string, Verdict> {
  const { byThread } = rulingsFor(handedOver, verdicts);
  return Object.fromEntries(
    handedOver.map((thread) => [thread.id, byThread.get(thread.id)?.verdict ?? defaultVerdict]),
  );
}

/** The verdicts to apply, keyed by thread, and the ones that go unapplied. */
type Rulings = {
  readonly byThread: ReadonlyMap<string, ThreadVerdict>;
  readonly unapplied: readonly UnappliedVerdict[];
};

/**
 * Key each verdict on the thread it names, keeping only those naming a thread
 * this round handed over.
 *
 * A second verdict for one thread is held out rather than overwriting the
 * first, so which ruling gets applied does not depend on the order the reviewer
 * returned them in.
 */
function rulingsFor(
  handedOver: readonly HandedOverThread[],
  verdicts: readonly ThreadVerdict[],
): Rulings {
  const handed = new Set(handedOver.map((thread) => thread.id));
  const byThread = new Map<string, ThreadVerdict>();
  const unapplied: UnappliedVerdict[] = [];

  for (const returned of verdicts) {
    const ruling = { thread: returned.thread, verdict: returned.verdict };
    if (!handed.has(returned.thread)) {
      unapplied.push({ ...ruling, reason: "no thread with that id was handed to the reviewer" });
      continue;
    }
    if (byThread.has(returned.thread)) {
      unapplied.push({
        ...ruling,
        reason: "the reviewer ruled on that thread more than once, and the first ruling stands",
      });
      continue;
    }
    byThread.set(returned.thread, returned);
  }
  return { byThread, unapplied };
}

/**
 * Put one thread into the state its verdict asks for, and reply on it where the
 * reviewer kept it open.
 *
 * The reply goes whatever became of the state. A thread GitHub would not
 * re-open still holds a dispute, and the reason is what the coding agent acts on.
 */
function apply(thread: HandedOverThread, ruling: ThreadVerdict | null, call: GhCall): AppliedVerdict {
  const named = { thread: thread.id, ruled: ruling?.verdict ?? null };
  const state = setState(thread, ruling?.verdict ?? defaultVerdict, call);
  if (ruling?.verdict !== "open") return { ...named, ...state };
  return { ...named, ...state, reply: replyInThread(thread.id, renderOpenReason(ruling.reason), call) };
}

/**
 * Put one thread into the state `verdict` asks for.
 *
 * A close is sent whether or not the thread was already closed. The mutation's
 * own report is the only evidence the round has that the thread is closed, and
 * the resolved state it was handed over with was read before the coding agent
 * took its turn. Resolving a resolved thread succeeds.
 */
function setState(thread: HandedOverThread, verdict: Verdict, call: GhCall): VerdictOutcome {
  switch (verdict) {
    case "fixed":
    case "withdrawn":
      return outcomeOf(resolveThread(thread.id, call), "closed");
    case "open":
      // A thread that is open is already in the state the verdict asks for.
      if (!thread.isResolved) return { outcome: "left-open" };
      return outcomeOf(reopenThread(thread.id, call), "reopened");
  }
}

/**
 * Each reply giving the reviewer's reason that could not be posted, as one line
 * naming the thread and why.
 *
 * The verdict on each still stands, so these are what a person reads to learn
 * that a thread was kept open with no reason on it.
 */
export function unpostedReasons(verdicts: AppliedVerdicts): readonly string[] {
  return verdicts.threads.flatMap((applied) =>
    applied.reply?.outcome === "failed"
      ? [`the reviewer's reply on thread ${applied.thread} could not be posted: ${applied.reply.reason}`]
      : [],
  );
}

/**
 * Each ruling the round could not apply, as one line naming the thread, what the
 * reviewer ruled and why it was not applied.
 *
 * The thread stays as GitHub has it, so the line carries the ruling in full: it
 * is what a person reads to apply the ruling by hand.
 */
export function unappliedRulings(verdicts: AppliedVerdicts): readonly string[] {
  const refused = verdicts.threads.flatMap((applied) =>
    applied.outcome === "failed"
      ? [`${rulingOn(applied.thread, applied.ruled)}, and it could not be ${mutated(applied.ruled)}: ${applied.reason}`]
      : [],
  );
  const unsent = verdicts.unapplied.map(
    (ruling) =>
      `the reviewer ruled thread ${ruling.thread} ${ruling.verdict}, and the ruling was not applied: ${ruling.reason}`,
  );
  return [...refused, ...unsent];
}

/** What the reviewer ruled on `thread`, as the opening of a line. */
function rulingOn(thread: string, ruled: Verdict | null): string {
  if (ruled === null) return `the reviewer gave thread ${thread} no ruling, which keeps it open`;
  return `the reviewer ruled thread ${thread} ${ruled}`;
}

/** What the mutation a ruling asks for would have done to its thread. */
export function mutated(ruled: Verdict | null): "resolved" | "re-opened" {
  return (ruled ?? defaultVerdict) === "open" ? "re-opened" : "resolved";
}

/** What the mutation did, or the reason it did nothing. */
function outcomeOf(action: ThreadAction, acted: "closed" | "reopened"): VerdictOutcome {
  if (action.outcome === "failed") return { outcome: "failed", reason: action.reason };
  return { outcome: acted };
}
