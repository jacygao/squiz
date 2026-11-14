/**
 * The local venue: the change is the working tree against the commit its work
 * started from, and the record is files in the worktree's `.squiz/local/`.
 *
 * It runs no `gh` and needs no remote. A worktree has one episode here, keyed
 * `local`. A change it reads carries the worktree's root beside the contract's
 * fields. A thread action, which is handed no change, works on the worktree
 * this process runs in.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Deadline } from "../../reviewers/deadline.ts";
import { worktreeToplevel } from "../../worktree/toplevel.ts";
import type { Change, ChangeLookup, Failed, ThreadPosting, Venue } from "../venue.ts";
import { localDirectory, readBase, recordBase } from "./base.ts";
import { buildHead, provideCommits } from "./head.ts";
import { readPrompt, recordPrompt } from "./prompt.ts";
import { addReply, listThreads, openThread, setResolved, summaryPath, writeFailure, writeSummary, type Opened } from "./record.ts";

/** The one key the local venue names an episode by. */
export const LOCAL_KEY = "local";

const REFUSAL = "the local venue reviews the working tree, and takes no pull request number";

const DESCRIPTION_FILE = "description.md";

/** A change this venue read, with the root of the worktree it was read in. */
type WorkingTreeChange = Change & { readonly worktree: string };

export const localVenue: Venue = {
  recordStart(worktree, until) {
    if (until.passed()) return failed("the deadline had passed");
    const root = rootOf(worktree, until);
    if (typeof root !== "string") return root;
    return recordBase(root, until);
  },
  recordPrompt(worktree, prompt, until) {
    if (until.passed()) return failed("the deadline had passed");
    const root = rootOf(worktree, until);
    if (typeof root !== "string") return root;
    return recordPrompt(root, prompt);
  },
  readChange,
  episodeDirectory(worktree, key) {
    if (key !== LOCAL_KEY) return failed(REFUSAL);
    return { outcome: "found", directory: localDirectory(worktree) };
  },
  provideCommits(change, until) {
    return provideCommits(worktreeOf(change), change, until);
  },
  listThreads(change, until) {
    if (until.passed()) return failed("the threads were not listed: the deadline had passed");
    return listThreads(localDirectory(worktreeOf(change)));
  },
  openThread(change, anchor, body, until) {
    return posting(openThread(localDirectory(worktreeOf(change)), { path: anchor.path, anchor: { at: "line", line: anchor.line } }, body, { until }));
  },
  openFileThread(change, path, body, until) {
    return posting(openThread(localDirectory(worktreeOf(change)), { path, anchor: { at: "file" } }, body, { until }));
  },
  openGeneralThread(change, body, until) {
    return posting(openThread(localDirectory(worktreeOf(change)), { anchor: { at: "change" } }, body, { until }));
  },
  // Ids count up from T1 in every worktree, so an id names a thread only in
  // the worktree it is used in.
  reply(threadId, body, until) {
    const here = hereDirectory(until);
    if (typeof here !== "string") return here;
    return addReply(here, threadId, body, { until });
  },
  resolve(threadId, until) {
    const here = hereDirectory(until);
    if (typeof here !== "string") return here;
    return setResolved(here, threadId, true, { until });
  },
  reopen(threadId, until) {
    const here = hereDirectory(until);
    if (typeof here !== "string") return here;
    return setResolved(here, threadId, false, { until });
  },
  postSummary(change, body, until) {
    return writeSummary(localDirectory(worktreeOf(change)), body, until);
  },
  postFailure(change, body, until) {
    return writeFailure(localDirectory(worktreeOf(change)), body, until);
  },
};

/** The working tree of the worktree holding `directory`, built on its base. */
function readChange(directory: string, asked: string | null, until: Deadline): ChangeLookup {
  if (asked !== null && asked !== LOCAL_KEY) return { outcome: "none", reason: REFUSAL };
  const root = rootOf(directory, until);
  if (typeof root !== "string") return root;
  const base = readBase(root, until);
  if (base.outcome !== "found") return base;
  const built = buildHead(root, base.base, until);
  if (built.outcome === "failed") return built;
  const description = descriptionIn(root);
  if ("outcome" in description) return description;

  const rerun = inWorktree(root, "squiz review");
  const change: WorkingTreeChange = {
    key: LOCAL_KEY,
    name: "the working tree",
    rerun,
    summaryAt: `in ${summaryPath(localDirectory(root))}`,
    followUp: [
      `Fix what applies in ${root}, and reply on each thread with`,
      `\`${inWorktree(root, "squiz reply <id> <text>")}\` to say what you changed or why`,
      `you disagree. Then run \`${rerun}\` again.`,
    ].join("\n"),
    fixerFollowUp: [
      `Fix what applies in ${root}, and reply on each thread with`,
      `\`${inWorktree(root, "squiz reply <id> <text>")}\` to say what you changed or why`,
      "you disagree. Nothing needs committing: squiz reviews the working tree as it stands.",
    ].join("\n"),
    base: base.base,
    head: built.head,
    ...description,
    worktree: root,
  };
  return { outcome: "found", change };
}

/**
 * `description.md`, written by whoever started the run, else the run's prompt,
 * else none. A `description.md` that exists wins, even an empty one.
 */
function descriptionIn(worktree: string): Pick<Change, "description" | "descriptionFrom"> | Failed {
  const path = join(localDirectory(worktree), DESCRIPTION_FILE);
  try {
    return { description: readFileSync(path, "utf8") };
  } catch (cause) {
    if (!(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")) {
      return failed(`${path} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  const prompt = readPrompt(worktree);
  if (prompt === null) return { description: "" };
  if (typeof prompt !== "string") return prompt;
  return { description: prompt, descriptionFrom: "prompt" };
}

function rootOf(directory: string, until: Deadline): string | Failed {
  const root = worktreeToplevel(directory, until);
  if (root.outcome === "failed") return failed(`the worktree could not be resolved: ${root.reason}`);
  return root.path;
}

function hereDirectory(until: Deadline): string | Failed {
  const root = rootOf(process.cwd(), until);
  return typeof root === "string" ? localDirectory(root) : root;
}

function worktreeOf(change: Change): string {
  if ("worktree" in change && typeof change.worktree === "string") return change.worktree;
  const root = worktreeToplevel(process.cwd());
  return root.outcome === "resolved" ? root.path : process.cwd();
}

/** The local record's outcome as the contract's. The local venue holds every anchor it is handed. */
function posting(opened: Opened): ThreadPosting {
  if (opened.outcome === "failed") return opened;
  return { outcome: "posted", threadId: opened.threadId, commentId: opened.commentId, url: opened.url };
}

/**
 * `command`, run in `worktree` inside a subshell. A shell that keeps its
 * directory between calls stays where it was, so its own stops review its own tree.
 */
function inWorktree(worktree: string, command: string): string {
  return `(cd ${shellQuoted(worktree)} && ${command})`;
}

/** `text` as one word in `sh`, inside single quotes. */
function shellQuoted(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

function failed(reason: string): Failed {
  return { outcome: "failed", reason };
}
