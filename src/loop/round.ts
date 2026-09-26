/**
 * One round, composed: gate on the pull request, run the reviewer, post what it
 * found, apply what it ruled, and return what the round concluded.
 *
 * **A round the reviewer failed is not a round that found nothing.** The
 * reviewer's own outcome is carried out to the caller, so a round killed at its
 * time bound, a reviewer nothing could be read from and a setup problem are each
 * distinct from an honest empty review, and none of them can be read as a clean
 * pass. That distinction is the whole reason the loop is worth running.
 *
 * Nothing here throws. Every outcome is a value the caller reads, because the
 * round runs inside a hook that may fail in any way except by preventing the
 * coding agent from finishing.
 *
 * Nothing here exits, and nothing here decides whether another round happens.
 * The exit code is the hook's, and the block-or-close arithmetic belongs to the
 * decision this calls.
 */

import { mkdirSync } from "node:fs";

import type { Config } from "../config/config.ts";
import type { GhCall } from "../github/gh.ts";
import { fetchDiff, findPullRequestForBranch, type PullRequest } from "../github/pull-request.ts";
import { listReviewThreads, type ReviewThread, type ThreadAnchor } from "../github/threads.ts";
import { currentBranch } from "../hook/branch.ts";
import {
  unspent,
  type Adapter,
  type RoundCost,
  type RoundOutput,
  type ThreadVerdict,
} from "../reviewers/adapter.ts";
import { deadlineIn, type Deadline } from "../reviewers/deadline.ts";
import { composePrompt } from "../reviewers/prompt.ts";
import { runRound as runReview, type Round as Review } from "../reviewers/round.ts";
import {
  readState,
  recordRound,
  recordSpendOutsideRounds,
  writeState,
  type EpisodeState,
} from "./episode-state.ts";
import type { Episode } from "./episode.ts";
import { postFindings, type PostedFindings, type Threaded } from "./post-findings.ts";
import { blockingReason } from "./reason.ts";
import {
  decideAfterRound,
  tokenBoundIsReached,
  type ClosingReason,
  type EpisodeBounds,
} from "./round-decision.ts";
import { applyVerdicts, type AppliedVerdict, type AppliedVerdicts } from "./verdicts.ts";
import { HOOK_CEILING_MS, POSTING_MARGIN_MS, PRE_REVIEW_MARGIN_MS } from "./window.ts";

/** What one round needs to run. */
export type RoundSetup = {
  /**
   * The episode this round belongs to. Its worktree is where git and `gh` are
   * asked from and where the reviewer runs; its own directory is where the
   * round's state, the reviewer's session and its scratch space live.
   */
  readonly episode: Episode;
  readonly config: Config;
  /** The reviewer CLI this project runs. */
  readonly adapter: Adapter;
  /** The charter file handed to the reviewer, which is the same every round. */
  readonly charterFile: string;
  /**
   * A posting margin below the round's own, so that a test can reach the bound
   * without waiting two minutes out.
   *
   * It only lowers: a larger value is ignored, and no configuration is read to
   * set it. The margin is not a project's to raise.
   */
  readonly marginMs?: number;
  /**
   * The round's whole window, below its own, so that a test can reach any of its
   * shares without waiting ten minutes out.
   *
   * It only lowers, like the posting margin, and for the same reason.
   */
  readonly windowMs?: number;
};

/** Why a round reported a failure, and whose failure it was. */
export type RoundFailure =
  /** The reviewer was killed at its time bound, so the round has no findings. */
  | "timed-out"
  /** Output no fresh reviewer process could be read either. */
  | "unavailable"
  /** Something that will fail the same way next round, so it is not one bad round. */
  | "setup"
  /** The harness's own: the gate, GitHub, the state file, or a defect in here. */
  | "harness";

