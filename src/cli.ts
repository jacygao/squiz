/**
 * The entry point `bin/squiz` execs. Every command dispatches from here, and
 * the dispatch itself runs under the top-level trap, so nothing the binary is
 * handed can end the process non-zero and stop the coding agent finishing its
 * turn.
 *
 * stdout carries the answer to a command and nothing else. Everything that is
 * not an answer — a failure, a usage line, a branch with no pull request — goes
 * to stderr and leaves stdout empty, so that a listing GitHub never served
 * cannot be read as a pull request with nothing open on it.
 */

import { findPullRequestForBranch } from "./github/pull-request.ts";
import { replyInThread } from "./github/thread-actions.ts";
import { listReviewThreads, type ReviewThread } from "./github/threads.ts";
import { currentBranch } from "./hook/branch.ts";
import { runHook } from "./hook/hook.ts";
import { reportFailure } from "./hook/report.ts";
import { runUnderTrap, type HookExit } from "./hook/trap.ts";

// A name that is not here is reported rather than stubbed, so an agent that
// runs a command this binary does not have is told so.
const commands = ["hook", "threads", "reply"];

function dispatch(argv: readonly string[]): HookExit | Promise<HookExit> {
  const command = argv[0];
  if (command === "hook") {
    return runHook();
  }
  if (command === "threads") {
    return listThreads();
  }
  if (command === "reply") {
    return postReply(argv.slice(1));
  }

  // Exit 2 is how a round blocks the coding agent's turn, and a name the binary
  // has no command for is not grounds for that.
  const named = command === undefined ? "no command" : `no command ${JSON.stringify(command)}`;
  reportFailure(`${named}. The commands are: ${commands.join(", ")}`);
  return 0;
}

/** The pull request a command works against, or why it has none to work against. */
type Target =
  | { readonly outcome: "found"; readonly number: number; readonly nodeId: string }
  | { readonly outcome: "unavailable"; readonly reason: string };

/**
 * The open pull request whose head is the branch checked out in `directory`.
 *
 * A git that could not name the branch, a detached HEAD, a lookup that failed
 * and a branch nobody opened a pull request for all come back the same way,
 * carrying the line that says which of them happened.
 */
function targetOf(directory: string): Target {
  const branch = currentBranch(directory);
  if (branch.outcome === "failed") {
    return unavailable(`the current branch could not be resolved: ${branch.reason}`);
  }
  if (branch.outcome === "detached") {
    return unavailable("HEAD is detached here, so no branch has a pull request");
  }

  const named = JSON.stringify(branch.name);
  const found = findPullRequestForBranch(branch.name, directory);
  if (found.outcome === "failed") {
    return unavailable(`the pull request for ${named} could not be looked up: ${found.reason}`);
  }
  if (found.outcome === "none") {
    return unavailable(`no open pull request has ${named} as its head`);
  }
  return { outcome: "found", number: found.number, nodeId: found.nodeId };
}

function unavailable(reason: string): Target {
  return { outcome: "unavailable", reason };
}

/** List the open threads on the pull request for the branch the command ran on. */
function listThreads(): HookExit {
  const directory = process.cwd();
  const target = targetOf(directory);
  if (target.outcome !== "found") {
    reportFailure(`no threads listed: ${target.reason}`);
    return 0;
  }

  const listing = listReviewThreads(target.nodeId, { directory });
  if (listing.outcome !== "listed") {
    reportFailure(`the threads on #${target.number} could not be listed: ${listing.reason}`);
    return 0;
  }

  process.stdout.write(threadListing(target.number, listing.threads));
  return 0;
}

/**
 * Reply inside the thread `args` names, from the working directory.
 *
 * The pull request is looked up before the reply, so that a thread worked from
 * a branch whose pull request is gone is answered rather than replied to.
 */
function postReply(args: readonly string[]): HookExit {
  const id = args[0] ?? "";
  // The text is every remaining argument, joined, so that a body the agent left
  // unquoted arrives whole instead of coming back as a usage line.
  const body = args.slice(1).join(" ").trim();
  if (id === "" || body === "") {
    reportFailure(
      "nothing replied: squiz reply <id> <text>, where <id> is what squiz threads printed",
    );
    return 0;
  }

  const directory = process.cwd();
  const target = targetOf(directory);
  if (target.outcome !== "found") {
    reportFailure(`nothing replied: ${target.reason}`);
    return 0;
  }

  const action = replyInThread(id, body, { directory });
  if (action.outcome !== "acted") {
    reportFailure(`nothing replied in ${id}: ${action.reason}`);
    return 0;
  }

  process.stdout.write(`replied in ${id} on #${target.number}\n`);
  return 0;
}

/**
 * What `squiz threads` prints for the threads on pull request `pullRequest`.
 *
 * Resolved threads are dropped. The listing is the coding agent's queue of what
 * is still open, and a thread the reviewer closed is not on it.
 *
 * The identifier leads each line and is printed as it arrived, undecorated and
 * unwrapped: it is what `squiz reply` takes back, and a line splits into the id
 * and a location even where the path holds a space.
 */
export function threadListing(pullRequest: number, threads: readonly ReviewThread[]): string {
  const open = threads.filter((thread) => !thread.isResolved);
  // An honest zero says so in words. A command that failed prints nothing at
  // all, and the two must not read alike.
  if (open.length === 0) return `no open threads on #${pullRequest}\n`;

  const counted = `${open.length} open thread${open.length === 1 ? "" : "s"} on #${pullRequest}`;
  const lines = open.map((thread) => `${thread.id} ${locationOf(thread)}`);
  return `${[counted, ...lines].join("\n")}\n`;
}

/**
 * Where a thread is, as `file:line`.
 *
 * A thread carrying no line is anchored to the file as a whole rather than to
 * any line of it, and the listing says that in words. `file:null` names nothing
 * a reader can open.
 */
function locationOf(thread: ReviewThread): string {
  return thread.line === null ? `${thread.path} (whole file)` : `${thread.path}:${thread.line}`;
}

// The dispatch runs only where this file is the process's entry point, so that
// a test can import the listing without a command running beside it.
if (import.meta.main) {
  await runUnderTrap(() => dispatch(process.argv.slice(2)));
}
