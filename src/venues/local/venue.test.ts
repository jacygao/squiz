import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test, type TestContext } from "node:test";

import { ownerNote } from "../../host/owner-note.ts";
import type { Owner, StateRecord } from "../../loop/state-record.ts";
import { composeReview, type ReviewResult } from "../../review/output.ts";
import { deadlineIn } from "../../reviewers/deadline.ts";
import type { Change } from "../venue.ts";
import { localVenue } from "./venue.ts";

const REFUSAL = "the local venue reviews the working tree, and takes no pull request number";

function git(directory: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A repository with one commit and no remote, at `name`, removed when the test ends. */
function worktreeIn(t: TestContext, name = "squiz's work"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "squiz-local-venue-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worktree = join(root, name);
  mkdirSync(worktree);
  git(worktree, ["init", "--quiet", "--initial-branch", "main"]);
  writeFileSync(join(worktree, "kept.txt"), "kept\n");
  git(worktree, ["add", "--all"]);
  git(worktree, ["-c", "user.email=squiz@example.invalid", "-c", "user.name=Squiz", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "start"]);
  mkdirSync(join(worktree, "sub"));
  return worktree;
}

function changeIn(worktree: string): Change {
  const read = localVenue.readChange(join(worktree, "sub"), null, deadlineIn(30_000));
  assert.equal(read.outcome, "found", "reason" in read ? read.reason : "");
  if (read.outcome !== "found") throw new Error("unreachable");
  return read.change;
}

test("a start from a subdirectory records the base at the worktree's root", (t) => {
  const worktree = worktreeIn(t);
  const start = git(worktree, ["rev-parse", "HEAD"]);

  assert.deepEqual(localVenue.recordStart(join(worktree, "sub"), deadlineIn(30_000)), { outcome: "done" });

  const recorded = JSON.parse(readFileSync(join(worktree, ".squiz", "local", "base.json"), "utf8")) as { commit: string };
  assert.equal(recorded.commit, start);
});

test("a start outside any git worktree records nothing, and says why", (t) => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "squiz-local-outside-")));
  t.after(() => rmSync(outside, { recursive: true, force: true }));

  const started = localVenue.recordStart(outside, deadlineIn(30_000));

  assert.equal(started.outcome, "failed");
  assert.equal(existsSync(join(outside, ".squiz")), false);
});

test("the episode is .squiz/local/ for the key local, and none for a pull request's number", () => {
  assert.deepEqual(localVenue.episodeDirectory("/work/squiz-a", "local"), {
    outcome: "found",
    directory: "/work/squiz-a/.squiz/local",
  });
  assert.deepEqual(localVenue.episodeDirectory("/work/squiz-a", "41"), { outcome: "failed", reason: REFUSAL });
});

test("a pull request's number reads no change, with the line squiz review refuses one with", (t) => {
  const worktree = worktreeIn(t);
  localVenue.recordStart(worktree, deadlineIn(30_000));

  assert.deepEqual(localVenue.readChange(worktree, "41", deadlineIn(30_000)), { outcome: "none", reason: REFUSAL });
});

test("a worktree no start was recorded in reads no change, naming its root", (t) => {
  const worktree = worktreeIn(t);

  assert.deepEqual(localVenue.readChange(join(worktree, "sub"), null, deadlineIn(30_000)), {
    outcome: "none",
    reason: `${worktree} has no recorded base, which squiz records when a session or subagent starts there`,
  });
});

test("the change is the working tree against its base, named for the worktree, and asks for no commit or push", (t) => {
  const worktree = worktreeIn(t);
  const start = git(worktree, ["rev-parse", "HEAD"]);
  localVenue.recordStart(worktree, deadlineIn(30_000));
  writeFileSync(join(worktree, "kept.txt"), "changed\n");
  writeFileSync(join(worktree, ".squiz", "local", "description.md"), "Make the queue retry.\n");

  const change = changeIn(worktree);

  const quoted = `'${worktree.replaceAll("'", `'\\''`)}'`;
  assert.equal(change.key, "local");
  assert.equal(change.name, "the working tree");
  assert.equal(change.rerun, `(cd ${quoted} && squiz review)`);
  assert.equal(change.summaryAt, `in ${join(worktree, ".squiz", "local", "summary.md")}`);
  assert.equal(
    change.followUp,
    [
      `Fix what applies in ${worktree}, and reply on each thread with`,
      `\`(cd ${quoted} && squiz reply <id> <text>)\` to say what you changed or why`,
      `you disagree. Then run \`(cd ${quoted} && squiz review)\` again.`,
    ].join("\n"),
  );
  assert.doesNotMatch(change.followUp, /commit|push/iu);
  assert.equal(change.base, start);
  assert.notEqual(change.head, start);
  assert.equal(change.description, "Make the queue retry.\n");
});