/** What the round did, whatever it concluded. */
export type RoundAccount = {
  readonly pullRequest: number;
  /**
   * The threads this round's findings opened, by id.
   *
   * A comment that landed and whose thread id did not come back is not here,
   * because nothing can be addressed to it. What became of every finding is in
   * `findings`, which is where a caller reads the ones nothing carries.
   */
  readonly posted: readonly string[];
  /** What became of every finding the reviewer returned, one outcome each. */
  readonly findings: PostedFindings;
  /** What the round did to the threads it handed over, and what it refused to do. */
  readonly verdicts: AppliedVerdicts;
};

/** What one round concluded. */
export type RoundConclusion =
  /** No open pull request has this branch as its head: nothing ran, nothing posted. */
  | { readonly outcome: "no-pull-request" }
  /** Another round. The coding agent is handed the open threads, with this reason. */
  | ({ readonly outcome: "block"; readonly reason: string } & RoundAccount)
  /** The episode is over, for the reason the decision gave. */
  | ({ readonly outcome: "close"; readonly because: ClosingReason } & RoundAccount)
  /**
   * The round failed. Never a clean pass: `failure` says whose failure it was,
   * and an honest empty review is not one of them.
   */
  | {
      readonly outcome: "failed";
      readonly failure: RoundFailure;
      readonly reason: string;
      /**
       * What the round put on the pull request before it reported the failure.
       *
       * Absent where there was nothing to put there: every failure before the
       * review, and every reviewer that failed having confirmed nothing. A round
       * carrying one is a failed round that salvaged something, and never a
       * round that reviewed.
       */
      readonly salvaged?: RoundAccount;
    };

/**
 * Run one round of the loop and return what it concluded.
 *
 * Never throws, whatever git, `gh`, the filesystem or the reviewer does.
 */
export async function runRound(setup: RoundSetup): Promise<RoundConclusion> {
  try {
    return await round(setup);
  } catch (cause) {
    // A throw here is this harness's own defect. The round is still a value.
    return failed("harness", `the round could not be run: ${reasonFor(cause)}`);
  }
}

/** A step's answer, or the conclusion the round ended on instead of one. */
type Step<T> = { readonly step: T } | { readonly ended: RoundConclusion };

