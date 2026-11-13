/**
 * The `Stop`, `SubagentStop`, `SessionStart`, `SubagentStart` and
 * `UserPromptSubmit` entry point.
 *
 * A stop queues the change's state for the round host and returns. It never
 * runs a round and never waits on one. A start hands the worktree to the
 * venue's `recordStart`, and a prompt hands its text to the venue's
 * `recordPrompt`, and neither does anything else. A prompt squiz gave a
 * session it started is not handed on. Every firing exits 0, on every
 * path: a non-zero exit is the one thing that stops the coding agent finishing
 * its turn. What it could not do, and a branch with no pull request, it says in
 * one line on stderr. Exiting 0 in silence over a failure would read as a state
 * queued, or a base recorded.
 */

import { FIXER_VARIABLE } from "../host/fixer.ts";
import { trigger, type TriggerRequest, type Triggered } from "../host/trigger.ts";
import type { Owner } from "../loop/state-record.ts";
import { deadlineIn } from "../reviewers/deadline.ts";
import type { Firing, HookEnvironment } from "../sessions/firing.ts";
import { venueAt } from "../venues/venue.ts";
import { worktreeToplevel } from "../worktree/toplevel.ts";
import { readPayloadFrom, type PayloadStream } from "./payload.ts";
import { reportFailure } from "./report.ts";
import type { HookExit } from "./trap.ts";

// Queuing is a few git and gh calls. One that hangs past this costs the review,
// not the turn.
const QUEUE_BUDGET_MS = 30_000;

// Git's own words for a directory in no repository.
const NOT_A_REPOSITORY = /fatal: not a git repository/u;

export type HookCall = {
  /** The hook's stdin, which the runtime wrote the payload to. */
  readonly stdin: PayloadStream;
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
    // The subagent's own SubagentStop follows, and queues its work.
    if (read.outcome === "a subagent's turn") return 0;
    // A subagent's brief is not what the run was asked to do.
    if (read.outcome === "a subagent's prompt") return 0;
    if (read.outcome === "unreadable") {
      reportFailure(`nothing was queued: ${read.reason}`);
      return 0;
    }
    const { firing } = read;
    if (firing.event === "SessionStart" || firing.event === "SubagentStart") {
      recordStart(firing.directory);
      return 0;
    }
    if (firing.event === "UserPromptSubmit") {
      const squizStarted = environment[FIXER_VARIABLE];
      if (squizStarted === undefined || squizStarted === "") recordPrompt(firing.directory, firing.prompt);
      return 0;
    }

    const triggered = (call.trigger ?? trigger)({
      directory: firing.directory,
      trigger: "hook",
      owner: ownerOf(firing),
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

/** Hand `directory`, where a session or subagent is starting, to the venue its `.squiz.json` names. */
function recordStart(directory: string): void {
  const until = deadlineIn(QUEUE_BUDGET_MS);
  // A start fires for every session opened anywhere, and one outside git has
  // nothing to review, so it says nothing rather than speak to every such user.
  const toplevel = worktreeToplevel(directory, until);
  if (toplevel.outcome === "failed" && NOT_A_REPOSITORY.test(toplevel.reason)) return;
  const chosen = venueAt(directory, until);
  if (chosen.outcome === "failed") {
    reportFailure(`no base was recorded: ${chosen.reason}`);
    return;
  }
  const recorded = chosen.venue.recordStart(directory, until);
  if (recorded.outcome === "failed") reportFailure(`no base was recorded: ${recorded.reason}`);
}

/**
 * Hand `prompt`, given to a session in `directory`, to the venue its
 * `.squiz.json` names. The line it writes on a failure never carries the
 * prompt.
 */
function recordPrompt(directory: string, prompt: string): void {
  try {
    const until = deadlineIn(QUEUE_BUDGET_MS);
    // A prompt fires for every session opened anywhere, as a start does.
    const toplevel = worktreeToplevel(directory, until);
    if (toplevel.outcome === "failed" && NOT_A_REPOSITORY.test(toplevel.reason)) return;
    const chosen = venueAt(directory, until);
    if (chosen.outcome === "failed") {
      reportFailure(`no prompt was recorded: ${chosen.reason}`);
      return;
    }
    const recorded = chosen.venue.recordPrompt(directory, prompt, until);
    if (recorded.outcome === "failed") reportFailure(`no prompt was recorded: ${recorded.reason}`);
  } catch (cause) {
    reportFailure(`no prompt was recorded: the hook failed: ${reasonFor(cause)}`);
  }
}

function ownerOf(firing: Extract<Firing, { readonly owner: unknown }>): Owner {
  const subagent =
    firing.event === "SubagentStop"
      ? {
          subagent: firing.subagent,
          ...(firing.parentTranscript === undefined ? {} : { parentTranscript: firing.parentTranscript }),
        }
      : {};
  return {
    sessionId: firing.owner.sessionId,
    ...subagent,
    ...(firing.owner.socket === undefined ? {} : { messagingSocket: firing.owner.socket }),
    ...(firing.lastMessage === undefined ? {} : { lastMessage: firing.lastMessage }),
    ...(firing.transcript === undefined ? {} : { transcript: firing.transcript }),
  };
}

/**
 * The one line a trigger's outcome is reported as, or `null` where there is
 * nothing to say.
 *
 * A state the trigger chose not to queue says nothing: a turn that pushed
 * nothing, a state already queued or reviewed, or a draft, is the common case. A host
 * that did not start is said, because the state it was started for waits on the
 * next trigger.
 */
function lineFor(triggered: Triggered): string | null {
  switch (triggered.outcome) {
    case "no review":
      return `no review ran: ${triggered.reason}`;
    case "held":
      return null;
    // A hook never asks to hold a push GitHub does not report yet.
    case "unreported":
      return null;
    case "failed":
      return `nothing was queued: ${triggered.reason}`;
    case "decided": {
      const { host, change } = triggered;
      if (host.outcome === "failed") {
        return `the round host for ${change.name} could not be started: ${host.reason}`;
      }
      if (host.outcome === "unknown") {
        return `the round host for ${change.name} may not have started: ${host.reason}`;
      }
      return null;
    }
  }
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
