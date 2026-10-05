/**
 * The entry point `bin/squiz` execs. Every command dispatches from here, and
 * the dispatch itself runs under the top-level trap. Every command but
 * `squiz review` and `squiz init` exits 0 whatever it is handed, and says on
 * stderr what failed. `squiz review` exits with the status its result gives,
 * and 1 where it could not run. `squiz init` is run by a person, and exits 1
 * where it could not add the section.
 *
 * stdout carries the answer to a command and nothing else. Everything that is
 * not an answer — a failure, a usage line, a branch with no pull request — goes
 * to stderr and leaves stdout empty, so that a listing GitHub never served
 * cannot be read as a pull request with nothing open on it.
 */

import { renderReply } from "./findings/comment.ts";
import { threadListing } from "./findings/listing.ts";
import { findPullRequestForBranch } from "./github/pull-request.ts";
import { replyInThread } from "./github/thread-actions.ts";
import { listReviewThreads } from "./github/threads.ts";
import { currentBranch } from "./hook/branch.ts";
import { runHook } from "./hook/hook.ts";
import { reportFailure } from "./hook/report.ts";
import { runUnderTrap, type HookExit, type Trapped } from "./hook/trap.ts";
import { hostCommand } from "./host/command.ts";
import { squizInit } from "./review/init.ts";
import { runReview } from "./review/review.ts";
import { squizStatus } from "./review/status.ts";

// A name that is not here is reported rather than stubbed, so an agent that
// runs a command this binary does not have is told so.
const commands = ["hook", "threads", "reply", "status", "host", "review", "init"];

const numberSpelling = /^[1-9][0-9]*$/u;

function dispatch(argv: readonly string[]): number | Promise<number> {
  const command = argv[0];
  if (command === "review") {
    return review(argv.slice(1));
  }
  if (command === "hook") {
    return runHook({ stdin: process.stdin, directory: process.cwd() });
  }
  if (command === "threads") {
    return listThreads();
  }
  if (command === "reply") {
    return postReply(argv.slice(1));
  }
  if (command === "status") {
    const printed = squizStatus(process.cwd());
    process.stdout.write(printed.stdout);
    process.stderr.write(printed.stderr);
    return 0;
  }
  if (command === "host") {
    return hostCommand(argv.slice(1), process.cwd());
  }
  if (command === "init") {
    const printed = squizInit(process.cwd());
    process.stdout.write(printed.stdout);
    process.stderr.write(printed.stderr);
    return printed.exit;
  }

  // Exit 2 says threads are open, and a name the binary has no command for is
  // not grounds for that.
  const named = command === undefined ? "no command" : `no command ${JSON.stringify(command)}`;
  reportFailure(`${named}. The commands are: ${commands.join(", ")}`);
  return 0;
}

/**
 * Review the pull request `args` names, wait for the round, and exit as its
 * result says. Unlike the hook's, every status here is the coding agent's to
 * read, so a review that could not run exits 1.
 */
async function review(args: readonly string[]): Promise<number> {
  const named = args[0] ?? "";
  const pullRequest = Number(named);
  if (args.length !== 1 || !numberSpelling.test(named) || !Number.isSafeInteger(pullRequest)) {
    reportFailure("no review ran: squiz review <number>, where <number> is the pull request's");
    return 1;
  }

  const printed = await runReview({ directory: process.cwd(), pullRequest, environment: process.env });
  process.stdout.write(printed.stdout);
  process.stderr.write(printed.stderr);
  return printed.exit;
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
  const found = findPullRequestForBranch(branch.name, { directory: directory });
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
 *
 * What is posted carries the coding agent's marker rather than the text alone.
 * The marker is the only thing that tells the reply from a comment a person left,
 * and a thread read back at the close is a disagreement or a finding nobody
 * answered depending on which it was.
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

  const action = replyInThread(id, renderReply(body), { directory });
  if (action.outcome !== "acted") {
    reportFailure(`nothing replied in ${id}: ${action.reason}`);
    return 0;
  }

  process.stdout.write(`replied in ${id} on #${target.number}\n`);
  return 0;
}

/** How a throw ends `command`: at exit 1 where the status is read, and as the hook's otherwise. */
function trappedFor(command: string | undefined): Trapped | undefined {
  if (command === "review") return { exit: 1, failed: "the review failed" };
  if (command === "init") return { exit: 1, failed: "squiz init failed" };
  return undefined;
}

// The dispatch runs only where this file is the process's entry point, so that
// importing it runs no command.
if (import.meta.main) {
  const argv = process.argv.slice(2);
  await runUnderTrap(() => dispatch(argv), trappedFor(argv[0]));
}