async function round(setup: RoundSetup): Promise<RoundConclusion> {
  const { episode, config } = setup;
  const directory = episode.worktree;

  // The round's whole window, measured from here. Every phase of the round is
  // bounded by what is left of this one moment rather than by an allowance handed
  // out when the phase begins, so no phase can put what it overran on top of the
  // window instead of inside it.
  const window = deadlineIn(lowered(setup.windowMs, HOOK_CEILING_MS));
  const postingMs = lowered(setup.marginMs, POSTING_MARGIN_MS);
  // The moment the review has to be over by: the window, less what is kept back
  // to put the review on the pull request. What the calls before the review spend
  // comes off the reviewer's bound rather than off that, so a slow GitHub
  // shortens the review instead of pushing the round past the ceiling.
  const beforePosting = deadlineIn(Math.max(0, window.remaining() - postingMs));
  // One deadline over the whole phase, not a bound on each of its calls. The
  // threads listing pages, so how many calls the phase makes is not known in
  // advance, and a bound per call lets every page have the whole of one.
  const preReview: GhCall = {
    directory,
    until: deadlineIn(Math.min(PRE_REVIEW_MARGIN_MS, beforePosting.remaining())),
  };

  const gated = gate(preReview);
  if ("ended" in gated) return gated.ended;
  const pullRequest = gated.step;

  const stateRead = openState(episode, pullRequest.number);
  if ("ended" in stateRead) return stateRead.ended;
  const state = stateRead.step;

  const bounds: EpisodeBounds = { rounds: config.rounds, tokens: config.tokens };
  const over = exhausted(state, bounds);
  if (over !== null) {
    return { outcome: "close", because: over, ...nothingDone(pullRequest.number) };
  }

  // Round 1 hands the reviewer nothing to rule on. From round 2 on every thread
  // on the pull request goes over with its comments and resolved state, which is
  // the whole of what a reviewer holding no state knows about the rounds before
  // it.
  const firstRound = state.rounds.length === 0;
  const listing = firstRound ? noThreads : handOver(pullRequest, preReview);
  if ("ended" in listing) return listing.ended;
  const handedOver = listing.step;

  const fetched = fetchDiff(pullRequest.number, preReview);
  if (fetched.outcome !== "fetched") {
    return failed(
      "harness",
      `no review ran: the diff of ${named(pullRequest)} could not be fetched: ${fetched.reason}`,
    );
  }

  const unmade = makeDirectories(episode);
  if (unmade !== null) return failed("harness", `no review ran: ${unmade}`);

  const seconds = reviewSeconds(config.timeout, beforePosting);
  if (seconds === null) {
    return failed(
      "harness",
      "no review ran: the calls before it spent the time the round had to review in",
    );
  }

  const review = await runReview(
    setup.adapter,
    {
      directory,
      charterFile: setup.charterFile,
      prompt: composePrompt({ pullRequest, diff: fetched.diff, threads: handedOver }),
      sessionDirectory: episode.sessionDirectory,
      scratchDirectory: episode.scratchDirectory,
      thinking: config.thinking,
      depth: config.depth,
    },
    seconds,
  );

  const recording = keepCost(episode, state, review);
  if ("ended" in recording) return recording.ended;
  const recorded = recording.step;

  // What is left of the window, and never more than the margin kept back for
  // posting. The reviewer's own cleanup runs after the moment the review had to
  // be over by, and a margin that started afresh here would spend that overrun
  // again past the end of the window.
  const posting: Posting = {
    pullRequest,
    diff: fetched.diff,
    directory,
    margin: deadlineIn(Math.min(window.remaining(), postingMs)),
  };

  if (review.outcome !== "reviewed") return salvage(review, handedOver, posting);

  const account = report(review, handedOver, posting);
  const threads = [
    ...settled(handedOver, account.verdicts.threads),
    ...threadsOpened(account.findings),
  ];

  const decision = decideAfterRound(
    {
      openThreads: threads.filter((thread) => !thread.isResolved).length,
      // The recorded entries are the rounds that have run, this one included,
      // which is the count the cap does its arithmetic on.
      roundsRun: recorded.rounds.length,
      tokens: review.cost.tokens,
    },
    bounds,
  );

  if (decision.next === "close") {
    return { outcome: "close", because: decision.because, ...account };
  }
  return {
    outcome: "block",
    reason: blockingReason({ pullRequest: pullRequest.number, posted: account.posted, threads }),
    ...account,
  };
}

/**
 * The pull request this round reviews, or the conclusion the gate reached.
 *
 * A branch with no pull request is silent: no review runs and nothing is posted.
 * A git or a `gh` that could not answer is a failure and is named, because an
 * install that failed and read as a branch with no pull request looks exactly
 * like the harness working normally, every round and forever. The time for
 * GitHub running out is one of those, and never an answer of none.
 */
function gate(call: GhCall): Step<PullRequest> {
  const branch = currentBranch(call.directory);
  if (branch.outcome === "failed") {
    return {
      ended: failed(
        "harness",
        `no review ran: the current branch could not be resolved: ${branch.reason}`,
      ),
    };
  }
  // A detached HEAD is no branch, so no pull request can have it as a head. An
  // answer of none rather than a failure, and none is silent.
  if (branch.outcome === "detached") return { ended: { outcome: "no-pull-request" } };

  const lookup = findPullRequestForBranch(branch.name, call);
  if (lookup.outcome === "failed") {
    const asked = JSON.stringify(branch.name);
    return {
      ended: failed(
        "harness",
        `no review ran: the pull request for ${asked} could not be looked up: ${lookup.reason}`,
      ),
    };
  }
  if (lookup.outcome === "none") return { ended: { outcome: "no-pull-request" } };
  return { step: lookup };
}

/**
 * The episode's state as this round starts, or the conclusion it ended on.
 *
 * A state file that will not read back ends the round before the reviewer runs.
 * The round count is the only bound on the loop, and a round that reviewed on a
 * count it could not read would start the count again on every firing.
 *
 * The pull request is the one the gate found rather than the one the file names.
 * The rounds recorded are the episode's however many pull requests they read,
 * and the cap and the token bound are the episode's too.
 */
