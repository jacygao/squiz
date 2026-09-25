/**
 * The reviewer driven end to end over a repository with a defect put there on
 * purpose: the prompt, the command line, the process, the tree it runs in, and
 * the parse of what it wrote back.
 *
 * **The reviewer here is a script rather than a model.** This runs with no
 * provider credential and no network, and a live model would not agree with
 * itself twice besides. The capture of a real run cannot stand in for one
 * either: its last message is prose, so there are no findings in it to read. So
 * the stand-in is an executable named `pi` that consumes the command line the
 * adapter builds, reads the seeded file out of the tree it was pointed at, and
 * answers in the stream shape `pi` emits.
 *
 * What that establishes is the composition. The prompt reaches the reviewer, the
 * command line runs, the working directory is the tree handed over, the scratch
 * space holds what the reviewer writes, the tree is as it was afterwards, and
 * the findings come back in the contract's shape anchored to a real line of a
 * real file. It does not establish that a model finds the defect, which takes a
 * credential and a live run.
 *
 * The stand-in refuses instead of answering wherever one of the four things it
 * is handed is missing, so a round that comes back as a review is itself the
 * evidence that all four arrived.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { LineFinding } from "../findings/finding.ts";
import type { PullRequest } from "../github/pull-request.ts";
import type { ReviewThread } from "../github/threads.ts";
import type { Invocation, RoundCost, ThreadVerdict } from "./adapter.ts";
import { pi } from "./pi/adapter.ts";
import { composePrompt } from "./prompt.ts";
import { runRound } from "./round.ts";

/** The file under review, as the host project spells it. */
const reviewedFile = "src/threads.ts";

/**
 * The seeded defect, which the change under review adds.
 *
 * `comments[comments.length]` is one past the last index, so `lastSaid` answers
 * undefined for every thread ever passed to it. A reviewer that misses it has
 * passed over a function that never once does what its name and its own
 * documentation say, on a line the change added.
 */
const defect = "  return thread.comments[thread.comments.length];";

/** The comparison an earlier round's finding asked for, which the verdict reads. */
const fixedComparison = "  return thread.comments.length > 1;";

const baseModule = `/** The comments on one review thread, oldest first. */
export type Thread = {
  readonly id: string;
  readonly comments: readonly string[];
};

/** Whether anyone has replied since the finding was posted. */
export function hasReplied(thread: Thread): boolean {
${fixedComparison}
}
`;

const headModule = `${baseModule}
/** The last thing said on the thread, or undefined where nothing has been said. */
export function lastSaid(thread: Thread): string | undefined {
${defect}
}
`;

const baseTest = `import assert from "node:assert/strict";
import { test } from "node:test";

import { hasReplied } from "./threads.ts";

test("a thread carrying only the finding has had no reply", () => {
  assert.equal(hasReplied({ id: "t1", comments: ["the finding"] }), false);
});
`;

/**
 * The test the change adds is green with the defect in place: an empty thread is
 * the one input an index past the end answers correctly. The suite says nothing
 * is wrong, so the reviewer is the only thing between the defect and the commit.
 */
const headTest = `import assert from "node:assert/strict";
import { test } from "node:test";

import { hasReplied, lastSaid } from "./threads.ts";

test("a thread carrying only the finding has had no reply", () => {
  assert.equal(hasReplied({ id: "t1", comments: ["the finding"] }), false);
});

test("a thread nobody has said anything on has no last comment", () => {
  assert.equal(lastSaid({ id: "t1", comments: [] }), undefined);
});
`;

/** `.squiz/` is ignored, which is the first thing adopting the harness asks for. */
const gitignore = ".squiz/\nnode_modules/\n";

type Tree = Readonly<Record<string, string>>;

/** The host project as the pull request's base has it. */
const base: Tree = {
  ".gitignore": gitignore,
  [reviewedFile]: baseModule,
  "src/threads.test.ts": baseTest,
};

/** The host project as its head has it, the defect among what the change added. */
const head: Tree = {
  ...base,
  [reviewedFile]: headModule,
  "src/threads.test.ts": headTest,
};

/** Where the defect sits in the file the reviewer reads, counting from 1. */
const defectLine = headModule.split("\n").indexOf(defect) + 1;

/** The scratch space and the session directory, named as the harness names them. */
const scratchDirectory = ".squiz/agent-104/scratch";
const sessionDirectory = ".squiz/agent-104/session";

/** The charter that ships, handed over as the file the reviewer's CLI appends. */
const charterFile = fileURLToPath(new URL("../../charter.md", import.meta.url));

const pullRequest: PullRequest = {
  number: 142,
  nodeId: "PR_kwDOFixture",
  baseRef: "main",
  headRef: "threads/last-said",
  headSha: "9a3f1c4e5b6d7a8f9012345678abcdef01234567",
  description: "Add `lastSaid`, so the summary can quote the end of a thread.",
};

