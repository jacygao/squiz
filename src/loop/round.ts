/**
 * One round, composed: gate on the pull request and on the episode it keys, run
 * the reviewer, post what it found, apply what it ruled, post the episode's summary
 * where the round closed it or the failure comment where it failed, and return
 * what the round concluded.
 *
 * **A round the reviewer failed is not a round that found nothing.** The
 * reviewer's own outcome is carried out to the caller, so a round killed at its
 * time bound, a reviewer nothing could be read from and a setup problem are each
 * distinct from an honest empty review, and none of them can be read as a clean
 * pass. That distinction is the whole reason the loop is worth running.
 *
 * Nothing here throws. Every outcome is a value the caller reads, because the
 * round host has to record a result for every round it takes.
 *
 * A round has three parts, each on a deadline of its own: the calls before the
 * review, the review under the configured time bound, and posting under a
 * reserve that starts when the review ends.
 *
 * Nothing here exits, and nothing here decides whether another round happens.
 * The exit code is the caller's, and so is the block-or-close decision, which
 * the round asks for through `endsOn`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import type { Config } from "../config/config.ts";
import { latestActivity } from "../findings/activity.ts";
import { readThread } from "../findings/thread.ts";
import type { GhCall } from "../github/gh.ts";
import type { ClosedBy } from "../github/failure-body.ts";
import type { CommentPosting } from "../github/summary.ts";
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
import type { Backends, SessionPlace } from "../sessions/session.ts";
import type { Environment } from "../sessions/tmux.ts";
import { addSnapshot, removeSnapshot } from "../worktree/snapshot.ts";
import { takeHostLock, type HostLock } from "../host/lock.ts";
import {
  evidenceWith,
  nothingEstablished,
  readAfterReviewer,
  readBeforeReviewer,
  type RoundConfinement,
} from "./confinement.ts";
import {
  readState,
  recordPostingSeconds,
  recordRound,
  roundRecord,
  recordSpendOutsideRounds,
  type EpisodeState,
} from "./episode-state.ts";
import { episodeAt, roundDirectory, type Episode } from "./episode.ts";
import { updateState } from "./state-update.ts";
import { postFailure } from "./failure-comment.ts";
import {
  closedBeforeReview,
  lastReviewed,
  type LeftNotReviewed,
  type QueuedRecord,
  type RoundEnd,
  type StoppingBound,
} from "./round-end.ts";
import { sameState, type ReviewerPlace, type ReviewerSession, type StateKey } from "./state-record.ts";
import { postFindings, type PostedFindings, type Threaded } from "./post-findings.ts";
import { closedBeforeAnyRound, postEpisodeSummary, type EpisodeSummary } from "./post-summary.ts";
import { tokenBoundIsReached, type ClosingReason, type EpisodeBounds } from "./round-decision.ts";
import { applyVerdicts, type AppliedVerdict, type AppliedVerdicts } from "./verdicts.ts";

// Each `ps` run that tells whether a lock's holder is still running. Its own
// bound rather than the round's, because a round that cannot tell runs nothing.
const LOCK_BOUND_MS = 5_000;

/**
 * The part before the review: the pull request lookup, the threads listing, the
 * diff, and the fetch and add that make the snapshot.
 */
const BEFORE_REVIEW_MS = 30_000;

/** The part after the review: the findings, the verdicts and the comments. */
const POSTING_RESERVE_MS = 60_000;

/** What one round needs to run. */
export type RoundSetup = {
  /**
   * The coding agent's git work tree: where git and `gh` are asked from, and where
   * the episode of the pull request it finds keeps the round's state, its
   * snapshot, the reviewer's session and its scratch space.
   */
  readonly worktree: string;
  readonly config: Config;
  /** The reviewer CLI this project runs. */
  readonly adapter: Adapter;
  /** The charter file handed to the reviewer, which is the same every round. */
  readonly charterFile: string;
  /**
   * A posting reserve below the round's own, so that a test can reach it without
   * waiting a minute out.
   *
   * It only lowers: a larger value is ignored, and no configuration is read to
   * set it. The reserve is not a project's to raise.
   */
  readonly postingMs?: number;
  /**
   * A deadline for the calls before the review below the round's own, so that a
   * test can spend it without waiting it out.
   *
   * It only lowers, like the posting reserve, and for the same reason.
   */
  readonly preReviewMs?: number;
  /**
   * Whether a failed round posts its failure comment. It does unless a caller
   * asks otherwise, for a round whose failure is announced some other way.
   */
  readonly postsFailure?: boolean;
  /**
   * The episode's lock, where the caller holds it already. The round then takes
   * no lock and releases none, and runs only for the pull request the lock was
   * taken for.
   */
  readonly held?: HeldLock;
  /**
   * The state the caller took from the queue, which is the one its result is
   * recorded against. The round reviews this state's head, and reviews nothing
   * where the pull request has moved past it.
   */
  readonly state?: StateKey;
  /**
   * What the round ends on, which the caller decides from the states queued
   * behind this one. Asked once, after the findings and verdicts are posted,
   * with the queue as it stands under the state lock. The close it decides is
   * written in that same update, before any summary is posted, so no state can
   * be queued between the decision and the close.
   */
  readonly endsOn: (tally: RoundTally, queued: readonly QueuedRecord[]) => RoundEnd;
  /** The clock every part of the round is measured on, for a test to move. */
  readonly now?: () => number;
  /**
   * Chooses where the reviewer runs: a Herdr pane where it names a Herdr
   * server, a tmux window where it names a tmux server, and a child with no
   * terminal otherwise. Without one the reviewer is a child.
   */
  readonly sessionEnvironment?: Environment;
  /** What starts a session, where it is not the real backends. */
  readonly sessionBackends?: Backends;
  /** The Herdr workspace the reviewer's tab opens in, where the state's record names one. */
  readonly workspace?: string;
  /** Told the reviewer's session as soon as it has started, each time one does. */
  readonly reviewerStarted?: (session: ReviewerSession) => void;
  /** Told why a reviewer's pane could not be confirmed closed after it ended. */
  readonly paneLeftOpen?: (reason: string) => void;
  /**
   * Told why the round's snapshot could not be removed. The reason names where
   * it stands. Told once the round has its conclusion, which it never changes.
   */
  readonly snapshotLeft?: (reason: string) => void;
};