function openState(episode: Episode, pullRequest: number): Step<EpisodeState> {
  const read = readState(episode);
  if (read.outcome === "unreadable") {
    return { ended: failed("harness", `no review ran: ${read.reason}`) };
  }
  if (read.outcome === "absent") {
    return { step: { pullRequest, rounds: [], spentOutsideRounds: unspent } };
  }
  return { step: { ...read.state, pullRequest } };
}

/**
 * Why the episode is over before this round runs, or `null` where a round is
 * left to run.
 *
 * Read from the state as it stands, before a reviewer is spawned. A bound
 * checked only once the round has finished is not a bound: the tokens are spent
 * by the time the arithmetic sees it, and a round the reviewer failed never
 * reaches the arithmetic at all. Both are reachable — an episode that recorded a
 * round and fired again, and a cap or a token bound lowered between firings —
 * and nothing outside this stops a hook that keeps reviewing.
 *
 * A cap of R allows R rounds, so the round about to run is the one after the
 * count already recorded. A cap that is not a whole number leaves no round,
 * because nothing here may spend a review on a number it cannot count.
 */
function exhausted(state: EpisodeState, bounds: EpisodeBounds): ClosingReason | null {
  if (tokenBoundIsReached(widestAttempt(state), bounds.tokens)) return "token-bound";
  if (!Number.isInteger(bounds.rounds) || state.rounds.length >= bounds.rounds) {
    return "round-cap";
  }
  return null;
}

/** What a round that ran nothing did, which is nothing, said rather than implied. */
function nothingDone(pullRequest: number): RoundAccount {
  return {
    pullRequest,
    posted: [],
    findings: { outcomes: [] },
    verdicts: { threads: [], unapplied: [], reopened: 0 },
  };
}

/** What round 1 hands over: nothing, because no round has opened a thread yet. */
const noThreads: Step<readonly ReviewThread[]> = { step: [] };

/**
 * Every thread on the pull request, which is what the reviewer rules on.
 *
 * A listing that failed ends the round with nothing posted. Handing over none
 * instead would ask for a fresh review of code the reviewer has already
 * commented on, and every finding of the round before would go up a second time.
 */
function handOver(pullRequest: PullRequest, call: GhCall): Step<readonly ReviewThread[]> {
  const listed = listReviewThreads(pullRequest.nodeId, call);
  if (listed.outcome !== "listed") {
    return {
      ended: failed(
        "harness",
        `no review ran: the threads on ${named(pullRequest)} could not be listed: ${listed.reason}`,
      ),
    };
  }
  return { step: listed.threads };
}

/**
 * The reviewer's session directory and its scratch space, or why they could not
 * be made.
 *
 * Made here because the reviewer is started here: its CLI is told to write into
 * both and creates neither, and a scratch space that does not exist leaves the
 * reviewer's temporary files landing in the tree under review.
 */
function makeDirectories(episode: Episode): string | null {
  for (const directory of [episode.sessionDirectory, episode.scratchDirectory]) {
    try {
      mkdirSync(directory, { recursive: true });
    } catch (cause) {
      return `${directory} could not be made: ${reasonFor(cause)}`;
    }
  }
  return null;
}

/**
 * Record what the round spent, before it posts anything.
 *
 * The runtime can kill the hook during the posting that follows, and a round
 * whose cost was never recorded counts against neither the round cap nor the
 * token bound. A killed round's floor goes in for the same reason: what the
 * reviewer reported before it was stopped is what there is.
 *
 * A setup problem records what it spent without recording a round.
 */
function keepCost(episode: Episode, state: EpisodeState, review: Review): Step<EpisodeState> {
  const recorded = withSpend(state, review);
  // Nothing was spent and no round ran, so there is nothing to keep. Writing
  // anyway would put a write that could fail in front of the reason the reviewer
  // gave, and report the wrong failure.
  if (recorded === null) return { step: state };

  const written = writeState(episode, recorded);
  if (written.outcome === "failed") {
    // Nothing is posted on a state file that would not take the round. A round
    // that posted its findings and recorded nothing is one the next round
    // repeats comment for comment.
    return { ended: failed("harness", `nothing was posted: ${written.reason}`) };
  }
  return { step: recorded };
}