/** A thread an earlier round opened, which the reviewer is asked to rule on. */
const thread: ReviewThread = {
  id: "PRRT_kwDOFixture1",
  isResolved: false,
  isOutdated: false,
  path: reviewedFile,
  anchor: { at: "line", line: 8 },
  comments: [
    {
      databaseId: 11,
      author: "squiz",
      body: "`hasReplied` counted the finding itself as a reply.",
    },
    { databaseId: 12, author: "coding-agent", body: "Now compares against 1 rather than 0." },
  ],
};

/** The prose of the finding the stand-in reports, which it does not work out. */
const findingBody: Omit<LineFinding, "scope" | "file" | "line"> = {
  severity: "high",
  headline: "`lastSaid` indexes one past the last comment, so it always answers undefined",
  reasoning: [
    "`thread.comments[thread.comments.length]` is one past the last index, which is undefined for every thread.",
    "The test the change adds beside it covers only the empty thread, where undefined is the right answer, so the suite stays green.",
  ],
  suggestedFix: "Index `thread.comments.length - 1`.",
  reference: "`lastSaid` is documented to return the last thing said on the thread.",
};

/** The finding as the contract shapes it, anchored to the line in the tree. */
const expectedFinding: LineFinding = {
  scope: "line",
  file: reviewedFile,
  line: defectLine,
  ...findingBody,
};

/** The earlier finding's defect is gone, so the ruling on its thread is `fixed`. */
const expectedVerdicts: readonly ThreadVerdict[] = [{ thread: thread.id, verdict: "fixed" }];

/** What the two assistant messages of the stand-in's stream report between them. */
const expectedCost: RoundCost = { dollars: 0.002, tokens: 2_400, messages: 2 };

/**
 * Long enough that nothing here rests on how fast the machine is, and short
 * enough that a stand-in which hangs is still a test that ends.
 */
const BOUND_SECONDS = 60;

test("the adapter returns the seeded defect as a finding in the contract's shape", async () => {
  await inTheFixture(async ({ tree, diff }) => {
    assert.equal(
      headModule.split("\n")[defectLine - 1],
      defect,
      "the fixture must put the seeded defect where the finding is expected to anchor",
    );

    assert.ok(diff.includes(defect), "the defect must be on a line the change under review added");

    const round = await runRound(pi, invocationIn(tree), BOUND_SECONDS);
    assert.ok(round.outcome === "reviewed", accountOf(round));
    assert.deepEqual(round.findings, [expectedFinding]);
    assert.deepEqual(round.verdicts, expectedVerdicts);
    assert.deepEqual(round.cost, expectedCost);
  });
});

/**
 * What the reviewer was handed, read back off the note the stand-in left in its
 * scratch space. A round that reviewed says every input arrived; this says what
 * each one was.
 */
test("the prompt, the read grant, the charter and the tree all reach the reviewer", async () => {
  await inTheFixture(async ({ tree }) => {
    const round = await runRound(pi, invocationIn(tree), BOUND_SECONDS);
    assert.equal(round.outcome, "reviewed", accountOf(round));

    const handed = handedTo(tree);
    assert.equal(handed["cwd"], realpathSync(tree));
    assert.equal(handed["tools"], pi.grants.read.join(","));
    assert.equal(handed["charterFile"], charterFile);
    assert.equal(handed["charterOpens"], readFileSync(charterFile, "utf8").split("\n")[0]);
    assert.equal(handed["sessionDirectory"], sessionDirectory);
    assert.equal(handed["heading"], `# Review pull request #${pullRequest.number}`);
    assert.equal(handed["thread"], thread.id);
  });
});

/**
 * At depth `read` the tool grant is the only thing keeping the reviewer off the
 * code under review, and the comparison of tracked files that would detect a
 * write is not built. So this assertion is what stands in for it, and it is
 * checked to have teeth in the same test: a tree that is dirty must read as
 * dirty here, or a clean answer means nothing.
 */
test("the round leaves the fixture tree as it found it", async () => {
  await inTheFixture(async ({ tree }) => {
    assert.equal(git(["status", "--porcelain"], tree), "", "the fixture starts clean");

    const round = await runRound(pi, invocationIn(tree), BOUND_SECONDS);
    assert.equal(round.outcome, "reviewed", accountOf(round));
    assert.equal(
      git(["status", "--porcelain"], tree),
      "",
      "the reviewer changed the tree the coding agent is about to commit",
    );

    // The scratch space is inside the tree and ignored, so what the reviewer
    // wrote is there and `git status` is still silent about it.
    assert.ok(
      existsSync(join(tree, scratchDirectory, "handed.json")),
      "the reviewer wrote nothing to its scratch space, so nothing here was confined",
    );

    writeFileSync(join(tree, "src/left-behind.ts"), "export const dirt = 1;\n");
    assert.notEqual(
      git(["status", "--porcelain"], tree),
      "",
      "a file left in the tree must show here, or a clean answer above proves nothing",
    );
  });
});

