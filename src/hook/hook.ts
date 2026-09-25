/**
 * The `SubagentStop` entry point: one round, and the exit code it decides.
 *
 * Exit 2 is the only exit that blocks the coding agent, and a round that means
 * to block is the only thing that reaches it. Every other end of every other
 * path is exit 0, because a non-zero exit that is not a block is the one thing
 * that stops the coding agent finishing its turn.
 *
 * The two stderr channels stay apart. A blocked round writes the reason it
 * composed and nothing else, because the runtime hands that text to the coding
 * agent as its next instruction. A round that exits 0 having failed writes one
 * line saying what failed, and `failureIn` is the only place that line is
 * composed.
 */

import { fileURLToPath } from "node:url";

import { loadConfig } from "../config/config.ts";
import { episodeAt } from "../loop/episode.ts";
import { runRound, type RoundConclusion, type RoundSetup } from "../loop/round.ts";
import { pi } from "../reviewers/pi/adapter.ts";
import { worktreeToplevel } from "../worktree/toplevel.ts";
import { readPayloadFrom, type PayloadStream } from "./payload.ts";
import { reportFailure } from "./report.ts";
import { writeToStderr } from "./stderr.ts";
import type { HookExit } from "./trap.ts";

// The charter ships beside the code, so it is found from this file rather than
// from a working directory that belongs to the project under review.
const charterFile = fileURLToPath(new URL("../../charter.md", import.meta.url));

/** One firing of the hook. */
export type Firing = {
  /** The hook's stdin, which the runtime wrote the payload to. */
  readonly stdin: PayloadStream;
  /** The directory the hook fired in, which the worktree is resolved from. */
  readonly directory: string;
  /**
   * What runs the round. The harness's own unless a test hands over another,
   * because what a reviewer or GitHub did to a round cannot be arranged from
   * here.
   */
  readonly round?: (setup: RoundSetup) => Promise<RoundConclusion>;
};

/**
 * Run one round for `firing`, and return the exit it decides.
 *
 * Never throws, whatever the payload, the filesystem, git, `gh` or the reviewer
 * does.
 */
export async function runHook(firing: Firing): Promise<HookExit> {
  const conclusion = await concluded(firing);

  if (conclusion.outcome === "block") {
    writeToStderr(ending(conclusion.reason));
    return 2;
  }

  const failure = failureIn(conclusion);
  if (failure !== null) reportFailure(failure);
  return 0;
}

/**
 * The one line a conclusion that exits 0 is reported as, or `null` where there
 * is nothing to report.
 *
 * Every failure pointer the hook writes is composed here. One place is what
 * holds the pointer to one line and one shape, and it decides once what counts
 * as a failure rather than leaving each path that might be one to decide for
 * itself.
 */
export function failureIn(conclusion: RoundConclusion): string | null {
  switch (conclusion.outcome) {
    case "failed":
      return conclusion.reason;
    case "close":
      // An episode that closed at its cap or its budget has not failed. What it
      // could not put on the pull request is the only thing left to say.
      return unposted(conclusion);
    // A blocked round's stderr is its reason alone, and a branch nobody opened a
    // pull request for had nothing to run.
    case "block":
    case "no-pull-request":
      return null;
  }
}

/** A closing round, which is the only conclusion that can have posted anything. */
type ClosedRound = Extract<RoundConclusion, { readonly outcome: "close" }>;

/**
 * A round that found defects and put none of them on the pull request.
 *
 * Nothing is stored to post them again, so findings that reached nobody are
 * lost with the episode. Silence here would read as a review that found
 * nothing.
 */
function unposted(round: ClosedRound): string | null {
  const outcomes = round.findings.outcomes;
  const failed = outcomes.filter((outcome) => outcome.outcome === "failed").length;
  const threaded = outcomes.filter((outcome) => outcome.outcome === "threaded").length;
  if (failed === 0 || threaded > 0) return null;

  const them = outcomes.length === 1 ? "it" : "them";
  const found = `${outcomes.length} finding${outcomes.length === 1 ? "" : "s"}`;
  return `the round found ${found} and could not post ${them} to PR #${round.pullRequest}`;
}

/**
 * What one firing came to, before anything is written and before an exit code
 * is chosen.
 *
 * The payload, the worktree, the episode key and the settings are read in turn,
 * and a firing that loses any of them runs no round at all. A payload that
 * cannot be read is not a round that found nothing: nothing about the firing is
 * known, the episode least of all, and half an episode is not something to
 * review against.
 */
async function concluded(firing: Firing): Promise<RoundConclusion> {
  const read = await readPayloadFrom(firing.stdin);
  if (read.outcome === "unreadable") return harness(`no review ran: ${read.reason}`);

  const worktree = worktreeToplevel(firing.directory);
  if (worktree.outcome === "failed") {
    return harness(`no review ran: the worktree could not be resolved: ${worktree.reason}`);
  }

  let setup: RoundSetup;
  try {
    setup = {
      episode: episodeAt(worktree.path, read.payload.agentId),
      config: loadConfig(worktree.path),
      adapter: pi,
      charterFile,
    };
  } catch (cause) {
    // The episode's key arrives in a payload and the settings arrive in a file.
    // Each refuses a value it cannot use by throwing.
    return harness(`no review ran: ${reasonFor(cause)}`);
  }

  try {
    return honoured(await (firing.round ?? runRound)(setup));
  } catch (cause) {
    // The round reports what went wrong as a value, so a throw from it is a
    // defect in the harness. It ends the round and not the coding agent's turn.
    return harness(`the round could not be run: ${reasonFor(cause)}`);
  }
}

/**
 * The conclusion as the hook acts on it, which is the round's own unless it
 * asked to block with nothing to say.
 *
 * Exit 2 hands the coding agent whatever stderr carried as its next
 * instruction, so an empty one spends a round of the cap and asks for nothing.
 */
function honoured(conclusion: RoundConclusion): RoundConclusion {
  if (conclusion.outcome !== "block" || conclusion.reason.trim() !== "") return conclusion;
  return harness(`the round blocked on PR #${conclusion.pullRequest} with nothing to say`);
}

/** A failure of the harness's own, as the conclusion a pointer is composed from. */
function harness(reason: string): RoundConclusion {
  return { outcome: "failed", failure: "harness", reason };
}

/** The reason as the runtime takes it: one trailing newline, added where absent. */
function ending(reason: string): string {
  return reason.endsWith("\n") ? reason : `${reason}\n`;
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
