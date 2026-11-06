/**
 * The local venue's record: the threads, the summary and the failure comments
 * of one worktree's review, as files in that worktree's directory.
 *
 * `threads.json` is written whole under `threads.lock`, by a new file renamed
 * over the old, so a reader needs no lock and never sees half a file. What the
 * lock stops is a lost write: the round host and `squiz reply` both write the
 * file, and each reads it first.
 *
 * Every id is counted from the file itself, never from anything a process
 * keeps, so the count goes on across processes and across the file's life.
 * Nothing here throws.
 */

import { randomUUID } from "node:crypto";
import { linkSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { holdingLock, type UpdateOptions } from "../../loop/state-update.ts";
import type { Deadline } from "../../reviewers/deadline.ts";
import type { Failed, Posting, ReviewThread, ThreadAction } from "../venue.ts";

const THREADS_FILE = "threads.json";
const THREADS_LOCK = "threads.lock";
const SUMMARY_FILE = "summary.md";

// Every comment carries this time. The local venue tells the newest reply by
// its number, which `databaseId` carries, and a shared time leaves that to decide.
const NO_TIME = "1970-01-01T00:00:00Z";

export type RecordOptions = UpdateOptions;

/** What a new thread hangs on: one line of its file, or the file as a whole. */
export type NewAnchor = { readonly at: "line"; readonly line: number } | { readonly at: "file" };

export type Opened =
  | { readonly outcome: "opened"; readonly threadId: string; readonly commentId: string; readonly url: string }
  | Failed;

/** A thread as `threads.json` holds it. */
type StoredThread = {
  readonly id: string;
  readonly path: string;
  readonly anchor: NewAnchor;
  readonly isResolved: boolean;
  readonly comments: readonly StoredComment[];
};

type StoredComment = { readonly id: string; readonly body: string };

type Stored = { readonly threads: readonly StoredThread[] };

type Read = { readonly outcome: "read"; readonly record: Stored } | Failed;

/** Every thread in `directory`'s `threads.json`, in the order they were opened. None where there is no file. */
export function listThreads(directory: string): { readonly outcome: "listed"; readonly threads: readonly ReviewThread[] } | Failed {
  const read = readRecord(directory);
  if (read.outcome === "failed") return read;
  return { outcome: "listed", threads: read.record.threads.map(reviewThreadOf) };
}

/** Open a thread on `path` with `body` as its first comment. The local venue holds any anchor it is handed. */
export function openThread(directory: string, path: string, anchor: NewAnchor, body: string, options: RecordOptions): Opened {
  let opened: { readonly threadId: string; readonly commentId: string } | undefined;
  const changed = change(directory, "the thread could not be opened", options, (record) => {
    const threadId = `T${highest(record.threads.map((thread) => thread.id)) + 1}`;
    const commentId = `C${highestComment(record) + 1}`;
    opened = { threadId, commentId };
    const thread: StoredThread = { id: threadId, path, anchor, isResolved: false, comments: [{ id: commentId, body }] };
    return { threads: [...record.threads, thread] };
  });
  if (changed.outcome === "failed" || opened === undefined) return changed.outcome === "failed" ? changed : failed("no thread was opened");
  const url = `${pathToFileURL(join(directory, THREADS_FILE)).href}#${opened.threadId}`;
  return { outcome: "opened", ...opened, url };
}

/** Add `body` to thread `threadId` as its newest comment. */
export function addReply(directory: string, threadId: string, body: string, options: RecordOptions): ThreadAction {
  return change(directory, `the reply to ${threadId} could not be written`, options, (record) =>
    onThread(record, threadId, (thread) => ({
      ...thread,
      comments: [...thread.comments, { id: `C${highestComment(record) + 1}`, body }],
    })),
  );
}

/** Mark thread `threadId` resolved, or open again. */
export function setResolved(directory: string, threadId: string, isResolved: boolean, options: RecordOptions): ThreadAction {
  const what = isResolved ? `${threadId} could not be resolved` : `${threadId} could not be re-opened`;
  return change(directory, what, options, (record) => onThread(record, threadId, (thread) => ({ ...thread, isResolved })));
}

/** Write `body` as `summary.md`, whole, in place of any summary before it. */
export function writeSummary(directory: string, body: string, until: Deadline): Posting {
  const path = join(directory, SUMMARY_FILE);
  if (until.passed()) return failed(`${path} was not written: the deadline had passed`);
  const written = writeWhole(path, body);
  return written.outcome === "written" ? { outcome: "posted" } : written;
}

/**
 * Write `body` as the next `failure-<k>.md`, numbered on from the highest there.
 *
 * Each is linked into place under its number, so two failures written at once
 * never take one number, and neither is seen half-written.
 */
export function writeFailure(directory: string, body: string, until: Deadline): Posting {
  if (until.passed()) return failed(`no failure comment was written in ${directory}: the deadline had passed`);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    return failed(`${directory} could not be read: ${messageOf(error)}`);
  }
  const numbers = names.map((name) => /^failure-([1-9][0-9]*)\.md$/u.exec(name)?.[1]).filter((found) => found !== undefined);
  const draft = join(directory, `failure.${process.pid}.${randomUUID()}.writing`);
  try {
    writeFileSync(draft, body, { flag: "wx" });
    for (let number = highest(numbers.map((found) => `F${found}`)) + 1; ; number += 1) {
      try {
        linkSync(draft, join(directory, `failure-${number}.md`));
        return { outcome: "posted" };
      } catch (error) {
        if (codeOf(error) !== "EEXIST") throw error;
      }
    }
  } catch (error) {
    return failed(`the failure comment could not be written in ${directory}: ${messageOf(error)}`);
  } finally {
    removeQuietly(draft);
  }
}