/** The invocation for one round over the fixture, at the depth the harness sets. */
function invocationIn(tree: string): Invocation {
  return {
    directory: tree,
    charterFile,
    prompt: composePrompt({ pullRequest, diff: diffOf(tree), threads: [thread] }),
    sessionDirectory,
    scratchDirectory,
    depth: "read",
  };
}

/** The note the stand-in left, read as the fields it wrote. */
function handedTo(tree: string): Readonly<Record<string, unknown>> {
  const left = join(tree, scratchDirectory, "handed.json");
  const note: unknown = JSON.parse(readFileSync(left, "utf8"));
  assert.ok(typeof note === "object" && note !== null, "the reviewer left no note of its inputs");
  return note as Readonly<Record<string, unknown>>;
}

/** What a failed round said for itself, so a refusal is read rather than guessed. */
function accountOf(round: { readonly outcome: string }): string {
  return `the round came back as ${JSON.stringify(round)}`;
}

/** The fixture repository, and the diff of the change under review in it. */
type Fixture = {
  readonly tree: string;
  readonly diff: string;
};

/**
 * A fixture repository with the change under review committed on top of its
 * base, and the stand-in on `PATH` as `pi`.
 *
 * It is a git repository made here rather than one committed inside this one: a
 * nested `.git` breaks the outer repository in ways that surface far from here.
 *
 * The tree and the stand-in are siblings under a directory of their own, so
 * nothing this test writes for itself lands where a write by the reviewer would
 * be looked for.
 */
async function inTheFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const under = mkdtempSync(join(tmpdir(), "squiz-fixture-"));
  const tree = join(under, "tree");
  const wasOnPath = process.env["PATH"] ?? "";
  try {
    mkdirSync(tree);
    write(tree, base);
    git(["init", "--quiet"], tree);
    commit(tree, "Read a thread's comments");
    write(tree, head);
    commit(tree, "Add lastSaid");

    process.env["PATH"] = `${standIn(under)}${delimiter}${wasOnPath}`;
    await run({ tree, diff: diffOf(tree) });
  } finally {
    process.env["PATH"] = wasOnPath;
    rmSync(under, { recursive: true, force: true });
  }
}

/** The diff of the change under review, which is git's own output for it. */
function diffOf(tree: string): string {
  return git(["diff", "HEAD~1", "HEAD"], tree);
}

function write(tree: string, files: Tree): void {
  for (const [path, content] of Object.entries(files)) {
    const whole = join(tree, path);
    mkdirSync(dirname(whole), { recursive: true });
    writeFileSync(whole, content);
  }
}

function commit(tree: string, message: string): void {
  git(["add", "--all"], tree);
  git(["commit", "--quiet", "--message", message], tree);
}

/**
 * One git command in the fixture, with the machine's own configuration shut out.
 *
 * An identity and a branch name are passed rather than read, so the fixture is
 * the same repository wherever it is made and whatever the person running it has
 * configured.
 */
function git(args: readonly string[], tree: string): string {
  return execFileSync(
    "git",
    [
      "-c",
      "init.defaultBranch=main",
      "-c",
      "init.templateDir=",
      "-c",
      "user.name=squiz fixture",
      "-c",
      "user.email=fixture@squiz.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd: tree,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    },
  );
}

/**
 * The stand-in written as an executable named `pi`, and the directory to put at
 * the front of `PATH` so that the command line the adapter builds finds it.
 *
 * A shell shim rather than the script itself, because an extensionless file's
 * module system is whatever the directory it happens to sit in says it is.
 */
function standIn(under: string): string {
  const bin = join(under, "bin");
  mkdirSync(bin);
  const script = join(bin, "reviewer.cjs");
  writeFileSync(script, reviewer);
  const shim = join(bin, "pi");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(shim, 0o755);
  return bin;
}

/** One assistant message as `pi` reports it, priced at half a round. */
function message(stopReason: string, content: readonly unknown[]): unknown {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      model: "stand-in",
      stopReason,
      content,
      usage: {
        input: 1_000,
        output: 200,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1_200,
        cost: { input: 0.0008, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.001 },
      },
    },
  };
}

/** The message that reached for the file, which carries no text and no findings. */
const reaching = message("toolUse", [{ type: "toolCall", toolName: "read" }]);

/**
 * The message the findings are read out of, whose text the stand-in fills in.
 *
 * The thinking block before it is what a real message carries and nothing reads:
 * the findings are the message's text, and a reader that took its thinking too
 * would read the reviewer's working out as part of its answer.
 */
