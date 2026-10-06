/**
 * The `Stop` and `SubagentStop` entry point.
 *
 * A firing queues the pull request's state for the round host and returns. It
 * never runs a round and never waits on one, and it exits 0 on every path: a
 * non-zero exit is the one thing that stops the coding agent finishing its turn.
 * What it could not do, and a branch with no pull request, it says in one line
 * on stderr. Exiting 0 in silence over a failure would read as a state queued.
 */

import { trigger, type TriggerRequest, type Triggered } from "../host/trigger.ts";
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
    if (read.outcome === "unreadable") {
      reportFailure(`nothing was queued: ${read.reason}`);
      return 0;
    }

    const triggered = (call.trigger ?? trigger)({
      directory: read.firing.directory,
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

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
