/**
 * The handler driven the way `pi` drives it: one tool call at a time, in the
 * shape `pi` hands over, and the answer read as `pi` reads it.
 *
 * `pi` is not here, so the event is written out as `pi` emits it rather than
 * imported. The types are structural, which means a shape that drifted from
 * `pi`'s would compile and fail only in a round, so the calls below carry the
 * fields `pi` carries and nothing is narrowed to what the handler happens to
 * read.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { grants } from "./argv.ts";
import {
  refuse,
  type RefusedCommand,
  refusedCommands,
  refusedTools,
} from "./refusals.ts";

/** One tool call, in the shape `pi` emits it: the fields the handler never reads included. */
function called(toolName: string, input: unknown): { toolName: string; input: unknown } {
  return { type: "tool_call", toolCallId: "call_7", toolName, input } as unknown as {
    toolName: string;
    input: unknown;
  };
}

/** One shell call, which is the only tool whose arguments are read. */
function shell(command: string): { toolName: string; input: unknown } {
  return called("bash", { command, timeout: 120_000 });
}

/** What the reviewer is told in place of the call, which is the point of refusing it. */
function reasonFor(call: { toolName: string; input: unknown }): string {
  const refused = refuse(call);
  assert.ok(refused !== undefined, `the call was let through: ${JSON.stringify(call)}`);
  assert.equal(refused.block, true, "a refusal that does not block runs the tool anyway");
  return refused.reason;
}

/**
 * The commands the issue names, spelled here rather than read off the list.
 *
 * A test that took them from the list would pass against a list of typos, which
 * is the failure worth catching: a pattern matching nothing looks exactly like a
 * reviewer that ran no git.
 */
const wouldChangeTheCommit: readonly string[] = [
  "git commit -m 'fix the finding'",
  "git commit --amend --no-edit",
  "git reset --soft HEAD~1",
  "git checkout -B threads/last-said",
  "git update-ref refs/heads/main 9a3f1c4",
  "git push --force origin HEAD",
];

/** What a review does with a shell, none of which moves anything. */
const leavesTheCommitAlone: readonly string[] = [
  "npm test",
  "git status",
  "git status --porcelain",
  "git log --oneline -20",
  "git log -S lastSaid --oneline",
  "git show HEAD --stat",
  "git blame src/threads.ts",
  "git diff HEAD~1 HEAD",
  "git diff --stat origin/main...HEAD",
  "git -C \"\" status --porcelain",
  "rg --files-with-matches lastSaid",
];

/**
 * The reviewer reaching a listed mutation through options it would reach for
 * anyway.
 *
 * Each of these was run in a repository of its own: every one moved `HEAD` and
 * left the tree byte for byte as it was, which is the change this list exists to
 * stop.
 */
const REACHED_THROUGH_GIT_OPTIONS: readonly string[] = [
  "git -C . commit --allow-empty -m 'record review'",
  "git -c commit.gpgsign=false commit --allow-empty -m 'record review'",
  "git reset HEAD~1 --soft",
  "git --git-dir=.git commit -m x",
  "git --git-dir .git --work-tree . commit -m x",
  "git --namespace review commit -m x",
  "git -P push --force origin HEAD",
  "git --no-pager checkout -B threads/last-said",
  "GIT_AUTHOR_NAME=squiz git commit -m x",
  "/usr/bin/git commit -m x",
];

/**
 * A listed command written where a command is not run.
 *
 * Each of these reads and changes nothing. A reviewer told that its `grep` would
 * change the commit is a reviewer that cannot investigate the code it is
 * reviewing, and the refusal count says the same thing either way.
 */
const NAMES_A_COMMAND_WITHOUT_RUNNING_IT: readonly string[] = [
  "grep -n 'git commit' tracked.txt",
  "git log -S 'git commit' --oneline -- tracked.txt",
  "git log --grep 'git push' --oneline",
  "rg --fixed-strings 'git reset --soft' src",
  "echo 'git commit -m x' > /tmp/squiz/note.txt",
  "grep -rn 'git commit; git push' src",
  "grep -B2 -A2 'git commit' src",
  'grep -F "a \\"; git commit; \\" b" tracked.txt',
  "man git commit",
];

test("the tools a review has no use for are refused by name", () => {
  for (const tool of refusedTools) {
    const reason = reasonFor(called(tool, { path: "src/threads.ts", content: "anything" }));
    assert.match(reason, new RegExp(`\`${tool}\``, "u"), `the refusal of ${tool} does not name it`);
  }
});

