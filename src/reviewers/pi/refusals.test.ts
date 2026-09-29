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
import { refuse, refusedCommands, refusedTools, wasRefused } from "./refusals.ts";

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
  "git status --porcelain",
  "git log -S lastSaid --oneline",
  "git blame src/threads.ts",
  "git diff HEAD~1 HEAD",
  "rg --files-with-matches lastSaid",
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
    assert.equal(refuse(shell(entry))?.block, true, `\`${entry}\` matches nothing, not even itself`);
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
 * A command is matched as text, and text is not a boundary: this evasion runs.
 * Refusing it would take escalating the matching, which is an arms race this
 * does not enter — the tools needing no matching go by name, and the list only
 * has to cover the commands that move `HEAD` without touching the tree.
 */
test("matching as text refuses a reviewer that is not trying to get around it, and no more", () => {
  assert.equal(refuse(shell('git "com"mit -m x')), undefined);
  assert.equal(refuse(shell("git $(echo commit) -m x")), undefined);
});

test("the reason tells the reviewer what to do instead", () => {
  assert.match(reasonFor(shell("git commit -m x")), /Report what is wrong with the change/u);
  assert.match(reasonFor(called("write", {})), /Report what is wrong with the change/u);
});

/**
 * The round counts a refusal off the stream, and `pi` answers a blocked call
 * with the reason as the result's only text.
 */
test("a refusal is recognised in the result pi answers the blocked call with", () => {
  const reason = reasonFor(shell("git commit -m x"));
  assert.equal(wasRefused({ content: [{ type: "text", text: reason }], details: {} }), true);
});

/** A tool that ran and failed is an error too, and it is not a refusal. */
test("a tool that failed on its own is not counted as a refusal", () => {
  const results: readonly unknown[] = [
    { content: [{ type: "text", text: "src/threads.ts: No such file or directory" }] },
    { content: [{ type: "text", text: "the finding is scoped to a line and carries no file" }] },
    { content: [] },
    { content: "not a list of blocks" },
    undefined,
  ];
  for (const result of results) {
    assert.equal(wasRefused(result), false, `${JSON.stringify(result)} was counted as a refusal`);
  }
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
  assert.throws(() => (refusedCommands as string[]).push("git status"));
});
