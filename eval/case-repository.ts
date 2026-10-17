/**
 * The repository a measured case is reviewed in, with its base and head commits
 * and the diff between them.
 *
 * A case of this repository's own history is reviewed where it is. A case on
 * another project is that project cloned at a pinned commit, with the case's
 * patch committed on top as the change under review. The commit is made with a
 * fixed author, date and message and none of the user's git configuration, so
 * every preparation of a case makes the same head and every run of it reviews
 * one commit.
 *
 * Nothing here throws. Each failure comes back as a reason.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type Source =
  /** Commits already in `repository`. */
  | { readonly kind: "here"; readonly repository: string; readonly base: string; readonly head: string }
  /** A project's commit, and the file in the patch directory that holds the change. */
  | { readonly kind: "upstream"; readonly url: string; readonly commit: string; readonly patch: string };

export type Prepared =
  | {
      readonly outcome: "prepared";
      readonly repository: string;
      /** Full object names. */
      readonly base: string;
      readonly head: string;
      readonly diff: string;
    }
  | { readonly outcome: "failed"; readonly reason: string };

// No signing, hook or template of the user's reaches the commit, which would
// change its name or run something.
const QUIET_GIT: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "measure",
  GIT_AUTHOR_EMAIL: "measure@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "measure",
  GIT_COMMITTER_EMAIL: "measure@example.invalid",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

/**
 * Prepare the case `name`, cloning an upstream case the first time and reusing
 * that clone after. The clone is named for the case's project, commit and patch
 * contents, so an edited patch is prepared afresh rather than read from a clone
 * of the old one. Concurrent first preparations of one case race; prepare each
 * case once before running them side by side.
 */
export function prepareCase(name: string, source: Source, patches: string, cache: string): Prepared {
  try {
    if (source.kind === "here") {
      const base = git(source.repository, "rev-parse", `${source.base}^{commit}`);
      const head = git(source.repository, "rev-parse", `${source.head}^{commit}`);
      return { outcome: "prepared", repository: source.repository, base, head, diff: diffOf(source.repository, base, head) };
    }
    const patch = resolve(patches, source.patch);
    const identity = createHash("sha256")
      .update(`${source.url}\n${source.commit}\n`)
      .update(readFileSync(patch))
      .digest("hex")
      .slice(0, 16);
    const repository = join(cache, `${name}-${identity}`);
    if (!existsSync(repository)) {
      execFileSync("git", ["clone", "--quiet", source.url, repository], { env: QUIET_GIT, stdio: "pipe" });
      git(repository, "checkout", "--quiet", "--detach", source.commit);
      git(repository, "apply", patch);
      git(repository, "add", "--all");
      git(repository, "commit", "--quiet", "--no-verify", "-m", name);
    }
    const base = git(repository, "rev-parse", `${source.commit}^{commit}`);
    const head = git(repository, "rev-parse", "HEAD");
    const parent = git(repository, "rev-parse", "HEAD^");
    if (parent !== base) {
      return { outcome: "failed", reason: `${repository} holds ${head}, whose parent is not ${base}` };
    }
    return { outcome: "prepared", repository, base, head, diff: diffOf(repository, base, head) };
  } catch (cause) {
    const said = cause instanceof Error ? cause.message : String(cause);
    return { outcome: "failed", reason: `case ${name} could not be prepared: ${said}` };
  }
}

function diffOf(repository: string, base: string, head: string): string {
  return execFileSync("git", ["-C", repository, "diff", base, head], { encoding: "utf8", env: QUIET_GIT, maxBuffer: 64 * 1024 * 1024 });
}

function git(repository: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", env: QUIET_GIT, stdio: "pipe" }).trim();
}