/** The name is the whole of it: nothing is read out of what the call was given. */
test("a refused tool is refused whatever it was given, including nothing", () => {
  for (const tool of refusedTools) {
    assert.equal(refuse(called(tool, undefined))?.block, true);
    assert.equal(refuse(called(tool, {}))?.block, true);
  }
});

test("every command that would change the commit is refused", () => {
  for (const command of wouldChangeTheCommit) {
    const reason = reasonFor(shell(command));
    assert.match(
      reason,
      /changes what the coding agent commits/u,
      `${command} was refused for some other reason: ${reason}`,
    );
  }
});

/**
 * A list entry that can never match refuses nothing, and a reviewer that ran no
 * git also refuses nothing. Every entry matching itself is what tells them
 * apart.
 */
test("every entry on the list matches the command it is written as", () => {
  assert.notEqual(refusedCommands.length, 0, "an empty list refuses nothing and says nothing");
  for (const entry of refusedCommands) {
    const reason = reasonFor(shell(entry.named));
    assert.ok(
      reason.includes(`\`${entry.named}\``),
      `\`${entry.named}\` was refused as something else: ${reason}`,
    );
  }
});

test("the shell a review actually needs is left alone", () => {
  for (const command of leavesTheCommitAlone) {
    assert.equal(
      refuse(shell(command)),
      undefined,
      `${command} was refused, and a reviewer that cannot run it cannot verify a finding`,
    );
  }
});

/**
 * A command that carries `git`'s own options before the subcommand is the same
 * command. A reviewer not trying to get around the list reaches these by typing
 * git the way git is typed.
 */
test("git's own options do not hide the subcommand behind them", () => {
  for (const command of REACHED_THROUGH_GIT_OPTIONS) {
    const reason = reasonFor(shell(command));
    assert.match(
      reason,
      /changes what the coding agent commits/u,
      `${command} was refused for some other reason: ${reason}`,
    );
  }
});

/**
 * `git -C ""` changes no directory and runs the subcommand after it, and the
 * reviewer's commit went through in a repository of its own.
 *
 * An empty argument dropped from the split leaves `-C` taking the subcommand as
 * its value, and the commit is never read.
 */
test("an empty option value does not stand in for the subcommand", () => {
  assert.equal(refuse(shell('git -C "" commit --allow-empty -m x'))?.block, true);
  assert.equal(refuse(shell("git -C '' push --force origin HEAD"))?.block, true);
});

/**
 * `-B` takes a value, and git reads it written onto the flag as readily as
 * written after it. The reviewer's `-Breview-copy` moved `HEAD` and left the
 * tree as it was.
 */
test("a short option's value written onto the flag is still the flag", () => {
  assert.equal(refuse(shell("git checkout -Breview-copy HEAD~1"))?.block, true);
  assert.equal(refuse(shell("git checkout -B review-copy HEAD~1"))?.block, true);
});

/** A flag taking no value is the whole word, so a longer word is some other flag. */
test("a flag is not matched as the opening of a longer word", () => {
  assert.equal(refuse(shell("git reset --softly HEAD~1")), undefined);
  assert.equal(refuse(shell("git reset --soft-landing HEAD~1")), undefined);
  assert.equal(refuse(shell("git checkout -b review-copy")), undefined);
});

/**
 * The quoting of one argument decides where the next command starts. A closing
 * quote read where an escaped one was written either takes the command after it
 * into the argument or lets the text inside it out as a command.
 */
test("an escaped quote moves no command across the boundary, in either direction", () => {
  assert.equal(
    refuse(shell('grep -F "a \\"; git commit; \\" b" tracked.txt')),
    undefined,
    "the commit is inside the pattern, and a reviewer refused this cannot search the tree",
  );
  assert.equal(
    refuse(shell("printf '%s\\n' \"a \\\" b\"; git commit --allow-empty -m x"))?.block,
    true,
  );
});

/**
 * A comment is not the text of a command, in either direction.
 *
 * The apostrophe in the first of these opened a quote that absorbed the line
 * after it, and a plain `git commit` ran: `HEAD` moved and the tree stayed as it
 * was. The `;` in the second invented a commit the shell never runs, and an
 * ordinary `git status` was refused for it.
 */
