/**
 * Applying the reviewer's verdicts to the threads the round handed it: closing
 * the ones it ruled settled, re-opening the ones it ruled still wrong, leaving
 * the rest as they are.
 *
 * A verdict reaches its thread by the GraphQL `PRRT_` node id and by nothing
 * else. It is the only identifier the resolve mutations take, and a verdict read
 * off its position in a list closes whichever thread happens to sit there.
 *
 * Nothing here throws, and nothing is sent on the strength of an identifier the
 * round did not hand over. Every failure arrives as a value, because the round
 * around this has to exit 0 whatever GitHub did.
 */

import { defaultVerdict, type Verdict } from "../findings/status.ts";
import type { GhCall } from "../github/gh.ts";
import { reopenThread, resolveThread, type ThreadAction } from "../github/thread-actions.ts";
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
} & VerdictOutcome;

/** A verdict the round did not apply, and the reason it did not. */
export type UnappliedVerdict = ThreadVerdict & { readonly reason: string };

/** What the round did to the threads it handed over, and what it refused to do. */
export type AppliedVerdicts = {
  /** One entry per thread handed over, in that order, ruled on or not. */
  readonly threads: readonly AppliedVerdict[];
  readonly unapplied: readonly UnappliedVerdict[];
  /**
   * How many threads this round re-opened.
   *
   * A count beside the outcomes rather than a state a thread can be in: a
   * thread that was closed and is open again still ends its episode in one of
   * the statuses every thread ends in.
   */
  readonly reopened: number;
};

/**
 * Apply each verdict to the thread it names, and hand back what happened to
 * every thread.
 *
 * `fixed` and `withdrawn` close the thread. `open` re-opens one that was closed
 * and leaves an open one alone. A thread the reviewer returned no verdict for
 * takes the default, which is what stops a thread it forgot from being closed
 * by the forgetting.
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
  return {
    threads,
    unapplied: rulings.unapplied,
    reopened: threads.filter((thread) => thread.outcome === "reopened").length,
  };
}

/** The verdicts to apply, keyed by thread, and the ones that go unapplied. */
type Rulings = {
  readonly byThread: ReadonlyMap<string, Verdict>;
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
  const byThread = new Map<string, Verdict>();
  const unapplied: UnappliedVerdict[] = [];

  for (const returned of verdicts) {
    if (!handed.has(returned.thread)) {
      unapplied.push({ ...returned, reason: "no thread with that id was handed to the reviewer" });
      continue;
    }
    if (byThread.has(returned.thread)) {
      unapplied.push({
        ...returned,
        reason: "the reviewer ruled on that thread more than once, and the first ruling stands",
      });
      continue;
    }
    byThread.set(returned.thread, returned.verdict);
  }
  return { byThread, unapplied };
}

/**
 * Put one thread into the state its verdict asks for.
 *
 * A close is sent whether or not the thread was already closed. The mutation's
 * own report is the only evidence the round has that the thread is closed, and
 * the resolved state it was handed over with was read before the coding agent
 * took its turn. Resolving a resolved thread succeeds.
 */
function apply(thread: HandedOverThread, ruled: Verdict | null, call: GhCall): AppliedVerdict {
  const named = { thread: thread.id, ruled };
  switch (ruled ?? defaultVerdict) {
    case "fixed":
    case "withdrawn":
      return { ...named, ...outcomeOf(resolveThread(thread.id, call), "closed") };
    case "open":
      // A thread that is open is already in the state the verdict asks for.
      if (!thread.isResolved) return { ...named, outcome: "left-open" };
      return { ...named, ...outcomeOf(reopenThread(thread.id, call), "reopened") };
  }
}

/** What the mutation did, or the reason it did nothing. */
function outcomeOf(action: ThreadAction, acted: "closed" | "reopened"): VerdictOutcome {
  if (action.outcome === "failed") return { outcome: "failed", reason: action.reason };
  return { outcome: acted };
}