/**
 * The state with this attempt's spend in it, or `null` where it spent nothing and
 * was no round.
 *
 * Two ledgers, and an attempt goes in exactly one of them. A round appends its
 * cost, and the entry count is what the cap spends. A setup problem spends no
 * round, and what it spent is added to the episode's spend all the same: an
 * attempt can complete a paid response and still end as a setup problem, and an
 * episode that forgot those tokens would hand another reviewer a bound it had
 * already reached.
 */
function withSpend(state: EpisodeState, review: Review): EpisodeState | null {
  if (isRound(review)) return recordRound(state, review.cost);
  if (nothingSpent(review.cost)) return null;
  return recordSpendOutsideRounds(state, review.cost);
}

function nothingSpent(cost: RoundCost): boolean {
  return cost.dollars === 0 && cost.tokens === 0 && cost.messages === 0;
}

/**
 * Whether the attempt was a round, which is what decides whether it spends one
 * of the cap.
 *
 * A reviewer that would not start and one that ran and completed no message are
 * a setup problem rather than a bad round. Both fail the same way every firing
 * until someone fixes the install or the credential, and charging the cap for
 * them would leave a project no rounds once it had. Neither can run the loop
 * away either: a setup problem never blocks, so the coding agent's turn ends and
 * no further round fires.
 *
 * Every other outcome is a round. A round killed at its bound and output no fresh
 * process could read both got as far as reviewing, and an empty review is a round
 * that did the work and found nothing. Reading the cost instead of the outcome
 * would decide this on a figure that is zero for a reviewer no price can be read
 * for, and the count would then never advance at all.
 *
 * This decides the cap alone. What the attempt spent is recorded either way.
 */
function isRound(review: Review): boolean {
  return review.outcome !== "setup";
}

/** Where a round's review goes, and the deadline every call putting it there runs under. */
type Posting = {
  readonly pullRequest: PullRequest;
  /** The pull request's diff, which decides where each finding's comment can hang. */
  readonly diff: string;
  readonly directory: string;
  /**
   * What is left of the window, capped at the share kept back for posting. One
   * deadline over the whole phase, and a call with nothing left on it is not made
   * at all.
   */
  readonly margin: Deadline;
};

/**
 * Put what the reviewer reported on the pull request: its verdicts, then its
 * findings.
 *
 * The verdicts go first. One that is not applied leaves a thread in a state the
 * reviewer did not rule on, and the round then blocks the coding agent over a
 * finding it was told was settled; a finding that is not posted is one the next
 * round reads the same code and makes again.
 *
 * `ruleOn` is the threads a verdict may reach. One in it that the reviewer ruled
 * on nowhere takes the default verdict, so what a caller passes is what decides
 * whether the reviewer's silence about a thread counts as a ruling on it.
 */
function report(output: RoundOutput, ruleOn: readonly ReviewThread[], on: Posting): RoundAccount {
  const call = { directory: on.directory, until: on.margin };
  const calls = ruleOn.length + 2 * output.findings.length;

  const verdicts = applyVerdicts(ruleOn, output.verdicts, {
    ...call,
    boundMs: share(on.margin, calls),
  });

  const findings = postFindings(
    {
      findings: output.findings,
      diff: on.diff,
      pullRequest: on.pullRequest.number,
      headSha: on.pullRequest.headSha,
    },
    { ...call, boundMs: share(on.margin, 2 * output.findings.length) },
  );

  return {
    pullRequest: on.pullRequest.number,
    posted: threadsOpened(findings).map((thread) => thread.id),
    findings,
    verdicts,
  };
}

type FailedReview = Exclude<Review, { readonly outcome: "reviewed" }>;

