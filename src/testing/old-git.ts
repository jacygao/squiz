/**
 * A `git` that answers as git 2.25 does, for a test of squiz on the git that
 * Ubuntu 20.04 ships.
 *
 * It differs from the git it wraps in the places squiz has met:
 *
 * - `git worktree list` refuses `-z`, which arrived in 2.36, as a usage error.
 * - `git rev-parse` prints a `--path-format=` option back as if it were an
 *   argument, since the option arrived in 2.31, and exits 0.
 * - `git rev-parse --quiet --verify @{push}` on a branch with no push
 *   destination dies with exit 128, where a newer git exits 1 and says nothing.
 * - `git fetch` refuses `--no-write-fetch-head`, which arrived in 2.29, as a
 *   usage error.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { standIn } from "./stand-in.ts";

/** The script for the old git, which runs the git at `real` for everything else. */
export function oldGitScript(real: string): string {
  return [
    'if [ "$1" = "--version" ]; then echo "git version 2.25.1"; exit 0; fi',
    'if [ "$1" = "worktree" ] && [ "$2" = "list" ]; then',
    '  for each in "$@"; do',
    "    if [ \"$each\" = \"-z\" ]; then echo \"error: unknown switch \\`z'\" >&2; exit 129; fi",
    "  done",
    "fi",
    'if [ "$1" = "fetch" ]; then',
    '  for each in "$@"; do',
    "    if [ \"$each\" = \"--no-write-fetch-head\" ]; then echo \"error: unknown option \\`no-write-fetch-head'\" >&2; exit 129; fi",
    "  done",
    "fi",
    'if [ "$1" = "rev-parse" ]; then',
    "  shift",
    '  for each in "$@"; do',
    "    shift",
    '    case "$each" in',
    '      --path-format=*) echo "$each" ;;',
    '      *) set -- "$@" "$each" ;;',
    "    esac",
    "  done",
    '  push=; for each in "$@"; do [ "$each" = "@{push}" ] && push=1; done',
    `  '${real}' rev-parse "$@"`,
    "  status=$?",
    "  if [ -n \"$push\" ] && [ $status -eq 1 ]; then echo \"fatal: no upstream configured for branch\" >&2; exit 128; fi",
    "  exit $status",
    "fi",
    `exec '${real}' "$@"`,
    "",
  ].join("\n");
}

/** Where the git on this process's `PATH` is, which the old git runs underneath. */
export function realGit(): string {
  const found = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  const path = found.stdout.trim();
  if (found.status !== 0 || path === "") throw new Error("no git is on PATH");
  return path;
}

/** Make the old git a command named `git` in `directory`, and return its path. */
export function oldGitIn(directory: string): string {
  return standIn(directory, "git", oldGitScript(realGit()));
}

/**
 * Run `body` with the old git first on this process's `PATH`, and put `PATH`
 * back however it ends.
 */
export async function underOldGit<T>(body: () => Promise<T> | T): Promise<T> {
  const bin = mkdtempSync(join(tmpdir(), "squiz-old-git-"));
  oldGitIn(bin);
  const previous = process.env["PATH"];
  process.env["PATH"] = previous === undefined ? bin : `${bin}${delimiter}${previous}`;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
    rmSync(bin, { recursive: true, force: true });
  }
}
