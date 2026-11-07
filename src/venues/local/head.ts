/**
 * The local venue's head: a commit built from the working tree, on the base,
 * whose sha depends only on its tree and its base.
 *
 * A build writes its objects into the venue's own object directory, through an
 * index of its own, so the repository's index, objects and refs are as they
 * were. The coding agent is working in that repository while builds run.
 *
 * Nothing here throws. Each failure comes back as a reason.
 */

import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { Deadline } from "../../reviewers/deadline.ts";
import { runGit } from "../../worktree/git.ts";
import type { Change, Failed } from "../venue.ts";

export type HeadBuild =
  | { readonly outcome: "built"; readonly head: string }
  /** The line `squiz review` exits 1 with. */
  | { readonly outcome: "none"; readonly reason: string }
  | Failed;

// A full object name, SHA-1 or SHA-256. Anything else may name a branch that
// moves, or reach git as an option.
const FULL_COMMIT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

const MESSAGE = "squiz: the working tree";

// Git reads `@0` as the epoch, 1970-01-01T00:00:00Z.
const IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "squiz",
  GIT_AUTHOR_EMAIL: "squiz@localhost",
  GIT_AUTHOR_DATE: "@0 +0000",
  GIT_COMMITTER_NAME: "squiz",
  GIT_COMMITTER_EMAIL: "squiz@localhost",
  GIT_COMMITTER_DATE: "@0 +0000",
};

/** Where the venue in `local` keeps the objects of every head it builds. */
export function headObjects(local: string): string {
  return join(local, "objects");
}

/**
 * Build the head of `worktree`, a worktree's root, on `base`, with its objects
 * in `local`'s object directory.
 *
 * The tree is what `git add --all` in the worktree would stage, the worktree's
 * own ignore rules and filters applied, in a copy of its index named for this
 * process. The copy is removed however the build ends.
 *
 * `none` is a base that is not a full commit sha, or not a commit the
 * repository has.
 */
export function buildHead(worktree: string, local: string, base: string, until: Deadline): HeadBuild {
  if (!FULL_COMMIT_NAME.test(base)) {
    return { outcome: "none", reason: `SQUIZ_BASE is ${JSON.stringify(base)}, and the local venue takes a full commit sha` };
  }
  const plain = withoutGitVariables();
  const known = isCommit(worktree, base, plain, until);
  if (typeof known === "string") return failed(`whether SQUIZ_BASE ${base} is a commit could not be told: ${known}`);
  if (!known) return { outcome: "none", reason: `SQUIZ_BASE ${base} is not a commit in ${worktree}` };

  const paths = runGit(
    worktree,
    ["rev-parse", "--path-format=absolute", "--git-path", "index", "--git-path", "objects"],
    { until, env: plain },
  );
  if (!paths.ran) return failed(`the repository of ${worktree} could not be found: ${paths.reason}`);
  const [index = "", repositoryObjects = ""] = paths.stdout.split("\n");

  const objects = headObjects(local);
  try {
    mkdirSync(objects, { recursive: true });
  } catch (cause) {
    return failed(`${objects} could not be made: ${messageOf(cause)}`);
  }

  const copy = join(local, `index.${process.pid}`);
  try {
    // A copy left by an earlier process of this pid is replaced, and a
    // worktree with no index yet starts from none.
    rmSync(copy, { force: true });
    copyFileSync(index, copy);
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) {
      return failed(`the index of ${worktree} could not be copied to ${copy}: ${messageOf(cause)}`);
    }
  }
  const built = commitWorkingTree(
    worktree,
    base,
    { ...plain, GIT_INDEX_FILE: copy, GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: repositoryObjects },
    until,
  );
  try {
    rmSync(copy, { force: true });
  } catch {
    // The head stands either way, and the next build of this pid replaces the copy.
  }
  return built;
}

function commitWorkingTree(worktree: string, base: string, env: NodeJS.ProcessEnv, until: Deadline): HeadBuild {
  // The monitor and a split index each keep state for the worktree's own
  // index, which its copy must not share. Every command that writes the copy
  // takes them, since a split index writes its shared part into the
  // repository's git directory.
  const isolated = ["-c", "core.fsmonitor=false", "-c", "core.splitIndex=false"];
  const added = runGit(worktree, [...isolated, "add", "--all"], { until, env });
  if (!added.ran) return failed(`the working tree could not be staged: ${added.reason}`);
  const tree = runGit(worktree, [...isolated, "write-tree"], { until, env });
  if (!tree.ran) return failed(`the working tree's tree could not be written: ${tree.reason}`);

  // Signing, or an encoding header, would make the sha depend on the user's
  // config. The system and user configs go, and the repository's is overridden.
  const made = runGit(
    worktree,
    [
      "-c",
      "commit.gpgSign=false",
      "-c",
      "i18n.commitEncoding=UTF-8",
      "commit-tree",
      "--no-gpg-sign",
      tree.stdout.trim(),
      "-p",
      base,
      "-m",
      MESSAGE,
    ],
    { until, env: { ...env, ...IDENTITY, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } },
  );
  if (!made.ran) return failed(`the head could not be committed: ${made.reason}`);
  return { outcome: "built", head: made.stdout.trim() };
}

/**
 * The alternates a snapshot of `change` borrows from: the venue's object
 * directory, once both the head and the base can be read through it.
 */
export function provideCommits(
  local: string,
  worktree: string,
  change: Change,
  until: Deadline,
): { readonly outcome: "ready"; readonly alternates: readonly string[] } | Failed {
  const objects = headObjects(local);
  const env = { ...withoutGitVariables(), GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
  for (const name of [change.head, change.base]) {
    if (!FULL_COMMIT_NAME.test(name)) return failed(`${JSON.stringify(name)} is not a full commit name`);
    const known = isCommit(worktree, name, env, until);
    if (typeof known === "string") return failed(`whether ${name} is here could not be told: ${known}`);
    if (!known) return failed(`${name} is a commit in neither the repository of ${worktree} nor ${objects}`);
  }
  return { outcome: "ready", alternates: [objects] };
}

/** Whether `name` is a commit in the repository of `worktree`, or why that could not be told. */
function isCommit(worktree: string, name: string, env: NodeJS.ProcessEnv, until: Deadline): boolean | string {
  // Exit 1 with nothing said is an object the repository does not have. Its
  // type is asked apart, because peeling one that is not a commit is an error.
  const present = runGit(worktree, ["rev-parse", "--quiet", "--verify", `${name}^{object}`], {
    until,
    answers: [0, 1],
    env,
  });
  if (!present.ran) return present.reason;
  if (present.status !== 0) return false;
  const type = runGit(worktree, ["cat-file", "-t", name], { until, env });
  if (!type.ran) return type.reason;
  return type.stdout.trim() === "commit";
}

/**
 * This process's environment less every `GIT_` variable, any of which could
 * name another repository, index or object directory.
 */
function withoutGitVariables(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) environment[key] = value;
  }
  return environment;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function failed(reason: string): Failed {
  return { outcome: "failed", reason };
}