const answering = message("stop", [
  { type: "thinking", thinking: "reading the file" },
  { type: "text", text: "" },
]);

/**
 * The stand-in for `pi`: it consumes the command line the adapter builds, reads
 * the tree it was pointed at, and answers in the stream shape `pi` emits.
 *
 * It refuses rather than answering wherever an input is missing, so nothing it
 * was not handed can be read out of a round that reviewed. What it reports as
 * the defect's file and line it takes from the file it read; the prose of the
 * finding is given to it, because working prose out is a model's job and not a
 * script's.
 *
 * Plain CommonJS, because it is written to a file and run by a fresh process
 * rather than type-stripped and imported.
 */
const reviewer = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const after = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const refuse = (said) => {
  process.stderr.write("pi stand-in: " + said + "\\n");
  process.exit(1);
};
const say = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const update = (assistantMessageEvent) => say({ type: "message_update", assistantMessageEvent });

const reviewedFile = ${JSON.stringify(reviewedFile)};
const defect = ${JSON.stringify(defect)};
const fixedComparison = ${JSON.stringify(fixedComparison)};
const body = ${JSON.stringify(findingBody)};
const toolUse = ${JSON.stringify(reaching)};
const answered = ${JSON.stringify(answering)};

function review() {
  for (const required of ["--print", "--no-session"]) {
    if (!args.includes(required)) refuse("the command line carries no " + required);
  }
  if (after("--mode") !== "json") refuse("the output mode is not json");

  const tools = after("--tools");
  if (tools === undefined) refuse("the command line carries no tool grant");
  for (const writer of ["edit", "write", "bash"]) {
    if (tools.split(",").includes(writer)) refuse("the grant carries " + writer);
  }

  const sessionDirectory = after("--session-dir");
  if (sessionDirectory === undefined) refuse("the command line carries no session directory");

  const charterFile = after("--append-system-prompt");
  if (charterFile === undefined) refuse("the command line carries no charter");
  const charter = fs.readFileSync(charterFile, "utf8");
  if (charter.trim() === "") refuse("the charter is empty");

  const prompt = args[args.length - 1];
  if (prompt === undefined) refuse("the command line carries no prompt");
  const heading = prompt.split("\\n")[0];
  if (!/^# Review pull request #\\d+$/.test(heading)) refuse("the prompt names no pull request");
  const ruled = /^### (PRRT_\\S+)$/m.exec(prompt);
  if (ruled === null) refuse("the prompt carries no thread to rule on");
  if (!prompt.includes(defect)) refuse("the prompt carries no diff of the defect");

  const scratch = process.env.TMPDIR;
  if (scratch === undefined) refuse("no scratch space was named");

  const read = path.join(process.cwd(), reviewedFile);
  const lines = fs.readFileSync(read, "utf8").split("\\n");
  const at = lines.indexOf(defect) + 1;
  if (at === 0) refuse("nothing in " + read + " looks like the seeded defect");

  fs.writeFileSync(
    path.join(scratch, "handed.json"),
    JSON.stringify({
      cwd: process.cwd(),
      tools,
      charterFile,
      charterOpens: charter.split("\\n")[0],
      sessionDirectory,
      heading,
      thread: ruled[1],
    }),
  );

  const finding = Object.assign({ scope: "line", file: reviewedFile, line: at }, body);
  // The earlier round's finding is ruled on by reading the code as it now
  // stands, which is the only thing that settles it.
  const verdict = lines.includes(fixedComparison) ? "fixed" : "open";
  answered.message.content[1].text = JSON.stringify({
    findings: [finding],
    verdicts: [{ thread: ruled[1], verdict }],
  });

  say({ type: "session", sessionId: "stand-in" });
  say({ type: "agent_start" });
  say({ type: "turn_start" });
  say({ type: "message_start", message: { role: "assistant" } });
  update({ type: "text_start" });
  update({ type: "text_delta", delta: "Reading " + reviewedFile });
  say(toolUse);
  say({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: read } });
  say({ type: "tool_execution_end", toolCallId: "1", toolName: "read", isError: false });
  const result = { type: "text", text: "the file it asked for" };
  say({ type: "message_end", message: { role: "toolResult", content: [result] } });
  say(answered);
  say({ type: "turn_end" });
  // The largest line of a real stream, repeating the whole transcript. Nothing
  // reads it, and a reader that held it would hold the round's whole output.
  say({ type: "agent_end", willRetry: false, messages: [toolUse.message, answered.message] });
  say({ type: "agent_settled" });
}

try {
  review();
} catch (cause) {
  refuse(cause instanceof Error ? cause.message : String(cause));
}
`;