/** Every command in `text`, as the backquoted spans it gives them in. */
function commandsIn(text: string): readonly string[] {
  return [...text.matchAll(/`([^`]+)`/gu)].map((match) => match[1] ?? "");
}

test("#826: every command the change gives runs squiz in the worktree, and leaves the caller's shell where it was, under sh and bash", (t) => {
  const worktree = worktreeIn(t, "squiz's $HOME work");
  localVenue.recordStart(worktree, deadlineIn(30_000));
  const change = changeIn(worktree);
  const caller = realpathSync(mkdtempSync(join(tmpdir(), "squiz-local-caller-")));
  t.after(() => rmSync(caller, { recursive: true, force: true }));
  const bin = join(caller, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "squiz"), `#!/bin/sh\necho "squiz ran in $(pwd -P)"\n`, { mode: 0o755 });

  const commands = [change.rerun, ...commandsIn(change.followUp)];
  assert.equal(commands.length, 3, `the follow-up does not give its two commands:\n${change.followUp}`);
  for (const shell of ["/bin/sh", "bash"]) {
    for (const command of commands) {
      const runnable = command.replace("<id> <text>", "T1 fixed");
      const ran = spawnSync(shell, ["-c", `${runnable}\necho "caller is in $(pwd -P)"`], {
        cwd: caller,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
      });
      assert.equal(ran.status, 0, `${shell} could not run ${command}: ${ran.stderr}`);
      assert.equal(
        ran.stdout,
        `squiz ran in ${worktree}\ncaller is in ${caller}\n`,
        `under ${shell}, ${command} did not run squiz in the worktree and leave the caller where it was`,
      );
    }
  }
});

