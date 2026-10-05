/**
 * The `Stop` and `SubagentStop` entry point, and the lines a round's conclusion
 * is reported as.
 *
 * A firing queues the pull request's state for the round host and returns. It
 * never runs a round and never waits on one, and it exits 0 on every path: a
 * non-zero exit is the one thing that stops the coding agent finishing its turn.
 * What it could not do, and a branch with no pull request, it says in one line
 * on stderr. Exiting 0 in silence over a failure would read as a state queued.
 */

import { trigger, type TriggerRequest, type Triggered } from "../host/trigger.ts";
import { failureReport } from "../loop/failure-comment.ts";
import type { AroundTheReviewer, RoundAccount, RoundConclusion } from "../loop/round.ts";
import type { Owner } from "../loop/state-record.ts";
import { deadlineIn } from "../reviewers/deadline.ts";
import type { Firing, HookEnvironment } from "../sessions/firing.ts";
import { readPayloadFrom, type PayloadStream } from "./payload.ts";
import { reportFailure } from "./report.ts";
import type { HookExit } from "./trap.ts";

// Queuing is a few git and gh calls. One that hangs past this costs the review,
// not the turn.
const QUEUE_BUDGET_MS = 30_000;

export type HookCall = {
  /** The hook's stdin, which the runtime wrote the payload to. */
  readonly stdin: PayloadStream;
  /** The directory the hook fired in, which the worktree is resolved from. */
  readonly directory: string;
  /** `process.env` where not given. */
  readonly environment?: HookEnvironment;
  /** `trigger` where not given. */
  readonly trigger?: (request: TriggerRequest) => Triggered;
};

/** Queue the state `call`'s firing ended on. Never throws, and always resolves 0. */
export async function runHook(call: HookCall): Promise<HookExit> {
  try {
    const environment = call.environment ?? process.env;
    const read = await readPayloadFrom(call.stdin, environment);
    // Claude Code fires these after an interactive turn ends, with no subagent
    // behind them, so there is no work to queue a review of.
    if (read.outcome === "no subagent's work") return 0;
    if (read.outcome === "unreadable") {
      reportFailure(`nothing was queued: ${read.reason}`);
      return 0;
    }

    const triggered = (call.trigger ?? trigger)({
      directory: call.directory,
      trigger: "hook",
      owner: ownerOf(read.firing),
      environment,
      until: deadlineIn(QUEUE_BUDGET_MS),
    });
    const line = lineFor(triggered);
    if (line !== null) reportFailure(line);
  } catch (cause) {
    reportFailure(`nothing was queued: the hook failed: ${reasonFor(cause)}`);
  }
  return 0;
}

function ownerOf(firing: Firing): Owner {
  return {
    sessionId: firing.owner.sessionId,
    ...(firing.event === "SubagentStop" ? { subagent: firing.subagent } : {}),
    ...(firing.owner.socket === undefined ? {} : { messagingSocket: firing.owner.socket }),
  };
}

/**
 * The one line a trigger's outcome is reported as, or `null` where there is
 * nothing to say.
 *
 * A state the trigger chose not to queue says nothing: a turn that pushed
 * nothing, or a state already queued or reviewed, is the common case. A host
 * that did not start is said, because the state it was started for waits on the
 * next trigger.
 */
function lineFor(triggered: Triggered): string | null {
  switch (triggered.outcome) {
    case "no review":
      return `no review ran: ${triggered.reason}`;
    case "failed":
      return `nothing was queued: ${triggered.reason}`;
    case "decided": {
      const { host, pullRequest } = triggered;
      if (host.outcome === "failed") {
        return `the round host for PR #${pullRequest.number} could not be started: ${host.reason}`;
      }
      if (host.outcome === "unknown") {
        return `the round host for PR #${pullRequest.number} may not have started: ${host.reason}`;
      }
      return null;
    }
  }
}

/**
 * The lines a conclusion that exits 0 is reported as, one for each thing that
 * failed, and none where there is nothing to report.
 *
 * Every failure pointer a round's conclusion is reported as is composed here.
 * One place is what holds each pointer to one line and one shape, and it decides
 * once what counts as a failure rather than leaving each path that might be one
 * to decide for itself.
 */