test("a command is refused after a comment, and a comment refuses nothing of its own", () => {
  assert.equal(
    refuse(shell("# Record the reviewer's result\ngit commit --allow-empty -m review"))?.block,
    true,
  );
  assert.equal(
    refuse(shell("git status --porcelain # example: git status; git commit -m x")),
    undefined,
    "the commit is inside a comment, and a reviewer refused this cannot read the tree",
  );
  assert.equal(
    refuse(shell("echo '# not a comment' && git commit -m x"))?.block,
    true,
    "a quoted `#` opens no comment, and the commit after it is a command",
  );
});

/** `--soft` is what makes the reset invisible, and git takes it in any position. */
test("the reset that leaves the tree alone is refused wherever --soft sits", () => {
  assert.equal(refuse(shell("git reset --soft HEAD~1"))?.block, true);
  assert.equal(refuse(shell("git reset HEAD~1 --soft"))?.block, true);
  assert.equal(refuse(shell("git -C /tmp/worktree reset HEAD~2 --soft"))?.block, true);
});

test("a listed command written inside an argument is an argument, not a command", () => {
  for (const command of NAMES_A_COMMAND_WITHOUT_RUNNING_IT) {
    assert.equal(
      refuse(shell(command)),
      undefined,
      `${command} runs nothing on the list, and a reviewer refused it cannot read the history`,
    );
  }
});

test("the tools the read grant carries are left alone", () => {
  for (const tool of grants.read) {
    assert.equal(refuse(called(tool, { path: "src/threads.ts" })), undefined);
  }
});

test("a refused command is refused wherever it sits in the line", () => {
  assert.equal(refuse(shell("cd /tmp/worktree && git push origin HEAD"))?.block, true);
  assert.equal(refuse(shell("git add --all; git commit -m x"))?.block, true);
});

/** `git   commit` and `git commit` are the same command, and so is one on a line of its own. */
test("a refused command is refused however it is spaced", () => {
  assert.equal(refuse(shell("git   commit -m x"))?.block, true);
  assert.equal(refuse(shell("cd /tmp/worktree\ngit commit -m x"))?.block, true);
});

/**
 * `pi` owns the field the command arrives in. One it renames would otherwise
 * leave every command matching nothing, which reads exactly like a reviewer that
 * ran no git.
 */
test("a shell call whose command cannot be read is refused rather than run", () => {
  for (const input of [undefined, {}, { cmd: "npm test" }, { command: 42 }, "npm test"]) {
    const reason = reasonFor(called("bash", input));
    assert.match(
      reason,
      /could not be read/u,
      `${JSON.stringify(input)} was refused for some other reason: ${reason}`,
    );
  }
});

/**
 * The limit, asserted rather than only described.
 *
 * A word the shell would build out of quoting or substitution is left alone
 * rather than guessed at, so this evasion runs. Refusing it would take a shell,
 * which is an arms race this does not enter — the tools needing no matching go
 * by name, and the list only has to cover the commands that move `HEAD` without
 * touching the tree.
 */
test("splitting into words refuses a reviewer not trying to get around it, and no more", () => {
  assert.equal(refuse(shell('git "com"mit -m x')), undefined);
  assert.equal(refuse(shell("git $(echo commit) -m x")), undefined);
});

test("the reason tells the reviewer what to do instead", () => {
  assert.match(reasonFor(shell("git commit -m x")), /Report what is wrong with the change/u);
  assert.match(reasonFor(called("write", {})), /Report what is wrong with the change/u);
});

/**
 * `pi` treats a handler that throws as one that blocked, so a throw here refuses
 * a call this meant to allow. Every path answers instead.
 */
test("the handler answers rather than throwing, whatever the call carries", () => {
  const hostile: readonly unknown[] = [
    { toolName: "bash", input: null },
    { toolName: "bash", input: [] },
    { toolName: "bash", input: { command: { toString: () => "git commit" } } },
    { toolName: "", input: undefined },
    { toolName: "read", input: Object.create(null) as unknown },
  ];
  for (const call of hostile) {
    assert.doesNotThrow(() => refuse(call as { toolName: string; input: unknown }));
  }
});

/** The lists hold against a caller that would add to them at runtime. */
test("neither list can be added to", () => {
  assert.throws(() => (refusedTools as string[]).push("read"));
  assert.throws(() =>
    (refusedCommands as RefusedCommand[]).push({ named: "git status", subcommand: "status" }),
  );
});