/**
 * A round the reviewer failed, with what it had reported already on the pull
 * request.
 *
 * **Still a failed round, whatever it posted.** The outcome is the reviewer's
 * own, the cost recorded before this stands as a floor, and no block-or-close
 * decision is asked for.
 *
 * The posting runs on the round's own margin, which is what is left of the one
 * window. A round that reached its time bound has spent most of that window, and
 * a fresh allowance here would put its calls past the ceiling, where the hook
 * and everything under it are signalled together and nothing is reported at all.
 *
 * A reviewer that confirmed nothing before it failed leaves nothing to put up,
 * and no call is made.
 */
function salvage(
  review: FailedReview,
  handedOver: readonly ReviewThread[],
  on: Posting,
): RoundConclusion {
  const kept = review.findings.length;
  if (kept === 0 && review.verdicts.length === 0) {
    return failed(review.outcome, reviewerFailed(review, 0));
  }
  return {
    outcome: "failed",
    failure: review.outcome,
    reason: reviewerFailed(review, kept),
    salvaged: report(review, ruledOn(handedOver, review.verdicts), on),
  };
}

/**
 * The threads a failed round's verdicts may reach: the ones the reviewer ruled
 * on, and no others.
 *
 * A thread the reviewer returned no verdict for is treated as open, which
 * re-opens it where it was closed. That default reads the reviewer's silence as a
 * ruling, and a review that did not finish was silent about every thread it never
 * got to. Those are left exactly as they were found, for a later round to rule on.
 */
function ruledOn(
  handedOver: readonly ReviewThread[],
  verdicts: readonly ThreadVerdict[],
): readonly ReviewThread[] {
  const ruled = new Set(verdicts.map((verdict) => verdict.thread));
  return handedOver.filter((thread) => ruled.has(thread.id));
}

/**
 * The one line a round the reviewer failed is reported as, `kept` being how many
 * findings the reviewer had confirmed before it failed.
 *
 * What became of those findings is not said here. A round that could not post
 * one of them is reported where every other failure to post is.
 */
function reviewerFailed(review: FailedReview, kept: number): string {
  switch (review.outcome) {
    case "timed-out":
      return `the reviewer was killed at its ${review.seconds}-second bound, and the round ${keptBy(kept)}`;
    case "unavailable":
      return alsoKept(`the review did not run: ${review.reason}`, kept);
    case "setup":
      return alsoKept(`the reviewer could not run: ${review.reason}`, kept);
  }
}

/** What a failed round has of the review, as its own line says it. */
function keptBy(kept: number): string {
  if (kept === 0) return "recorded no findings";
  return `kept the ${kept} ${kept === 1 ? "finding" : "findings"} the reviewer had reported`;
}

/** The reviewer's own words, and what the round kept where it kept anything. */
function alsoKept(failure: string, kept: number): string {
  return kept === 0 ? failure : `${failure}; the round ${keptBy(kept)}`;
}

/**
 * The threads the round handed over, each in the state its verdict left it in.
 *
 * Computed from what the round did rather than read back a second time. Every
 * identifier came from GitHub, so the agent that checks the reason against the
 * pull request finds the threads the reason named.
 *
 * A thread finds its verdict by the identifier the verdict names. A round need
 * not have offered every thread it handed over to a verdict, and one read off its
 * position in the list would take the ruling on whichever thread sat there.
 */
function settled(
  handedOver: readonly ReviewThread[],
  ruled: readonly AppliedVerdict[],
): readonly ReviewThread[] {
  const acted = new Map(ruled.map((verdict) => [verdict.thread, verdict]));
  return handedOver.map((thread) => ({
    ...thread,
    isResolved: leftResolved(thread, acted.get(thread.id)),
  }));
}

/**
 * Whether the thread is resolved now its verdict has been applied.
 *
 * A mutation that failed leaves the thread as it was handed over, which is the
 * only state anything established about it.
 */
function leftResolved(thread: ReviewThread, ruled: AppliedVerdict | undefined): boolean {
  switch (ruled?.outcome) {
    case "closed":
      return true;
    case "reopened":
    case "left-open":
      return false;
    default:
      return thread.isResolved;
  }
}