export function failureIn(conclusion: RoundConclusion): readonly string[] {
  switch (conclusion.outcome) {
    case "failed":
      return failedFailure(conclusion);
    case "close": {
      // An episode that closed at its cap or its budget has not failed. What it
      // could not put on the pull request is the only thing left to say.
      const failure = closingFailure(conclusion);
      return failure === null ? [] : [failure];
    }
    // A blocked round's stderr is its reason alone. A branch nobody opened a pull
    // request for failed at nothing, and an episode that had already reported its
    // close ran nothing: what it came to was said when it closed.
    case "block":
    case "clean, episode open":
    case "superseded":
    case "no-pull-request":
    case "episode-over":
    case "round-running":
      return [];
  }
}

/**
 * The one line a pass that reviewed nothing is reported as, or `null` for every
 * other conclusion. A pass is for want of a pull request, or because another
 * round of the episode is running.
 *
 * Not a failure, and still said. A branch with no pull request and a subagent
 * whose hook fired in a tree it never worked in both reach the gate as a branch
 * nobody opened a pull request for, so the branch and the directory are the only
 * things that tell them apart.
 */
export function unreviewedIn(conclusion: RoundConclusion): string | null {
  if (conclusion.outcome === "round-running") {
    return `no review ran: a round is already running on PR #${conclusion.pullRequest}`;
  }
  if (conclusion.outcome !== "no-pull-request") return null;
  const directory = quoted(conclusion.directory);
  if (conclusion.branch === null) {
    return `no review ran: HEAD is detached in ${directory}, so no pull request has it as its head`;
  }
  const branch = quoted(conclusion.branch);
  return `no review ran: no open pull request has ${branch} as its head, in ${directory}`;
}

/**
 * `text` in double quotes, with every character the pointer would flatten
 * escaped, so a path or a branch comes through the pointer unaltered.
 *
 * JSON escapes every control character but leaves U+0085, U+2028 and U+2029
 * raw, and the pointer reads each of those as a line break.
 */
