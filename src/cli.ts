/**
 * The entry point `bin/squiz` execs. Every command dispatches from here, and
 * the dispatch itself runs under the top-level trap. Every command but
 * `squiz review`, `squiz init`, `squiz doctor` and `squiz version` exits 0
 * whatever it is handed, and says on stderr what failed. `squiz review` exits
 * with the status its result gives, and 1 where it could not run. The other
 * three are run by a person: `init` exits 1 where it could not link squiz onto
 * PATH, `doctor` where a required dependency is not usable, and `version` where
 * this squiz's version cannot be read.
 *
 * stdout carries the answer to a command and nothing else. Everything that is
 * not an answer — a failure, a usage line, a branch with no pull request — goes
 * to stderr and leaves stdout empty, so that a listing GitHub never served
 * cannot be read as a pull request with nothing open on it.
 */

import { renderReply } from "./findings/comment.ts";
import { threadListing } from "./findings/listing.ts";
import { runHook } from "./hook/hook.ts";
import { reportFailure } from "./hook/report.ts";
import { runUnderTrap, type HookExit, type Trapped } from "./hook/trap.ts";
import { hostCommand } from "./host/command.ts";
import { squizDoctor } from "./review/doctor.ts";
import { squizInit } from "./review/init.ts";
import { thisSquiz } from "./review/path-link.ts";
import { unprinted } from "./review/output.ts";
import { REVIEW_BUDGET_MS, runReview } from "./review/review.ts";
import { squizStatus } from "./review/status.ts";
import { squizVersion } from "./review/version.ts";
import { deadlineIn, type Deadline } from "./reviewers/deadline.ts";
import { LOCAL_KEY } from "./venues/local/venue.ts";
import { venueAt, type Change, type Venue } from "./venues/venue.ts";

// A name that is not here is reported rather than stubbed, so an agent that
// runs a command this binary does not have is told so.
const commands = ["hook", "threads", "reply", "status", "host", "review", "init", "doctor", "version"];

// `gh auth status` asks GitHub about each login, so it is given a network's time.
const PROBE_BOUND_MS = 15_000;

// Copilot's sign-in prompt took 13 seconds when it was measured.
const SIGN_IN_BOUND_MS = 60_000;

// Under the two minutes Claude Code gives a shell command by default.
const THREAD_COMMAND_BUDGET_MS = 100_000;