/**
 * The threads this round's own findings opened.
 *
 * Their identifiers came back from the read-back each create makes, so a later
 * round and the coding agent can both address them. A comment that landed
 * without one is left out: nothing can be addressed to it, and a reason that
 * counted it would name fewer threads than it claimed.
 */
function threadsOpened(posted: PostedFindings): readonly ReviewThread[] {
  const threads: ReviewThread[] = [];
  for (const outcome of posted.outcomes) {
    if (outcome.outcome !== "threaded") continue;
    const opened = asThread(outcome);
    if (opened !== null) threads.push(opened);
  }
  return threads;
}

/**
 * One finding's new thread, as the blocking reason lists it.
 *
 * `null` where nothing can be addressed to it: a comment whose thread id did not
 * come back, and a finding carrying no file, which is one no thread was opened
 * for at all.
 */
function asThread(outcome: Threaded): ReviewThread | null {
  const { finding, threadId } = outcome;
  if (threadId === null || finding.file === undefined) return null;
  return {
    id: threadId,
    // The round just opened it, and only a verdict closes a thread.
    isResolved: false,
    // Nothing has moved under a thread opened against the head just read.
    isOutdated: false,
    path: finding.file,
    anchor: anchorOf(outcome),
    // The round holds no read-back of the comment it wrote, and what reads this
    // reads the identifier and the location.
    comments: [],
  };
}

/** Where the comment went: the line the finding named, or the file as a whole. */
function anchorOf(outcome: Threaded): ThreadAnchor {
  if (outcome.placement === "file" || outcome.finding.line === undefined) return { at: "file" };
  return { at: "line", line: outcome.finding.line };
}

/**
 * The larger of the episode's widest round and everything it spent on attempts
 * that were no round, in tokens.
 *
 * Both ledgers, because an attempt that failed before it was a round was paid
 * for all the same. A reviewer that burns the bound's worth and reports nothing
 * would otherwise be handed another round to do it again. The second ledger is a
 * running total, so repeated paid attempts reach the bound together where no one
 * of them would.
 */
function widestAttempt(state: EpisodeState): number {
  const rounds = state.rounds.map((cost) => cost.tokens);
  return Math.max(0, ...rounds, state.spentOutsideRounds.tokens);
}

/**
 * One call's fair share of what is left of the margin, where `calls` is what the
 * phase is expected to make.
 *
 * A share and not the bound. The margin is enforced as a deadline every call
 * runs under, and this only stops one slow call from spending what the rest of
 * the phase needs. The count is an estimate, and the read-back after a create
 * can page, so a phase may make more calls than its share was split for and the
 * deadline is what holds either way.
 *
 * Never zero: a bound that is not a positive number is read as no bound asked
 * for and falls back to the ceiling on a single call.
 */
function share(margin: Deadline, calls: number): number {
  return Math.max(1, Math.floor(margin.remaining() / Math.max(1, calls)));
}

/**
 * How long the reviewer may run, in whole seconds: what the project configured,
 * or what the calls before it left of the window, whichever is smaller. `null`
 * where nothing is left to review in.
 *
 * Whole seconds, because that is what the bound is stated in and what a killed
 * round reports. A round with no time to review in reports that rather than
 * starting a reviewer it would kill at once, which would spend a round of the
 * cap on a review nobody could have done.
 */
function reviewSeconds(configured: number, beforePosting: Deadline): number | null {
  const seconds = Math.min(configured, Math.floor(beforePosting.remaining() / 1_000));
  return seconds < 1 ? null : seconds;
}

/** A share of the window, or a smaller one asked for. It only lowers. */
function lowered(asked: number | undefined, whole: number): number {
  if (asked === undefined || !Number.isFinite(asked) || asked <= 0) return whole;
  return Math.min(asked, whole);
}

function named(pullRequest: PullRequest): string {
  return `PR #${pullRequest.number}`;
}

function failed(failure: RoundFailure, reason: string): RoundConclusion {
  return { outcome: "failed", failure, reason };
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