/** Apply `edit` to the record under `threads.lock`, and write the result whole. */
function change(directory: string, what: string, options: RecordOptions, edit: (record: Stored) => Stored | Failed): ThreadAction {
  if (options.until.passed()) return failed(`${what}: the deadline had passed`);
  // A record that cannot be read now fails now, rather than after waiting out
  // the deadline on a lock that cannot be made beside it.
  const unread = readRecord(directory);
  if (unread.outcome === "failed") return unread;
  const held = holdingLock(
    directory,
    THREADS_LOCK,
    (): ThreadAction => {
      const read = readRecord(directory);
      if (read.outcome === "failed") return read;
      const edited = edit(read.record);
      if ("outcome" in edited) return edited;
      const written = writeWhole(join(directory, THREADS_FILE), `${JSON.stringify(edited, null, 2)}\n`);
      return written.outcome === "written" ? { outcome: "acted" } : written;
    },
    options,
  );
  if (held.outcome === "failed") return failed(`${what}: ${held.reason}`);
  return held.value;
}

function onThread(record: Stored, threadId: string, edit: (thread: StoredThread) => StoredThread): Stored | Failed {
  if (!record.threads.some((thread) => thread.id === threadId)) {
    return failed(`${THREADS_FILE} holds no thread ${JSON.stringify(threadId)}`);
  }
  return { threads: record.threads.map((thread) => (thread.id === threadId ? edit(thread) : thread)) };
}

/**
 * Write `text` to `path` whole: to a file of this process's own, renamed over
 * `path`. A writer killed part way leaves the file before it standing.
 */
function writeWhole(path: string, text: string): { readonly outcome: "written" } | Failed {
  const draft = `${path}.${process.pid}.${randomUUID()}.writing`;
  try {
    writeFileSync(draft, text, { flag: "wx" });
    renameSync(draft, path);
    return { outcome: "written" };
  } catch (error) {
    removeQuietly(draft);
    return failed(`${path} could not be written: ${messageOf(error)}`);
  }
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // A draft left behind is litter: nothing reads one by its name.
  }
}

function readRecord(directory: string): Read {
  const path = join(directory, THREADS_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    // Only a missing file is a record with nothing in it yet.
    if (codeOf(error) === "ENOENT") return { outcome: "read", record: { threads: [] } };
    return failed(`${path} could not be read: ${messageOf(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return failed(`${path} is not valid JSON: ${messageOf(error)}`);
  }
  const record = recordFrom(parsed);
  if (typeof record === "string") return failed(`${path} is not a record of threads: ${record}`);
  return { outcome: "read", record };
}

/** The record `parsed` holds, or what is wrong with it. */
function recordFrom(parsed: unknown): Stored | string {
  if (!isObject(parsed) || !Array.isArray(parsed["threads"])) return "it has no list of threads";
  const threads: StoredThread[] = [];
  for (const [index, entry] of parsed["threads"].entries()) {
    const thread = threadFrom(entry);
    if (typeof thread === "string") return `thread ${index + 1} ${thread}`;
    threads.push(thread);
  }
  return { threads };
}

function threadFrom(entry: unknown): StoredThread | string {
  if (!isObject(entry)) return "is not an object";
  const { id, path, anchor, isResolved, comments } = entry;
  if (typeof id !== "string" || !/^T[1-9][0-9]*$/u.test(id)) return "has no id of the form T1";
  if (typeof path !== "string") return "has no path";
  if (typeof isResolved !== "boolean") return "does not say whether it is resolved";
  const read = anchorFrom(anchor);
  if (read === undefined) return "has no anchor of a line or a file";
  if (!Array.isArray(comments) || comments.length === 0) return "has no comments";
  const stored: StoredComment[] = [];
  for (const comment of comments) {
    if (!isObject(comment) || typeof comment["body"] !== "string") return "has a comment with no body";
    const commentId = comment["id"];
    if (typeof commentId !== "string" || !/^C[1-9][0-9]*$/u.test(commentId)) return "has a comment with no id of the form C1";
    stored.push({ id: commentId, body: comment["body"] });
  }
  return { id, path, anchor: read, isResolved, comments: stored };
}

function anchorFrom(anchor: unknown): NewAnchor | undefined {
  if (!isObject(anchor)) return undefined;
  if (anchor["at"] === "file") return { at: "file" };
  const line = anchor["line"];
  if (anchor["at"] === "line" && typeof line === "number" && Number.isInteger(line) && line >= 1) return { at: "line", line };
  return undefined;
}

function reviewThreadOf(thread: StoredThread): ReviewThread {
  return {
    id: thread.id,
    isResolved: thread.isResolved,
    isOutdated: false,
    path: thread.path,
    anchor: thread.anchor,
    comments: thread.comments.map((comment) => ({
      id: comment.id,
      databaseId: Number(comment.id.slice(1)),
      author: "local",
      body: comment.body,
      createdAt: NO_TIME,
    })),
  };
}

/** The highest number among ids such as `T3`, or 0 where there are none. */
function highest(ids: readonly string[]): number {
  return ids.reduce((most, id) => Math.max(most, Number(id.slice(1))), 0);
}

function highestComment(record: Stored): number {
  return highest(record.threads.flatMap((thread) => thread.comments.map((comment) => comment.id)));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failed(reason: string): Failed {
  return { outcome: "failed", reason };
}

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
