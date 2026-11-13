/**
 * The local venue's base: where a worktree's work started, recorded once when
 * the first session or subagent starts in it, and read as the commit every
 * review of the working tree is against.
 *
 * The record is never overwritten. A resumed session, a second session, and a
 * subagent sharing its parent's directory each start again in the same
 * worktree, after the work has moved `HEAD`, and only the first start saw
 * where the work began.
 *
 * Nothing here throws. Each failure comes back as a reason.
 */

import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeStateDirectory } from "../../loop/state-directory.ts";
import type { Deadline } from "../../reviewers/deadline.ts";
import { runGit, withoutGitVariables } from "../../worktree/git.ts";
import type { Failed } from "../venue.ts";

/** What `base.json` holds. */
type Record = { readonly commit: string; readonly branches: readonly string[] };

export type BaseRead =
  | { readonly outcome: "found"; readonly base: string }
  /** The line `squiz review` exits 1 with. */
  | { readonly outcome: "none"; readonly reason: string }
  | Failed;

const BASE_FILE = "base.json";

// A full object name, SHA-1 or SHA-256. Anything else may name a branch that
// moves, or reach git as an option.
const FULL_COMMIT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** The directory the local venue keeps everything in, in the worktree whose root is `worktree`. */
export function localDirectory(worktree: string): string {
  return join(worktree, ".squiz", "local");
}

/**
 * Record `worktree`'s `HEAD`, and the branches pointing at it, as where its work
 * started. A record already there is left as it is, and so is one another
 * start writes first.
 *
 * `worktree` is a worktree's root. `.squiz/.gitignore` is written before the
 * record, so nothing written here becomes part of the change.
 */