function dispatch(argv: readonly string[]): number | Promise<number> {
  const command = argv[0];
  if (command === "review") {
    return review(argv.slice(1));
  }
  if (command === "hook") {
    return runHook({ stdin: process.stdin });
  }
  if (command === "threads") {
    return listThreads();
  }
  if (command === "reply") {
    return postReply(argv.slice(1));
  }
  if (command === "status") {
    const chosen = venueAt(process.cwd());
    if (chosen.outcome === "failed") {
      reportFailure(`no reviews listed: ${chosen.reason}`);
      return 0;
    }
    const printed = squizStatus(process.cwd(), chosen.venue);
    process.stdout.write(printed.stdout);
    process.stderr.write(printed.stderr);
    return 0;
  }
  if (command === "host") {
    return hostCommand(argv.slice(1), process.cwd());
  }
  if (command === "doctor") {
    const printed = squizDoctor({ environment: process.env, directory: process.cwd(), nodeVersion: process.versions.node, boundMs: PROBE_BOUND_MS, signInBoundMs: SIGN_IN_BOUND_MS, platform: process.platform });
    process.stdout.write(printed.stdout);
    process.stderr.write(printed.stderr);
    return printed.exit;
  }
  if (command === "init") {
    const printed = squizInit(process.cwd(), process.env, thisSquiz());
    process.stdout.write(printed.stdout);
    process.stderr.write(printed.stderr);
    return printed.exit;
  }
  if (isVersion(command)) {
    const printed = squizVersion();
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
 * Review the change `args` names, wait for the round, and exit as its result
 * says. Unlike the hook's, every status here is the coding agent's to read, so
 * a review that could not run exits 1.
 *
 * A pull request is named by its number. A venue whose one episode is keyed
 * `local` reviews the working tree, and is named nothing.
 */
async function review(args: readonly string[]): Promise<number> {
  // The venue is read inside the run's one deadline, as everything the run does is.
  const until = deadlineIn(REVIEW_BUDGET_MS);
  let [key] = args;
  if (key === undefined) {
    const chosen = venueAt(process.cwd(), until);
    if (chosen.outcome === "failed") {
      const printed = unprinted(`no review ran: ${chosen.reason}`);
      process.stderr.write(printed.stderr);
      return printed.exit;
    }
    if (chosen.venue.episodeDirectory(process.cwd(), LOCAL_KEY).outcome === "found") key = LOCAL_KEY;
  }
  if (args.length > 1 || key === undefined) {
    reportFailure("no review ran: squiz review <number>, where <number> is the pull request's");
    return 1;
  }

  const printed = await runReview({ directory: process.cwd(), key, environment: process.env, until });
  process.stdout.write(printed.stdout);
  process.stderr.write(printed.stderr);
  return printed.exit;
}

/** The change a command works against, with its venue, or the line saying why it has none. */
type Target =
  | { readonly outcome: "found"; readonly venue: Venue; readonly change: Change }
  | { readonly outcome: "unavailable"; readonly reason: string };

/**
 * The change the venue reads in `directory`. A venue that cannot be chosen, a
 * change the venue holds back, none, and a lookup that failed all come back the
 * same way, carrying the venue's line for which of them happened.
 */
function targetOf(directory: string, until: Deadline): Target {
  const chosen = venueAt(directory, until);
  if (chosen.outcome === "failed") return { outcome: "unavailable", reason: chosen.reason };
  const lookup = chosen.venue.readChange(directory, null, until);
  switch (lookup.outcome) {
    case "found":
      return { outcome: "found", venue: chosen.venue, change: lookup.change };
    case "held":
      return { outcome: "unavailable", reason: lookup.line };
    case "none":
    case "failed":
      return { outcome: "unavailable", reason: lookup.reason };
  }
}

/** List the open threads on the change the venue reads where the command ran. */
function listThreads(): HookExit {
  const until = deadlineIn(THREAD_COMMAND_BUDGET_MS);
  const target = targetOf(process.cwd(), until);
  if (target.outcome !== "found") {
    reportFailure(`no threads listed: ${target.reason}`);
    return 0;
  }

  const { venue, change } = target;
  const listing = venue.listThreads(change, until);
  if (listing.outcome !== "listed") {
    reportFailure(`the threads on ${listedName(change)} could not be listed: ${listing.reason}`);
    return 0;
  }

  process.stdout.write(threadListing(listedName(change), listing.threads));
  return 0;
}

/** What the thread commands call `change`: `#41` for a pull request, as they always have, and the change's name otherwise. */
function listedName(change: Change): string {
  return change.name === `PR #${change.key}` ? `#${change.key}` : change.name;
}

/**
 * Reply inside the thread `args` names, from the working directory.
 *
 * The change is read before the reply, so that a thread worked from a branch
 * whose pull request is gone is answered rather than replied to.
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

  const until = deadlineIn(THREAD_COMMAND_BUDGET_MS);
  const target = targetOf(process.cwd(), until);
  if (target.outcome !== "found") {
    reportFailure(`nothing replied: ${target.reason}`);
    return 0;
  }

  const action = target.venue.reply(id, renderReply(body), until);
  if (action.outcome !== "acted") {
    reportFailure(`nothing replied in ${id}: ${action.reason}`);
    return 0;
  }

  process.stdout.write(`replied in ${id} on ${listedName(target.change)}\n`);
  return 0;
}

/** How a throw ends `command`: at exit 1 where the status is read, and as the hook's otherwise. */
function trappedFor(command: string | undefined): Trapped | undefined {
  if (command === "review") return { exit: 1, failed: "the review failed" };
  if (command === "init") return { exit: 1, failed: "squiz init failed" };
  if (command === "doctor") return { exit: 1, failed: "squiz doctor failed" };
  if (isVersion(command)) return { exit: 1, failed: "squiz version failed" };
  return undefined;
}

function isVersion(command: string | undefined): boolean {
  return command === "version" || command === "--version";
}

// The dispatch runs only where this file is the process's entry point, so that
// importing it runs no command.
if (import.meta.main) {
  const argv = process.argv.slice(2);
  await runUnderTrap(() => dispatch(argv), trappedFor(argv[0]));
}