test("#826: no note or review output for a local change gives a cd outside a subshell", (t) => {
  const worktree = worktreeIn(t);
  localVenue.recordStart(worktree, deadlineIn(30_000));
  const change = changeIn(worktree);
  const until = deadlineIn(30_000);
  localVenue.openThread(change, { path: "kept.txt", line: 1, side: "RIGHT" }, "**Squiz reviewer · high — A**", until);
  const listed = localVenue.listThreads(change, until);
  const threads = listed.outcome === "listed" ? listed.threads : [];
  assert.equal(threads.length, 1);

  const owner: Owner = { sessionId: "60517e1f-e1dc-49b1-8e39-6fcbe686f3fb" };
  const round = { number: 1, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" } } as const;
  const reviewed = (exitStatus: 2 | 3, openThreads: readonly string[]): StateRecord => ({
    head: change.head, activity: null, owner, status: "reviewed", result: "exited", exitStatus, openThreads, round, newFindings: openThreads.length,
  });
  const records: readonly StateRecord[] = [
    reviewed(2, ["T1"]),
    reviewed(3, ["T1"]),
    reviewed(3, []),
    { head: change.head, activity: null, owner, status: "failed", reason: "the reviewer stopped", ownerNoted: false },
  ];
  const notes = records.map((record) => ownerNote(change, record, "3f9c2e0", change.followUp, undefined, threads)?.fields["text"] ?? "");

  const named = { key: change.key, name: change.name, rerun: change.rerun, summaryAt: change.summaryAt } as const;
  const results: readonly ReviewResult[] = [
    { ...named, outcome: "reviewed", exit: 2, commit: "8d21a4f", round: 1, cap: 3, newFindings: 1, threads, recorded: false, followUp: change.followUp },
    { ...named, outcome: "reviewed", exit: 3, closedAt: "round cap", commit: "8d21a4f", round: 3, cap: 3, newFindings: 0, threads, recorded: false },
    { ...named, outcome: "reviewing", wait: "under review", commit: "3f9c2e0" },
    { ...named, outcome: "closed unreviewed", exit: 3, state: "3f9c2e0", reason: "the episode closed at the round cap before a round took this state", closedAt: "round cap", threads, summarised: false },
  ];
  const outputs = results.map((result) => {
    const printed = composeReview(result, join(worktree, ".squiz", "local", "review.txt"));
    return printed.stdout + printed.stderr;
  });

  const all = [...notes, ...outputs];
  assert.ok(all.join("\n").includes(`${change.rerun}\``), "no output gives the change's rerun, so none was checked");
  assert.ok(all.join("\n").includes("&& squiz reply <id> <text>)`"), "no output gives the reply command, so none was checked");
  for (const text of all) {
    assert.doesNotMatch(text, /(?<!\()cd '/u, `this output gives a cd that would move the caller's shell:\n${text}`);
  }
});

test("two reads of an unchanged working tree are one head, and an edit is another", (t) => {
  const worktree = worktreeIn(t);
  localVenue.recordStart(worktree, deadlineIn(30_000));
  writeFileSync(join(worktree, "kept.txt"), "changed\n");

  const first = changeIn(worktree);
  const second = changeIn(worktree);
  writeFileSync(join(worktree, "kept.txt"), "changed again\n");
  const third = changeIn(worktree);

  assert.equal(second.head, first.head, "an unchanged tree was a new state, and would be reviewed again");
  assert.notEqual(third.head, first.head);
  assert.equal(first.description, "");
});

test("provideCommits hands the snapshot the venue's objects, by an absolute path", (t) => {
  const worktree = worktreeIn(t);
  localVenue.recordStart(worktree, deadlineIn(30_000));
  const change = changeIn(worktree);

  const provided = localVenue.provideCommits(change, deadlineIn(30_000));

  assert.deepEqual(provided, { outcome: "ready", alternates: [join(worktree, ".squiz", "local", "objects")] });
  assert.ok(isAbsolute(provided.outcome === "ready" ? (provided.alternates[0] ?? "") : ""));
});

test("threads opened on the change are listed from threads.json, replied to, resolved and re-opened", (t) => {
  const worktree = worktreeIn(t);
  localVenue.recordStart(worktree, deadlineIn(30_000));
  const change = changeIn(worktree);
  const until = deadlineIn(30_000);

  const line = localVenue.openThread(change, { path: "kept.txt", line: 1, side: "RIGHT" }, "**Squiz reviewer · high — A**", until);
  const file = localVenue.openFileThread(change, "kept.txt", "**Squiz reviewer · low — B**", until);
  assert.equal(line.outcome, "posted");
  assert.equal(file.outcome, "posted");
  assert.deepEqual(
    [line, file].map((posted) => (posted.outcome === "posted" ? [posted.threadId, posted.commentId] : [])),
    [
      ["T1", "C1"],
      ["T2", "C2"],
    ],
  );

  const previous = process.cwd();
  process.chdir(join(worktree, "sub"));
  try {
    assert.deepEqual(localVenue.reply("T1", "**Squiz coding agent**\n\nFixed.", until), { outcome: "acted" });
    assert.deepEqual(localVenue.resolve("T2", until), { outcome: "acted" });
    assert.deepEqual(localVenue.reopen("T2", until), { outcome: "acted" });
    assert.equal(localVenue.reply("T9", "**Squiz coding agent**\n\nNo.", until).outcome, "failed");
  } finally {
    process.chdir(previous);
  }

  const listed = localVenue.listThreads(change, until);
  assert.equal(listed.outcome, "listed");
  const threads = listed.outcome === "listed" ? listed.threads : [];
  assert.deepEqual(
    threads.map((thread) => [thread.id, thread.path, thread.isResolved, thread.comments.map((comment) => comment.id)]),
    [
      ["T1", "kept.txt", false, ["C1", "C3"]],
      ["T2", "kept.txt", false, ["C2"]],
    ],
  );
});

test("the summary and each failure are files in .squiz/local/", (t) => {
  const worktree = worktreeIn(t);
  localVenue.recordStart(worktree, deadlineIn(30_000));
  const change = changeIn(worktree);
  const local = join(worktree, ".squiz", "local");

  assert.deepEqual(localVenue.postSummary(change, "the summary", deadlineIn(30_000)), { outcome: "posted" });
  assert.deepEqual(localVenue.postFailure(change, "one failure", deadlineIn(30_000)), { outcome: "posted" });
  assert.deepEqual(localVenue.postFailure(change, "another", deadlineIn(30_000)), { outcome: "posted" });

  assert.equal(readFileSync(join(local, "summary.md"), "utf8"), "the summary");
  assert.equal(readFileSync(join(local, "failure-1.md"), "utf8"), "one failure");
  assert.equal(readFileSync(join(local, "failure-2.md"), "utf8"), "another");
  assert.equal(git(worktree, ["status", "--porcelain", "--untracked-files=all"]), "");
});

test("a call whose deadline has passed is not made, and fails", (t) => {
  const worktree = worktreeIn(t);
  localVenue.recordStart(worktree, deadlineIn(30_000));
  const change = changeIn(worktree);
  const gone = deadlineIn(0);

  assert.equal(localVenue.listThreads(change, gone).outcome, "failed");
  assert.equal(localVenue.provideCommits(change, gone).outcome, "failed");
  assert.equal(localVenue.readChange(worktree, null, gone).outcome, "failed");
  assert.equal(localVenue.recordStart(worktree, gone).outcome, "failed");
});