export function recordBase(worktree: string, until: Deadline): { readonly outcome: "done" } | Failed {
  const local = localDirectory(worktree);
  const path = join(local, BASE_FILE);
  const there = exists(path);
  if (typeof there !== "boolean") return there;
  if (there) return { outcome: "done" };

  const env = withoutGitVariables();
  const head = runGit(worktree, ["rev-parse", "--quiet", "--verify", "HEAD^{commit}"], { until, answers: [0, 1], env });
  if (!head.ran) return failed(`the HEAD of ${worktree} could not be read: ${head.reason}`);
  if (head.status !== 0) return failed(`${worktree} has no commit yet, so no base was recorded`);
  const commit = head.stdout.trim();

  // A symbolic ref, such as origin/HEAD, names another branch and is none itself.
  const pointing = runGit(
    worktree,
    ["for-each-ref", "--points-at", commit, "--format=%(refname)%00%(symref)", "refs/heads", "refs/remotes"],
    { until, env },
  );
  if (!pointing.ran) return failed(`the branches at ${commit} could not be listed: ${pointing.reason}`);
  const branches = pointing.stdout
    .split("\n")
    .map((line) => line.split("\0"))
    .filter(([name = "", symref = ""]) => name !== "" && symref === "")
    .map(([name = ""]) => name);

  try {
    makeStateDirectory(local);
  } catch (cause) {
    return failed(`${local} could not be made: ${messageOf(cause)}`);
  }
  const record: Record = { commit, branches };
  return place(path, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * The base of `worktree`'s change now: the newest of the recorded commit and
 * the merge-base of `HEAD` with each recorded branch as it stands.
 *
 * Three kinds of recorded branch are left out:
 *
 * - the branch checked out now, and its namesake on every remote, which move
 *   with the work;
 * - a branch that no longer exists;
 * - a branch whose merge-base does not descend from the recorded commit.
 *
 * Of what remains, the base is the one every other is an ancestor of, and the
 * recorded commit where none is.
 */
export function readBase(worktree: string, until: Deadline): BaseRead {
  const read = readRecord(worktree);
  if (read.outcome !== "found") return read;
  const { record } = read;
  const env = withoutGitVariables();
  const git = (args: readonly string[]) => runGit(worktree, args, { until, answers: [0, 1], env });

  const present = git(["rev-parse", "--quiet", "--verify", `${record.commit}^{commit}`]);
  if (!present.ran) return failed(`whether the recorded base ${record.commit} is a commit could not be told: ${present.reason}`);
  if (present.status !== 0) return none(`the recorded base ${record.commit} is not a commit in ${worktree}`);

  const own = ownBranches(worktree, until, env);
  if (typeof own === "string") return failed(own);

  const candidates = [record.commit];
  for (const branch of record.branches) {
    if (own.has(branch)) continue;
    const tip = git(["rev-parse", "--quiet", "--verify", `${branch}^{commit}`]);
    if (!tip.ran) return failed(`${branch} could not be read: ${tip.reason}`);
    if (tip.status !== 0) continue;
    // Exit 1 is two histories with no commit in common.
    const meeting = git(["merge-base", "HEAD", tip.stdout.trim()]);
    if (!meeting.ran) return failed(`the merge-base of HEAD and ${branch} could not be found: ${meeting.reason}`);
    if (meeting.status !== 0) continue;
    const found = meeting.stdout.trim();
    const descends = isAncestor(git, record.commit, found);
    if (typeof descends === "string") return failed(descends);
    if (descends && !candidates.includes(found)) candidates.push(found);
  }

  for (const candidate of candidates) {
    let newest = true;
    for (const other of candidates) {
      if (other === candidate) continue;
      const below = isAncestor(git, other, candidate);
      if (typeof below === "string") return failed(below);
      if (!below) {
        newest = false;
        break;
      }
    }
    if (newest) return { outcome: "found", base: candidate };
  }
  return { outcome: "found", base: record.commit };
}

type RecordRead = { readonly outcome: "found"; readonly record: Record } | { readonly outcome: "none"; readonly reason: string } | Failed;

function readRecord(worktree: string): RecordRead {
  const path = join(localDirectory(worktree), BASE_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    if (codeOf(cause) === "ENOENT") {
      return none(`${worktree} has no recorded base, which squiz records when a session or subagent starts there`);
    }
    return failed(`${path} could not be read: ${messageOf(cause)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return failed(`${path} is not valid JSON: ${messageOf(cause)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return failed(`${path} is not a JSON object`);
  const { commit, branches } = parsed as { readonly commit?: unknown; readonly branches?: unknown };
  if (typeof commit !== "string" || !FULL_COMMIT_NAME.test(commit)) return failed(`${path} names no full commit`);
  // A name that is not under refs/ could reach git as an option.
  if (!Array.isArray(branches) || !branches.every((branch) => typeof branch === "string" && branch.startsWith("refs/"))) {
    return failed(`${path} holds no list of branches under refs/`);
  }
  return { outcome: "found", record: { commit, branches } };
}

/**
 * The branches that move with the work: the one `worktree` has checked out, and
 * the branch of the same name on each remote. An upstream of another name is
 * not among them.
 */
function ownBranches(worktree: string, until: Deadline, env: NodeJS.ProcessEnv): Set<string> | string {
  const checkedOut = runGit(worktree, ["symbolic-ref", "--quiet", "HEAD"], { until, answers: [0, 1], env });
  if (!checkedOut.ran) return `the branch checked out in ${worktree} could not be read: ${checkedOut.reason}`;
  const own = new Set<string>();
  if (checkedOut.status !== 0) return own;
  const branch = checkedOut.stdout.trim();
  own.add(branch);
  if (!branch.startsWith("refs/heads/")) return own;
  const name = branch.slice("refs/heads/".length);
  const remotes = runGit(worktree, ["remote"], { until, env });
  if (!remotes.ran) return `the remotes of ${worktree} could not be listed: ${remotes.reason}`;
  for (const remote of remotes.stdout.split("\n")) {
    if (remote !== "") own.add(`refs/remotes/${remote}/${name}`);
  }
  return own;
}

function isAncestor(git: (args: readonly string[]) => ReturnType<typeof runGit>, ancestor: string, of: string): boolean | string {
  if (ancestor === of) return true;
  const asked = git(["merge-base", "--is-ancestor", ancestor, of]);
  if (!asked.ran) return `whether ${ancestor} is an ancestor of ${of} could not be told: ${asked.reason}`;
  return asked.status === 0;
}

/**
 * Link `path` into being holding `text`, unless something has that name. Two
 * writers at once both find no record, and a link fails where the name exists,
 * so the first one stands, and no reader sees it half written.
 */
export function place(path: string, text: string): { readonly outcome: "done" } | Failed {
  const draft = `${path}.${process.pid}.${randomUUID()}.writing`;
  try {
    writeFileSync(draft, text, { flag: "wx" });
    linkSync(draft, path);
    return { outcome: "done" };
  } catch (cause) {
    if (codeOf(cause) === "EEXIST") return { outcome: "done" };
    return failed(`${path} could not be written: ${messageOf(cause)}`);
  } finally {
    try {
      rmSync(draft, { force: true });
    } catch {
      // A draft left behind is litter: nothing reads one by its name.
    }
  }
}

function exists(path: string): boolean | Failed {
  try {
    lstatSync(path);
    return true;
  } catch (cause) {
    if (codeOf(cause) === "ENOENT") return false;
    return failed(`${path} could not be read: ${messageOf(cause)}`);
  }
}

function none(reason: string): { readonly outcome: "none"; readonly reason: string } {
  return { outcome: "none", reason };
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
