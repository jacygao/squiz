/**
 * `squiz host` as a process, with nothing queued for its own pull request and
 * the directories of other pull requests' episodes beside its own. A `gh` on
 * `PATH` answers each `gh pr view <number> --json state` from a file named by
 * the number, and refuses anything else.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { identityOf } from "../sessions/process.ts";

const binary = fileURLToPath(new URL("../../bin/squiz", import.meta.url));

// Each answer file holds what gh prints, or `fail` for a gh that exits 1, or
// `hang` for one that never answers.
const FAKE_GH = `#!/bin/sh
if [ "$1" != pr ] || [ "$2" != view ] || [ "$4" != --json ] || [ "$5" != state ] || [ "$#" != 5 ]; then
  echo "unexpected gh call: $*" >&2; exit 1
fi
answer="$(cat "$SQUIZ_TEST_ANSWERS/$3" 2>/dev/null)"
case "$answer" in
  fail) echo "HTTP 502: Bad Gateway" >&2; exit 1 ;;
  hang) exec sleep 600 ;;
  "") echo "no answer for $3" >&2; exit 1 ;;
  *) printf '%s\\n' "$answer" ;;
esac
`;

type Tree = { readonly base: string; readonly worktree: string; readonly answers: string; readonly bin: string };

function tree(): Tree {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "squiz-sweep-")));
  const worktree = join(base, "work");
  const answers = join(base, "answers");
  const bin = join(base, "bin");
  for (const directory of [worktree, answers, bin]) mkdirSync(directory);
  for (const args of [["init", "--quiet"], ["commit", "--quiet", "--allow-empty", "-m", "first"]]) {
    const ran = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: worktree, encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
  }
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  return { base, worktree, answers, bin };
}

/** An episode directory for `key`, holding a state file, as a finished round leaves one. */
function episode(at: Tree, key: string): string {
  const directory = join(at.worktree, ".squiz", key);
  mkdirSync(join(directory, "rounds", "1"), { recursive: true });
  writeFileSync(join(directory, "state.json"), "{}\n");
  return directory;
}

function answer(at: Tree, number: string, said: string): void {
  writeFileSync(join(at.answers, number), said);
}

function host(at: Tree, key = "41"): { status: number | null; stderr: string; log: string; seconds: number } {
  const started = Date.now();
  const ran = spawnSync(binary, ["host", key], {
    cwd: at.worktree,
    encoding: "utf8",
    timeout: 90_000,
    env: { ...process.env, PATH: `${at.bin}:${process.env["PATH"] ?? ""}`, SQUIZ_TEST_ANSWERS: at.answers },
  });
  const logFile = join(at.worktree, ".squiz", key, "host.log");
  return {
    status: ran.status,
    stderr: ran.stderr,
    log: existsSync(logFile) ? readFileSync(logFile, "utf8") : "",
    seconds: (Date.now() - started) / 1_000,
  };
}

/** A process that runs until it is killed, and its identity as a lock file names it. */
function running(): { child: ChildProcess; lock: string } {
  const child = spawn("sleep", ["600"], { stdio: "ignore" });
  assert.ok(child.pid !== undefined, "sleep did not start");
  const read = identityOf(child.pid, 5_000);
  assert.equal(read.outcome, "read", "ps could not read the sleeping process");
  return { child, lock: `${JSON.stringify(read.outcome === "read" ? read.identity : {})}\n` };
}

test("#770: a round host removes the directory of each other pull request merged or closed, and leaves the rest", () => {
  const at = tree();
  try {
    const merged = episode(at, "38");
    const closed = episode(at, "39");
    const open = episode(at, "40");
    const unreadable = episode(at, "37");
    const local = join(at.worktree, ".squiz", "local");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "base.json"), "{}\n");
    answer(at, "38", '{"state":"MERGED"}');
    answer(at, "39", '{"state":"CLOSED"}');
    answer(at, "40", '{"state":"OPEN"}');
    answer(at, "37", "fail");
    // The host's own pull request is never asked about, so no answer is given for it.

    const ran = host(at);

    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(existsSync(merged), false, "a merged pull request's episode was kept");
    assert.equal(existsSync(closed), false, "a closed pull request's episode was kept");
    assert.equal(existsSync(open), true, "an open pull request's episode was removed");
    assert.equal(existsSync(unreadable), true, "an episode whose pull request could not be read was removed");
    assert.equal(existsSync(local), true, "the local venue's directory was removed");
    assert.equal(existsSync(join(at.worktree, ".squiz", "41")), true, "the host removed its own episode");
    assert.match(ran.log, new RegExp(`^\\S+ removed ${merged}: PR #38 is merged$`, "mu"));
    assert.match(ran.log, new RegExp(`^\\S+ removed ${closed}: PR #39 is closed$`, "mu"));
  } finally {
    rmSync(at.base, { recursive: true, force: true });
  }
});

test("#770: a merged pull request's episode is kept while its round host runs, and removed once it has gone", () => {
  const at = tree();
  const live = running();
  try {
    const merged = episode(at, "38");
    writeFileSync(join(merged, "host.lock"), live.lock);
    answer(at, "38", '{"state":"MERGED"}');

    assert.equal(host(at).status, 0);
    assert.equal(existsSync(join(merged, "state.json")), true, "the episode of a running host was removed");

    // Unreaped, it stays a zombie, which ps reports and squiz reads as gone.
    live.child.kill("SIGKILL");

    assert.equal(host(at).status, 0);
    assert.equal(existsSync(merged), false, "the episode was kept after its host had gone");
  } finally {
    live.child.kill("SIGKILL");
    rmSync(at.base, { recursive: true, force: true });
  }
});

test("#770: a pull request GitHub never answers for keeps its episode, and leaves time to remove a merged one's", () => {
  const at = tree();
  try {
    const hanging = episode(at, "38");
    const merged = episode(at, "39");
    answer(at, "38", "hang");
    answer(at, "39", '{"state":"MERGED"}');

    const ran = host(at);

    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(existsSync(hanging), true, "an episode whose pull request never answered was removed");
    assert.equal(existsSync(merged), false, "the merged pull request was never asked about");
  } finally {
    rmSync(at.base, { recursive: true, force: true });
  }
});

test("#770: pull requests GitHub never answers for keep the host to the sweep's bound", () => {
  const at = tree();
  try {
    const numbers = ["31", "32", "33", "34", "35", "36"];
    for (const number of numbers) {
      episode(at, number);
      answer(at, number, "hang");
    }

    const ran = host(at);

    assert.equal(ran.status, 0, ran.stderr);
    for (const number of numbers) assert.equal(existsSync(join(at.worktree, ".squiz", number)), true, `#${number}'s episode was removed`);
    // Under the 30 seconds six of the sweep's calls would take with no bound on them all together.
    assert.ok(ran.seconds < 27, `the host took ${ran.seconds}s, past the sweep's bound`);
  } finally {
    rmSync(at.base, { recursive: true, force: true });
  }
});