function quoted(text: string): string {
  return JSON.stringify(text).replace(/[\u0085\u2028\u2029]/gu, (separator) =>
    `\\u${separator.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** A round that failed, which may have salvaged what the reviewer had reported. */
type FailedRound = Extract<RoundConclusion, { readonly outcome: "failed" }>;

/** A closing round, whose findings and verdicts are the whole of what it did. */
type ClosedRound = Extract<RoundConclusion, { readonly outcome: "close" }>;

/**
 * What the round failed at, what else it established, what of the review it
 * could not put up, and what became of its failure comment, a line each.
 *
 * The first line and the items after it are the failure comment's own words,
 * read from the one report the comment is rendered from. The failure comes first,
 * because nothing a round managed to post makes it a round that succeeded. What
 * it could not post follows, on the same terms as a closing round's, because a
 * salvaged finding that reached no thread is as lost as any other.
 */
function failedFailure(round: FailedRound): readonly string[] {
  const report = failureReport(round);
  const failures = [unsalvagedBy(round), unmarkedBy(round)].filter((what) => what !== null);
  return [
    report.reason,
    ...report.established,
    ...(failures.length === 0 ? [] : [`the round failed to ${failures.join(" and to ")}`]),
    ...announcedBy(round),
  ];
}

/**
 * Where the failure comment went, or why it went nowhere. No line where none was
 * attempted, which is a round that never found its pull request.
 */
function announcedBy(round: FailedRound): readonly string[] {
  const comment = round.failureComment;
  if (comment === undefined) return [];
  const at = `PR #${comment.pullRequest}`;
  if (comment.posting.outcome === "posted") return [`the failure is posted on ${at}`];
  return [`the failure could not be posted on ${at}: ${comment.posting.reason}`];
}

/**
 * What a closing round failed at, on the pull request and in the harness, or
 * `null` where it failed at nothing.
 *
 * A close is the end of the episode. Nothing is stored to retry, and no later
 * round reads the same code to make the same comment again. A closing round is
 * also the shape a healthy episode ends in, so silence here is read as a clean
 * review.
 */
function closingFailure(round: ClosedRound): string | null {
  const failures = [
    unreportedBy(round),
    summaryLostBy(round),
    closeUnrecordedBy(round),
    unmarkedBy(round),
  ].filter((what) => what !== null);
  if (failures.length === 0) return null;
  const at = `PR #${round.pullRequest}`;
  return `the round closed the episode on ${at} having failed to ${failures.join(" and to ")}`;
}

/**
 * The summary comment the episode closed without, or `null` where it went up.
 *
 * Carries the reason the round gave. The summary is the whole of the episode's
 * record on the pull request, so where it is missing this line is the only thing
 * that will ever say what the review counted, and which failure it was decides
 * whether anything can be done about it.
 *
 * A comment nothing composed is reported exactly as a comment GitHub refused. The
 * pull request carries neither, and a close that named only the second would let
 * the first end an episode in silence.
 */
function summaryLostBy(round: ClosedRound): string | null {
  switch (round.summary.outcome) {
    case "failed":
    case "never-composed":
      return `post the episode's summary: ${round.summary.reason}`;
    case "posted":
      return null;
  }
}

/**
 * The close the episode could not record, or `null` where it recorded it.
 *
 * After everything about the pull request, because it is about the harness.
 * The marker follows it, because it is about another episode.
 *
 * A close nothing recorded is a close no later firing can read. That firing finds
 * the rounds in the state file and no close, which is what an interruption leaves
 * too, so it takes the episode for one still open and reviews the pull request
 * again. This line is the only warning of that, and it carries the filesystem's
 * own error because that is what someone has to fix.
 */
function closeUnrecordedBy(round: ClosedRound): string | null {
  if (round.recorded.outcome !== "failed") return null;
  return `record the episode's close: ${round.recorded.reason}`;
}

/**
 * The marker this round could not write, or `null` where it wrote one or never
 * tried.
 *
 * A round no other episode can find lets one starting meanwhile take a
 * comparison that names this reviewer's writes as its own. That harm lands on
 * another pull request, so the summary does not carry it and this line is the
 * only place it is said. A blocked round does not say it, because its stderr is
 * the coding agent's next instruction.
 */
function unmarkedBy(round: AroundTheReviewer): string | null {
  const marked = round.confinement?.marked;
  if (marked === undefined || marked.outcome === "written") return null;
  return `mark itself as running for the other episodes of the worktree: ${marked.reason}`;
}

/** What a failed round salvaged and could not put up, or `null` where nothing was lost. */
function unsalvagedBy(round: FailedRound): string | null {
  const { salvaged } = round;
  if (salvaged === undefined) return null;
  const unreported = unreportedBy(salvaged);
  return unreported === null ? null : `${unreported} on PR #${salvaged.pullRequest}`;
}

/**
 * What the round could not put on the pull request, as the pointer names it, or
 * `null` where it failed at nothing.
 *
 * Each of these ends as a defect nobody was told about:
 *
 * - a finding that reached no thread,
 * - a verdict that did not reach the thread it named, which leaves a thread
 *   closed over a defect that still stands,
 * - a diff nothing could be anchored against, which leaves every finding that
 *   named a place with nowhere on the pull request to hang.
 *
 * The counts come from what the round did, and all of it shares one line, because
 * the pointer is a pointer and a second format has nowhere to grow.
 */
function unreportedBy(round: RoundAccount): string | null {
  const findings = round.findings.outcomes;
  const unposted = findings.filter((outcome) => outcome.outcome === "failed").length;
  const ruled = round.verdicts.threads;
  const unapplied = ruled.filter((thread) => thread.outcome === "failed").length;
  const unreadableDiff = round.findings.unreadableDiff !== undefined;
  if (unposted === 0 && unapplied === 0 && !unreadableDiff) return null;

  const failures = [
    // The cause comes first where there is one: findings that would have opened
    // threads went to the summary instead, and none of them counts as failed.
    ...(unreadableDiff ? ["read the diff its comments anchor to"] : []),
    ...(unposted === 0 ? [] : [`post ${unposted} of ${findings.length} findings`]),
    ...(unapplied === 0 ? [] : [`apply ${unapplied} of ${ruled.length} verdicts`]),
  ];
  return failures.join(" and to ");
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