/** An episode's lock as its caller took it, and the pull request it was taken for. */
export type HeldLock = { readonly pullRequest: number; readonly lock: HostLock };

/** What a round that reviewed hands `endsOn` to decide from. */
export type RoundTally = {
  /** The node ids of the reviewer's threads left open now the verdicts are applied. */
  readonly openThreads: readonly string[];
  /** Rounds the episode has finished, counting from 1 and including this one. */
  readonly roundsRun: number;
  readonly tokens: number;
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

/** What the readings taken around the reviewer established. */
export type AroundTheReviewer = {
  /**
   * What the reviewer did to the tracked files and `HEAD` of its snapshot.
   * Absent where no reviewer ran, which is every conclusion reached before the
   * review.
   *
   * The round reports none of this itself. The summary comment, or a failed
   * round's failure comment, names what the readings found, and the round host
   * reports a move of `HEAD`. None of them changes what the round concluded.
   */
  readonly confinement?: RoundConfinement;
};

/** What one round concluded. */
export type RoundConclusion =
  /** No open pull request has this branch as its head: nothing ran, nothing posted. */
  | {
      readonly outcome: "no-pull-request";
      /** The branch the gate asked about, or `null` where HEAD was detached. */
      readonly branch: string | null;
      /** The worktree git was asked in. */
      readonly directory: string;
    }
  /**
   * The episode had already reported its close, so this firing ran nothing and
   * posted nothing. Its comment is on the pull request, or the firing that could
   * not post one said so.
   */
  | { readonly outcome: "episode-over" }
  /**
   * Another round of the episode holds its lock, so this firing ran nothing and
   * posted nothing.
   */
  | { readonly outcome: "round-running"; readonly pullRequest: number }
  /**
   * The pull request has moved past the state the caller took: a later commit,
   * or different replies. Nothing ran and nothing was posted. `by` is the state
   * the pull request is in now.
   */
  | { readonly outcome: "superseded"; readonly pullRequest: number; readonly by: StateKey }
  /** Threads are open, and the episode stays open for another round. */
  | ({ readonly outcome: "block" } & RoundAccount & AroundTheReviewer)
  /**
   * Nothing is open, and a later state is queued behind this one, so the episode
   * stays open and no summary is posted.
   */
  | ({ readonly outcome: "clean, episode open" } & RoundAccount & AroundTheReviewer)
  /** This round ended the episode, for the reason the decision gave. */
  | ({
      readonly outcome: "close";
      readonly because: ClosingReason;
      /**
       * What became of the episode's summary comment. Said by every close, and
       * never left to be inferred: the caller reports a close that ended with no
       * comment, and it cannot read that off a field that is missing.
       */
      readonly summary: EpisodeSummary;
      /**
       * Present only on a close reached before a reviewer started, which reviewed
       * nothing, so the caller records the state it took as not reviewed.
       * `openThreads` is the node ids of the reviewer's threads open on the pull
       * request as the close listed them.
       */
      readonly beforeReview?: { readonly openThreads: readonly string[] };
    } & RoundAccount &
      AroundTheReviewer)
  /**
   * The round failed. Never a clean pass: `failure` says whose failure it was,
   * and an honest empty review is not one of them.
   */
  | ({
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
      /**
       * The bound that leaves the episode no round after this one, so that the
       * failure comment does not promise a retry. Absent where a round remains,
       * and where the round failed before recording what it spent.
       */
      readonly closed?: ClosedBy;
      /**
       * What became of the failure comment. Absent where none was attempted:
       * the round never found its pull request, the caller asked for none, or
       * the harness threw.
       *
       * A comment that failed leaves the round the failure it was. The caller
       * reports the comment's reason beside the round's own.
       */
      readonly failureComment?: {
        readonly pullRequest: number;
        readonly posting: CommentPosting;
      };
    } & AroundTheReviewer);

/**
 * Run one round of the loop and return what it concluded.
 *
 * Never throws, whatever git, `gh`, the filesystem or the reviewer does.
 */
export async function runRound(setup: RoundSetup): Promise<RoundConclusion> {
  const opened: Opened = {};
  try {
    return await round(setup, opened);
  } catch (cause) {
    // A throw here is this harness's own defect. The round is still a value.
    return failed("harness", `the round could not be run: ${reasonFor(cause)}`);
  } finally {
    // Removal grows with what the reviewer left in the snapshot, so it waits for
    // the round's result. It runs under the lock, before the next round can add
    // a snapshot of its own.
    if (opened.snapshot !== undefined) {
      const removal = removeSnapshot(opened.snapshot);
      if (removal.outcome === "failed") setup.snapshotLeft?.(removal.reason);
    }
    // A lock this round could not remove names a process that is about to exit,
    // and the next round takes over a lock whose holder has gone.
    if (opened.held?.owned === true) opened.held.lock.release();
  }
}

/**
 * What the round must undo on every path it ends on, once it has made it.
 *
 * `owned` is false for a lock the caller took and handed in, which the caller
 * releases.
 */
type Opened = {
  held?: { readonly lock: HostLock; readonly owned: boolean };
  /** Whatever this round made at its snapshot path, added or left by a failed add. */
  snapshot?: string;
};

/** A step's answer, or the conclusion the round ended on instead of one. */
type Step<T> = { readonly step: T } | { readonly ended: RoundConclusion };

async function round(setup: RoundSetup, opened: Opened): Promise<RoundConclusion> {
  const directory = setup.worktree;

  const now = setup.now ?? Date.now;
  // One deadline over the whole part, not a bound on each of its calls. The
  // threads listing pages, so how many calls the part makes is not known in
  // advance, and a bound per call lets every page have the whole of one.
  const preReview: PreReview = {
    directory,
    until: deadlineIn(lowered(setup.preReviewMs, BEFORE_REVIEW_MS), now),
  };

  // The pull request comes first, because its number is the episode's key. A
  // branch with no pull request ends here, with no episode opened.
  const gated = gate(preReview);
  if ("ended" in gated) return gated.ended;
  const pullRequest = gated.step;
  // A lock taken for one pull request says nothing about another's rounds.
  if (setup.held !== undefined && setup.held.pullRequest !== pullRequest.number) {
    return failed(
      "harness",
      `no review ran: PR #${setup.held.pullRequest}'s head is not the branch checked out in ${directory}, whose pull request is #${pullRequest.number}`,
    );
  }

  const keyed = keyedBy(directory, pullRequest);
  if ("ended" in keyed) return keyed.ended;
  const episode = keyed.step;

  // Two subagents that stop at once in one worktree fire on one pull request.
  // Everything from the state read to the last post is one round's, because two
  // rounds that each read the state before the other wrote would both pass the
  // cap, both review, and keep only one of their costs.
  const locked: Step<HostLock> =
    setup.held === undefined ? lockOf(episode, pullRequest.number) : { step: setup.held.lock };
  if ("ended" in locked) return locked.ended;
  opened.held = { lock: locked.step, owned: setup.held === undefined };

  const stateRead = openState(episode);
  if ("ended" in stateRead) return stateRead.ended;
  const onFile = stateRead.step;

  // An episode that reported its close is over, and nothing but the lookup that
  // found its key is asked before this. The bounds are the wrong question: a cap
  // raised between firings would let a closed episode review again, and it would
  // post a second comment for one episode.
  if (onFile?.closeReported === true) return { outcome: "episode-over" };

  // One posting reserve for the round, made the first time anything asks for it.
  // The failure comment goes up under the deadline the salvaged findings ran
  // under, and a reserve made afresh for it would outlast theirs.
  const postingMs = lowered(setup.postingMs, POSTING_RESERVE_MS);
  let reserve: Deadline | undefined;
  const posting = (reviewOverAt?: number): Deadline =>
    (reserve ??= reserveAfter(postingMs, reviewOverAt, now));
  const stopwatch: Stopwatch = { now };

  const concluded = await reviewOn(pullRequest, onFile, {
    setup,
    opened,
    episode,
    preReview,
    posting,
    stopwatch,
  });
  const reported: RoundConclusion =
    concluded.outcome !== "failed" || setup.postsFailure === false
      ? concluded
      : {
          ...concluded,
          failureComment: {
            pullRequest: pullRequest.number,
            posting: timed(stopwatch, posting(), () =>
              postFailure(pullRequest.number, concluded, { directory, until: posting() }),
            ),
          },
        };
  keepPostingTime(episode, stopwatch);
  return reported;
}

/**
 * The posting reserve, starting now.
 *
 * `reviewOverAt` is the moment the review had to be over by, where a review ran.
 * Stopping the reviewer runs after that moment, and whatever the stop took past
 * it comes off the reserve rather than being added to the round.
 */
function reserveAfter(
  postingMs: number,
  reviewOverAt: number | undefined,
  now: () => number,
): Deadline {
  const overrun = reviewOverAt === undefined ? 0 : Math.max(0, now() - reviewOverAt);
  return deadlineIn(Math.max(0, postingMs - overrun), now);
}

/**
 * When the round's posting began and ended, on the round's clock, and the round
 * entry the time belongs to.
 */
type Stopwatch = {
  readonly now: () => number;
  first?: number;
  last?: number;
  /** The round's entry in the state, counted from 1, once the round has recorded one. */
  round?: number;
};

/**
 * Run `post` as part of the round's posting, timed where `reserve` has time left
 * for a call. A post the reserve leaves no time for makes no call, and the
 * round's posting time covers calls.
 */
function timed<T>(stopwatch: Stopwatch, reserve: Deadline, post: () => T): T {
  if (reserve.passed()) return post();
  const started = stopwatch.now();
  const result = post();
  stopwatch.first ??= started;
  stopwatch.last = stopwatch.now();
  return result;
}

/**
 * Add how long the round's posting took to the round's entry in the state.
 *
 * Written after the posting, so under a wait of its own rather than the reserve
 * the posting may have spent. A write that fails is not reported: the time is a
 * measurement, the round's result is decided already, and nothing reads it to
 * decide anything.
 */
function keepPostingTime(episode: Episode, stopwatch: Stopwatch): void {
  const { first, last, round } = stopwatch;
  if (first === undefined || last === undefined || round === undefined) return;
  const seconds = Math.round((last - first) / 100) / 10;
  updateState(episode, (current) => recordPostingSeconds(current, round, seconds), {
    until: deadlineIn(STATE_LOCK_WAIT_MS),
  });
}

/** The calls before the review, under the one deadline the snapshot's add runs under too. */
type PreReview = GhCall & { readonly until: Deadline };

/** What the part of a round after the gate runs with. */
type AfterTheGate = {
  readonly setup: RoundSetup;
  /** Where the round notes the snapshot it made, for removal once it ends. */
  readonly opened: Opened;
  readonly episode: Episode;
  readonly preReview: PreReview;
  /**
   * The posting reserve, the same deadline every time it is asked for. The first
   * asking makes it, and names the moment the review had to be over by where a
   * review ran.
   */
  readonly posting: (reviewOverAt?: number) => Deadline;
  readonly stopwatch: Stopwatch;
};

/** Everything a round does once the gate has found its pull request. */
async function reviewOn(
  pullRequest: PullRequest,
  onFile: EpisodeState | null,
  { setup, opened, episode, preReview, posting: startPosting, stopwatch }: AfterTheGate,
): Promise<RoundConclusion> {
  const { config } = setup;
  const directory = episode.worktree;
  const state = orEmpty(onFile);

  const bounds: EpisodeBounds = { rounds: config.rounds, tokens: config.tokens };
  const over = exhausted(state, bounds);
  if (over !== null) {
    return closeBeforeReview(over, pullRequest, { setup, episode, preReview, posting: startPosting, stopwatch });
  }

  const listing = handOver(pullRequest, preReview);
  if ("ended" in listing) return listing.ended;
  const handedOver = listing.step.threads;
  // The state the round would review is the pull request as it stands, and a
  // result recorded against any other state would claim a review it never had.
  const now: StateKey = { head: pullRequest.headSha, activity: listing.step.activity };
  if (setup.state !== undefined && !sameState(now, setup.state)) {
    return { outcome: "superseded", pullRequest: pullRequest.number, by: now };
  }

  const fetched = fetchDiff(pullRequest.number, preReview);
  if (fetched.outcome !== "fetched") {
    return failed(
      "harness",
      `no review ran: the diff of ${named(pullRequest)} could not be fetched: ${fetched.reason}`,
    );
  }

  const ordinal = state.rounds.length + 1;
  const ownDirectory = roundDirectory(episode, ordinal);
  const sessionDirectory = join(ownDirectory, "session");
  const unmade = makeDirectories([sessionDirectory, episode.scratchDirectory]);
  if (unmade !== null) return failed("harness", `no review ran: ${unmade}`);

  // The coding agent may edit its worktree while the review runs, so the reviewer
  // and both readings get a tree only the reviewer writes.
  const snapshot = addSnapshot(
    directory,
    { pullRequest: pullRequest.number, round: ordinal, commit: setup.state?.head ?? pullRequest.headSha },
    preReview.until,
  );
  if (snapshot.outcome === "failed") {
    if (snapshot.leftBehind !== undefined) opened.snapshot = snapshot.leftBehind;
    return failed("harness", `no review ran: ${snapshot.reason}`);
  }
  opened.snapshot = snapshot.path;
  const tree = snapshot.path;

  const around = readBeforeReviewer(tree, preReview.until);

  const clock = stopwatch.now;
  const seconds = config.timeout;
  const reviewStarted = clock();
  const review: Review = await runReview(
    setup.adapter,
    {
      directory: tree,
      charterFile: setup.charterFile,
      prompt: composePrompt({ pullRequest, diff: fetched.diff, threads: handedOver }, config.depth),
      sessionDirectory,
      promptFile: join(ownDirectory, "prompt.md"),
      reportsFile: join(ownDirectory, "reports.jsonl"),
      scratchDirectory: episode.scratchDirectory,
      githubConfigDirectory: join(ownDirectory, "gh"),
      thinking: config.thinking,
      model: config.model,
      depth: config.depth,
      // Whatever this says, each attempt asks the adapter for a line for every
      // place the reviewer may run.
      terminal: "none",
    },
    seconds,
    {
      ...(setup.sessionEnvironment === undefined ? {} : { environment: setup.sessionEnvironment }),
      ...(setup.sessionBackends === undefined ? {} : { backends: setup.sessionBackends }),
      ...(setup.workspace === undefined ? {} : { workspace: setup.workspace }),
      name: `squiz-${pullRequest.number}-r${ordinal}`,
      started: (place, boundEndsAt) =>
        setup.reviewerStarted?.({ ...placeOf(place), process: place.identity, boundEndsAt, snapshot: tree }),
      ...(setup.paneLeftOpen === undefined ? {} : { paneLeftOpen: setup.paneLeftOpen }),
    },
    clock,
  );
  const elapsedSeconds = Math.round((clock() - reviewStarted) / 100) / 10;
  writeResume(setup.adapter, sessionDirectory, directory, join(ownDirectory, "resume.txt"));

  // Everything from here to the last post runs on the posting reserve, which
  // starts as the review ends.
  const reserve = startPosting(reviewStarted + seconds * 1_000);

  // Taken here rather than on the reviewed path alone. A reviewer killed at its
  // bound is the one most likely to have left a write behind.
  const confinement = readAfterReviewer(around, reserve);

  const recording = keepCost(episode, state, review, elapsedSeconds, confinement);
  if ("ended" in recording) return recording.ended;
  const recorded = recording.step;
  if (isRound(review)) stopwatch.round = recorded.rounds.length;

  const posting: Posting = {
    pullRequest,
    diff: fetched.diff,
    directory,
    reserve,
    stopwatch,
  };

  // A failed round closes nothing, but where it spent the last round the cap
  // allows, or reached the token bound, no round runs after it either.
  const left = closedBy(recorded, bounds);
  const leftClosed = left === undefined ? {} : { closed: left };

  if (review.outcome !== "reviewed") {
    return { ...salvage(review, handedOver, posting, confinement), ...leftClosed };
  }

  const account = report(review, handedOver, posting);
  // A round that put none of its findings up has handed nothing over, so its
  // close would read as a review with nothing open. It fails instead, and the
  // episode stays open for a retry wherever the bounds leave a round for one.
  const outcomes = account.findings.outcomes;
  if (outcomes.length > 0 && outcomes.every((outcome) => outcome.outcome === "failed")) {
    const them = outcomes.length === 1 ? "1 finding and could not post it" : `${outcomes.length} findings and could not post them`;
    return {
      outcome: "failed",
      failure: "harness",
      reason: `round ${recorded.rounds.length} found ${them} to PR #${pullRequest.number}`,
      confinement,
      salvaged: account,
      ...leftClosed,
    };
  }
  const threads = [
    ...settled(handedOver, account.verdicts.threads),
    ...threadsOpened(account.findings),
  ];

  const tally: RoundTally = {
    openThreads: threads.filter((thread) => !thread.isResolved).map((thread) => thread.id),
    // The recorded entries are the rounds that have run, this one included,
    // which is the count the cap does its arithmetic on.
    roundsRun: recorded.rounds.length,
    // A round with no cost counts nothing against the token bound.
    tokens: review.cost?.tokens ?? 0,
  };
  const ended = endUnderLock(episode, setup.endsOn, tally, posting.reserve);
  if ("reason" in ended) {
    return {
      outcome: "failed",
      failure: "harness",
      reason: `the round's end could not be recorded: ${ended.reason}`,
      confinement,
      salvaged: account,
      ...leftClosed,
    };
  }
  const ends = ended.ends;
  if (ends.outcome === "reviewed clean, episode open") {
    return { outcome: "clean, episode open", confinement, ...account };
  }
  if (ends.outcome === "threads open") return { outcome: "block", confinement, ...account };
  return closeAfterReview(
    ends.because,
    account,
    recorded,
    handedOver,
    posting,
    confinement,
    ends.leftNotReviewed,
  );
}

/**
 * The pull request this round reviews, or the conclusion the gate reached.
 *
 * A branch with no pull request is no failure: no review runs and nothing is
 * posted. A git or a `gh` that could not answer is a failure and is named,
 * because an install that failed and read as a branch with no pull request looks
 * exactly like the harness working normally, every round and forever. The time
 * for GitHub running out is one of those, and never an answer of none.
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
  const directory = call.directory;
  // A detached HEAD is no branch, so no pull request can have it as a head. An
  // answer of none rather than a failure.
  if (branch.outcome === "detached") {
    return { ended: { outcome: "no-pull-request", branch: null, directory } };
  }

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
  if (lookup.outcome === "none") {
    return { ended: { outcome: "no-pull-request", branch: branch.name, directory } };
  }
  return { step: lookup };
}

/**
 * The episode's lock, taken, or the conclusion the round ended on where another
 * round holds it or nothing could tell.
 *
 * A holder that might still be running is never taken for gone, so a lock that
 * cannot be read runs no review either.
 */
function lockOf(episode: Episode, pullRequest: number): Step<HostLock> {
  const taking = takeHostLock(episode.directory, { boundMs: LOCK_BOUND_MS });
  switch (taking.outcome) {
    case "taken":
      return { step: taking.lock };
    case "held":
      return { ended: { outcome: "round-running", pullRequest } };
    case "unknown":
      return {
        ended: failed(
          "harness",
          `no review ran: whether a round is already running on PR #${pullRequest} could not be told: ${taking.reason}`,
        ),
      };
  }
}

/**
 * The episode `pullRequest` keys in `worktree`, or the conclusion the round ended
 * on where its number is no key.
 *
 * The gate reads any positive whole number as a pull request's number, and the
 * episode refuses one too large to be spelled exactly. Nothing is opened then.
 */
function keyedBy(worktree: string, pullRequest: PullRequest): Step<Episode> {
  try {
    return { step: episodeAt(worktree, pullRequest.number) };
  } catch (cause) {
    return { ended: failed("harness", `no review ran: ${reasonFor(cause)}`) };
  }
}

/**
 * What the episode's state file holds as this round starts, `null` where the
 * episode has none, or the conclusion the round ended on instead.
 *
 * Read before anything else the round does once it has found its pull request,
 * because this file is what says the episode is over.
 *
 * A file that will not read back ends the round before the reviewer runs. The
 * round count is the only bound on the loop, and a round that reviewed on a count
 * it could not read would start the count again on every firing.
 */
function openState(episode: Episode): Step<EpisodeState | null> {
  const read = readState(episode);
  if (read.outcome === "unreadable") {
    return { ended: failed("harness", `no review ran: ${read.reason}`) };
  }
  if (read.outcome === "absent") return { step: null };
  return { step: read.state };
}

/**
 * The episode's state against the pull request this round reviews, which is the
 * one the gate found rather than the one the file names.
 *
 * The rounds recorded are the episode's however many pull requests they read, and
 * the cap and the token bound are the episode's too.
 */
function orEmpty(state: EpisodeState | null): EpisodeState {
  return state ?? { rounds: [], spentOutsideRounds: unspent };
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
 * and nothing outside this stops an episode that keeps reviewing.
 *
 * A cap of R allows R rounds, so the round about to run is the one after the
 * count already recorded. A cap that is not a whole number leaves no round,
 * because nothing here may spend a review on a number it cannot count.
 */
function exhausted(state: EpisodeState, bounds: EpisodeBounds): StoppingBound | null {
  if (tokenBoundIsReached(widestAttempt(state), bounds.tokens)) return "token-bound";
  if (!Number.isInteger(bounds.rounds) || state.rounds.length >= bounds.rounds) {
    return "round-cap";
  }
  return null;
}

/**
 * The bound the next firing finds spent, from the state as this round left it,
 * or `undefined` where a round remains. Read as `exhausted` reads it, so the
 * failure comment says closed exactly where the next firing closes.
 */
function closedBy(state: EpisodeState, bounds: EpisodeBounds): ClosedBy | undefined {
  const over = exhausted(state, bounds);
  const roundsRun = state.rounds.length;
  if (over === "token-bound") return { bound: "token-bound", tokens: bounds.tokens, roundsRun };
  if (over === "round-cap") return { bound: "round-cap", roundsRun, cap: bounds.rounds };
  return undefined;
}

/** What a round that ran nothing did, which is nothing, said rather than implied. */
function nothingDone(pullRequest: number): RoundAccount {
  return {
    pullRequest,
    posted: [],
    findings: { outcomes: [] },
    verdicts: { threads: [], unapplied: [] },
  };
}

/**
 * The threads the reviewer opened, which are the ones it rules on, each with its
 * comments and resolved state.
 *
 * Listed every round, the first of an episode included. The pull request carries
 * the threads of every episode before this one, and handing over none would ask
 * for a fresh review of code the reviewer has already commented on: every
 * finding of the round before would go up a second time. A listing that failed
 * ends the round with nothing posted.
 *
 * A thread a person opened is left out, and nothing downstream reaches it: no
 * verdict is sent to it, and it is not counted among the open threads. It is a
 * conversation on the pull request rather than part of this review, so an
 * episode may close with one still open.
 *
 * The reviewer's own resolved threads go over with the rest, because re-opening
 * one is a verdict and a verdict only reaches a thread that was handed over.
 */
function handOver(
  pullRequest: PullRequest,
  call: GhCall,
): Step<{ readonly threads: readonly ReviewThread[]; readonly activity: string | null }> {
  const listed = listReviewThreads(pullRequest.nodeId, call);
  if (listed.outcome !== "listed") {
    return {
      ended: failed(
        "harness",
        `no review ran: the threads on ${named(pullRequest)} could not be listed: ${listed.reason}`,
      ),
    };
  }
  return { step: { threads: listed.threads.filter(openedByReviewer), activity: latestActivity(listed.threads) } };
}

/**
 * Whether the reviewer opened `thread`, which is what its first comment's marker
 * says.
 *
 * A reply a person left on the reviewer's own thread does not take it away from
 * the reviewer: the comment that opened it is the finding, and the rest of the
 * thread is the conversation about it.
 */
function openedByReviewer(thread: ReviewThread): boolean {
  return readThread(thread).raised === "finding";
}

/** Where a session ran, as the state file records it. A child is detached and has no pane. */
function placeOf(place: SessionPlace): ReviewerPlace {
  switch (place.backend) {
    case "herdr":
      return { backend: "herdr", pane: place.pane };
    case "tmux":
      return { backend: "tmux", pane: place.window.id };
    case "child":
      return { backend: "detached" };
  }
}

/**
 * Write the command that resumes the reviewer's session to `file`, with its
 * paths relative to `worktree`, which is where a person runs it from.
 *
 * Nothing is written where the adapter has no session to resume. A file that
 * cannot be written leaves the round without one, which `squiz status` shows as
 * a round with nothing to resume, and fails nothing.
 */
function writeResume(adapter: Adapter, sessionDirectory: string, worktree: string, file: string): void {
  const line = adapter.resume?.(sessionDirectory, relative(worktree, sessionDirectory));
  if (line === undefined) return;
  try {
    writeFileSync(file, `${line.join(" ")}\n`, "utf8");
  } catch {
    // The review stands without it.
  }
}

/**
 * The directories made, or why one could not be.
 *
 * The reviewer's session directory and its scratch space are made here because
 * the reviewer is started here: its CLI is told to write into both and creates
 * neither, and a scratch space that does not exist leaves the reviewer's
 * temporary files landing in the tree under review.
 */
function makeDirectories(directories: readonly string[]): string | null {
  for (const directory of directories) {
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
 * The posting that follows can run out of time or be stopped, and a round whose
 * cost was never recorded counts against neither the round cap nor the token
 * bound. A killed round's floor goes in for the same reason: what the
 * reviewer reported before it was stopped is what there is.
 *
 * A setup problem records what it spent without recording a round.
 */
function keepCost(
  episode: Episode,
  state: EpisodeState,
  review: Review,
  elapsedSeconds: number,
  confinement: RoundConfinement,
): Step<EpisodeState> {
  // Nothing was spent and no round ran, so there is nothing to keep. Writing
  // anyway would put a write that could fail in front of the reason the reviewer
  // gave, and report the wrong failure.
  if (withSpend(state, review, elapsedSeconds, confinement) === null) return { step: state };

  const written = updateState(
    episode,
    (current) => withSpend(current, review, elapsedSeconds, confinement) ?? current,
    // Its own wait rather than what the reserve has left. A reserve the stop has
    // nearly spent would leave too little to take the lock, and the cost is what
    // the round cap and the token bound count.
    { until: deadlineIn(STATE_LOCK_WAIT_MS) },
  );
  if (written.outcome === "failed") {
    // Nothing is posted on a state file that would not take the round. A round
    // that posted its findings and recorded nothing is one the next round
    // repeats comment for comment.
    return {
      ended: {
        outcome: "failed",
        failure: "harness",
        reason: `nothing the reviewer found was posted: ${written.reason}`,
        // The reviewer ran and both readings were taken, and the tree has moved on
        // by the time anything could ask again.
        confinement,
      },
    };
  }
  return { step: written.state };
}

// Another writer holds the state lock for one read and one write. A wait longer
// than this is a holder that has stopped, and waiting on would spend the posting
// reserve.
const STATE_LOCK_WAIT_MS = 2_000;

/** How long a write of the state file may wait for its lock, within `until`. */
function lockWait(until: Deadline): Deadline {
  return deadlineIn(Math.min(until.remaining(), STATE_LOCK_WAIT_MS));
}

/**
 * The state with this attempt's spend in it, or `null` where it spent nothing and
 * was no round.
 *
 * Two ledgers, and an attempt goes in exactly one of them. A round appends its
 * cost, how long its reviewer ran, and the bound where the bound is what ended the
 * reviewer; the entry count is what the cap spends. A setup problem spends no
 * round, and what it spent is added to the episode's spend all the same: an
 * attempt can complete a paid response and still end as a setup problem, and an
 * episode that forgot those tokens would hand another reviewer a bound it had
 * already reached.
 *
 * An attempt that was no round and is known to have spent nothing writes nothing
 * at all, what its readings found about the worktree included. A floor of zero is
 * not known to be nothing: it is a reviewer that ran and reported no spend, and
 * it is written so the episode's spend reads as a floor.
 */
function withSpend(
  state: EpisodeState,
  review: Review,
  elapsedSeconds: number,
  confinement: RoundConfinement,
): EpisodeState | null {
  const kept = withConfinement(state, confinement);
  if (isRound(review)) {
    return recordRound(
      kept,
      roundRecord(review.cost, {
        elapsedSeconds,
        ...(review.outcome === "timed-out" ? { cutShortAtSeconds: review.seconds } : {}),
      }),
    );
  }
  // An attempt with no cost has no figure to add to the episode's spend.
  if (review.cost === undefined || (nothingSpent(review.cost) && review.cost.floor !== true)) return null;
  return recordSpendOutsideRounds(kept, review.cost);
}

/**
 * The state with what this round's readings established added to what the
 * episode's earlier rounds did.
 *
 * Written down because a round that blocks posts no comment. The summary is
 * composed when the episode closes, and what every round before the last one found
 * is in the state file or nowhere.
 *
 * Unchanged where the episode has still established nothing, so one whose
 * reviewers left the worktree alone writes no field for it.
 */
function withConfinement(state: EpisodeState, confinement: RoundConfinement): EpisodeState {
  const evidence = evidenceWith(state.confinement, confinement);
  return evidence === undefined ? state : { ...state, confinement: evidence };
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
 * away either: a setup problem fails the round, and the next one waits on a new
 * commit, a reply or a run of `squiz review`.
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
   * The posting reserve. One deadline over the whole part, and a call with
   * nothing left on it is not made at all.
   */
  readonly reserve: Deadline;
  readonly stopwatch: Stopwatch;
};

/**
 * Put what the reviewer reported on the pull request: its verdicts, then its
 * findings.
 *
 * The verdicts go first. One that is not applied leaves a thread in a state the
 * reviewer did not rule on, and the episode then stays open over a finding the
 * reviewer ruled settled; a finding that is not posted is one the next round
 * reads the same code and makes again.
 *
 * `ruleOn` is the threads a verdict may reach. One in it that the reviewer ruled
 * on nowhere takes the default verdict, so what a caller passes is what decides
 * whether the reviewer's silence about a thread counts as a ruling on it.
 */
function report(output: RoundOutput, ruleOn: readonly ReviewThread[], on: Posting): RoundAccount {
  const call = { directory: on.directory, until: on.reserve };
  const calls = ruleOn.length + 2 * output.findings.length;
  // Nothing to put up makes no call, and a round that made none posted nothing.
  const post = <T>(posting: () => T): T =>
    calls === 0 ? posting() : timed(on.stopwatch, on.reserve, posting);

  const verdicts = post(() =>
    applyVerdicts(ruleOn, output.verdicts, { ...call, boundMs: share(on.reserve, calls) }),
  );

  const findings = post(() =>
    postFindings(
      {
        findings: output.findings,
        diff: on.diff,
        pullRequest: on.pullRequest.number,
        headSha: on.pullRequest.headSha,
      },
      { ...call, boundMs: share(on.reserve, 2 * output.findings.length) },
    ),
  );

  return {
    pullRequest: on.pullRequest.number,
    posted: threadsOpened(findings).map((thread) => thread.id),
    findings,
    verdicts,
  };
}

/**
 * Decide the round's end from the queue as it stands, and write the close where
 * that is the end, in one update under the state lock.
 *
 * A trigger queues nothing once the close is written, so a state is either in
 * the queue this reads, and is ruled on here, or refused because the episode
 * has closed. Fails where the update does.
 */
function endUnderLock(
  episode: Episode,
  endsOn: (tally: RoundTally, queued: readonly QueuedRecord[]) => RoundEnd,
  tally: RoundTally,
  until: Deadline,
): { readonly ends: RoundEnd } | { readonly reason: string } {
  let ends: RoundEnd | undefined;
  const written = updateState(
    episode,
    (current) => {
      const queued = (current.records ?? []).filter(
        (record): record is QueuedRecord => record.status === "queued",
      );
      ends = endsOn(tally, queued);
      return ends.outcome === "closed" ? { ...current, closeReported: true } : current;
    },
    { until: lockWait(until) },
  );
  if (written.outcome === "failed") return { reason: written.reason };
  return ends === undefined ? { reason: "the state lock was never taken" } : { ends };
}

/**
 * The close of a round that reviewed, with the episode's summary comment on the
 * pull request.
 *
 * The comment goes up last, after the findings and the verdicts. A thread is what
 * the next reader works, and a comment that took the reserve from the threads would
 * report an episode whose findings never landed.
 *
 * `handedOver` is the listing this round made, which is where the headline of
 * every finding raised before this round is. The account carries the threads this
 * round opened, and the two together are the whole episode.
 *
 * The close is already written to the episode's state, in the update that
 * decided it. A comment that could not be posted leaves the close a close. The
 * episode is over, so nothing is retried and no later round reads the same code
 * again.
 */
function closeAfterReview(
  because: ClosingReason,
  account: RoundAccount,
  state: EpisodeState,
  handedOver: readonly ReviewThread[],
  on: Posting,
  confinement: RoundConfinement,
  leftNotReviewed: LeftNotReviewed | null,
): RoundConclusion {
  const summary = timed(on.stopwatch, on.reserve, () => postEpisodeSummary(
    {
      pullRequest: account.pullRequest,
      rounds: state.rounds,
      handedOver,
      verdicts: account.verdicts,
      findings: account.findings,
      because,
      // What every round established, and not this round's own readings. A round
      // that blocked posted no comment, so a file it found changed is named here
      // or nowhere.
      confinement: state.confinement ?? nothingEstablished,
      leftNotReviewed,
    },
    { directory: on.directory, until: on.reserve },
  ));
  return { outcome: "close", because, summary, confinement, ...account };
}

/**
 * The close of an episode whose bounds were spent before a reviewer started.
 *
 * No reviewer runs, and the rest is what any close does: list the reviewer's
 * threads, write the close, and post the summary from the threads and the
 * episode's state. The state the caller took is left not reviewed, with every
 * state queued behind it, and the summary's Notes name them.
 *
 * The threads are listed before the close is written. A listing that fails ends
 * the round with nothing recorded and nothing posted, as at any round: a summary
 * composed from part of the threads reports the rest as never raised.
 *
 * An episode that ran no round and holds none of the reviewer's threads has
 * nothing for a summary to report, and posts none.
 */
function closeBeforeReview(
  bound: StoppingBound,
  pullRequest: PullRequest,
  { setup, episode, preReview, posting, stopwatch }: Omit<AfterTheGate, "opened">,
): RoundConclusion {
  const listing = handOver(pullRequest, preReview);
  if ("ended" in listing) return listing.ended;
  const threads = listing.step.threads;
  const openThreads = threads.filter((thread) => !thread.isResolved).map((thread) => thread.id);

  const reserve = posting();
  let left: LeftNotReviewed | null | undefined;
  const written = updateState(
    episode,
    (current) => {
      left = leftBeforeReview(current, bound, setup.state);
      return { ...current, closeReported: true };
    },
    { until: lockWait(reserve) },
  );
  if (written.outcome === "failed") {
    return failed("harness", `the episode's close could not be recorded: ${written.reason}`);
  }

  const state = written.state;
  const account = nothingDone(pullRequest.number);
  const summary =
    state.rounds.length === 0 && threads.length === 0
      ? closedBeforeAnyRound
      : timed(stopwatch, reserve, () =>
          postEpisodeSummary(
            {
              pullRequest: pullRequest.number,
              rounds: state.rounds,
              handedOver: threads,
              verdicts: standing(threads),
              findings: account.findings,
              // The bound closed the episode either way, and the Notes name it
              // through the states it left not reviewed.
              because: openThreads.length === 0 ? "nothing-open" : bound,
              confinement: state.confinement ?? nothingEstablished,
              leftNotReviewed: left ?? null,
            },
            { directory: episode.worktree, until: reserve },
          ),
        );
  return { outcome: "close", because: bound, summary, beforeReview: { openThreads }, ...account };
}

/**
 * The states a close before the review leaves not reviewed: the one the caller
 * took, then every state queued behind it. `null` where there are none.
 */
function leftBeforeReview(
  state: EpisodeState,
  bound: StoppingBound,
  taken: StateKey | undefined,
): LeftNotReviewed | null {
  const records = state.records ?? [];
  const queued = records.filter(
    (record) => record.status === "queued" && (taken === undefined || !sameState(record, taken)),
  );
  const keys = [...(taken === undefined ? [] : [taken]), ...queued];
  if (keys.length === 0) return null;
  const reason = closedBeforeReview(bound);
  return {
    bound,
    after: lastReviewed(records),
    states: keys.map(({ head, activity }) => ({ head, activity, status: "not reviewed", reason })),
  };
}

/**
 * The rulings a close before the review counts its threads by, where no reviewer
 * ruled.
 *
 * A resolved thread is counted fixed: nothing records whether `fixed` or
 * `withdrawn` closed it. An unresolved one is given no ruling, and reads as open
 * or disputed as it does at any close.
 */
function standing(threads: readonly ReviewThread[]): AppliedVerdicts {
  return {
    threads: threads
      .filter((thread) => thread.isResolved)
      .map((thread) => ({ thread: thread.id, ruled: "fixed", outcome: "closed" })),
    unapplied: [],
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
 * No summary comment either. Nothing here closed the episode, and counts taken
 * from a review that did not finish would read as one that did. The failure
 * comment that follows is what reports the round.
 *
 * The posting runs on the round's posting reserve, as a finished review's does,
 * and the failure comment after it runs on the same one.
 *
 * A reviewer that confirmed nothing before it failed leaves nothing to put up,
 * and no call is made.
 */
function salvage(
  review: FailedReview,
  handedOver: readonly ReviewThread[],
  on: Posting,
  confinement: RoundConfinement,
): RoundConclusion {
  const kept = review.findings.length;
  if (kept === 0 && review.verdicts.length === 0) {
    return {
      outcome: "failed",
      failure: review.outcome,
      reason: reviewerFailed(review, 0),
      confinement,
    };
  }
  return {
    outcome: "failed",
    failure: review.outcome,
    reason: reviewerFailed(review, kept),
    confinement,
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
 * Computed from what the round did rather than read back a second time.
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
 * without one is left out, because nothing can be addressed to it.
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
 * One finding's new thread, as the open threads count it.
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
    // reads the identifier.
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
  const rounds = state.rounds.map((round) => round.tokens ?? 0);
  return Math.max(0, ...rounds, state.spentOutsideRounds.tokens);
}

/**
 * One call's fair share of what is left of the reserve, where `calls` is what the
 * phase is expected to make.
 *
 * A share and not the bound. The reserve is enforced as a deadline every call
 * runs under, and this only stops one slow call from spending what the rest of
 * the phase needs. The count is an estimate, and the read-back after a create
 * can page, so a phase may make more calls than its share was split for and the
 * deadline is what holds either way.
 *
 * Never zero: a bound that is not a positive number is read as no bound asked
 * for and falls back to the ceiling on a single call.
 */
function share(reserve: Deadline, calls: number): number {
  return Math.max(1, Math.floor(reserve.remaining() / Math.max(1, calls)));
}

/** A part's own length, or a smaller one asked for. It only lowers. */
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
