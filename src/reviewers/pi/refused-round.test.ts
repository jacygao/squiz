/**
 * A round whose reviewer reaches for tools outside the grant, and for a read
 * outside the snapshot, driven over a real git repository with a stand-in for
 * `pi`. Each call outside the grant stands for a round whose `--tools` was
 * lost, where `pi` falls back to its own default set, a shell among it.
 *
 * **The stand-in loads the extension the way `pi` loads it** — from the path on
 * the command line, through the same default export, with the environment the
 * adapter gives it — and dispatches each call the way `pi` dispatches it: the
 * handler first, an error result carrying its reason where it blocks, and the
 * tool itself where it does not. The types the extension is written against are
 * structural, so a shape that drifted from `pi`'s would compile and fail only
 * in a round. This is what puts the real event shape through the real handler.
 *
 * **A call the handler lets through is really made.** The stand-in writes, and
 * the repository is read afterwards. A round that came back clean because
 * nothing was attempted and a round that came back clean because everything was
 * refused are the same round from outside, so the count and the repository are
 * both read, a granted read and a history tool are seen to run, and a round
 * where the reviewer tries nothing is run beside it.
 *
 * The stand-in refuses to review at all where the extension subscribed no
 * handler. `pi` skips the event entirely when nothing subscribed to it, and a
 * subscription that goes missing would otherwise leave every round clean, every
 * count zero, and nothing anywhere saying so.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { standIn } from "../../testing/stand-in.ts";
import type { Invocation } from "../adapter.ts";
import { runRound } from "../round.ts";
import { pi } from "./adapter.ts";

/** The file under review, which the stand-in tries to overwrite. */
const reviewedFile = "src/threads.ts";

const reviewedContent = `/** The last thing said on the thread. */
export function lastSaid(comments: readonly string[]): string | undefined {
  return comments[comments.length];
}
`;

/** The file beside the tree, outside the snapshot, which the stand-in tries to read. */
const outsideFile = "../outside.txt";

/** The tools outside every grant the stand-in calls: `pi`'s fallback set beyond `read`, and a name nothing serves. */
const UNGRANTED: readonly string[] = ["edit", "write", "bash", "delete_everything"];

/** The calls that must be refused: every ungranted tool, and the read outside the snapshot. */
const ATTEMPTS = UNGRANTED.length + 1;

const charterFile = fileURLToPath(new URL("../../../charter.md", import.meta.url));

/**
 * Long enough that nothing here rests on how fast the machine is, and short
 * enough that a stand-in which hangs is still a test that ends.
 */
const BOUND_SECONDS = 60;

test("every call outside the grant is refused, and the round counts them", async () => {
  await inTheFixture(async (tree) => {
    const round = await runRound(pi, invocationIn(tree), BOUND_SECONDS);

    assert.equal(round.outcome, "reviewed", `the round came back as ${JSON.stringify(round)}`);
    assert.equal(
      round.refusals,
      ATTEMPTS,
      "the round counted a different number of refusals than the reviewer was given",
    );
    assert.equal(
      git(["status", "--porcelain"], tree),
      "",
      "the reviewer changed the tree the coding agent is about to commit",
    );
    assert.equal(readFileSync(join(tree, reviewedFile), "utf8"), reviewedContent);
  });
});

/**
 * The refusal reaches the reviewer while it can still choose something else, so
 * one that never sees it looks exactly like one that saw it and carried on.
 */
test("the reviewer is told why, in the refused call's own error", async () => {
  await inTheFixture(async (tree) => {
    const told = toldIn(await runRound(pi, invocationIn(tree), BOUND_SECONDS));
    for (const tool of UNGRANTED) {
      assert.equal(
        told.get(`${tool} refused`),
        `squiz refused this call: \`${tool}\` is not a tool this review grants.`,
        `the reviewer was told: ${JSON.stringify([...told])}`,
      );
    }
    assert.match(
      told.get("read outside refused") ?? "",
      /^squiz refused this call: .* is outside the code under review/u,
      `the reviewer was told: ${JSON.stringify([...told])}`,
    );
  });
});

test("a granted read and a history tool still run", async () => {
  await inTheFixture(async (tree) => {
    const told = toldIn(await runRound(pi, invocationIn(tree), BOUND_SECONDS));
    assert.equal(told.get("read inside ran"), reviewedContent, JSON.stringify([...told]));
    assert.match(told.get("git_log_search ran") ?? "", /Add lastSaid/u, JSON.stringify([...told]));
  });
});

/**
 * The round a count of zero has to be told from. Both leave the repository as
 * they found it, and only the count separates them.
 */
test("a round whose reviewer reaches for none of them refuses nothing", async () => {
  await inTheFixture(async (tree) => {
    const round = await runRound(pi, { ...invocationIn(tree), prompt: TRIES_NOTHING }, BOUND_SECONDS);
    assert.equal(round.outcome, "reviewed", `the round came back as ${JSON.stringify(round)}`);
    assert.equal(round.refusals, 0);
    assert.equal(git(["status", "--porcelain"], tree), "");
  });
});

/** What the reviewer was told back for each call, by the headline the stand-in reported it under. */
function toldIn(round: Awaited<ReturnType<typeof runRound>>): ReadonlyMap<string, string> {
  assert.equal(round.outcome, "reviewed", `the round came back as ${JSON.stringify(round)}`);
  return new Map(round.findings.map((finding) => [finding.headline, finding.reference ?? ""]));
}

/** The prompt that tells the stand-in to review without reaching for anything. */
const TRIES_NOTHING = "# Review pull request #1\n\nReach for nothing.";

/** The invocation for one round over the fixture, at `deep`. */
function invocationIn(tree: string): Invocation {
  return {
    directory: tree,
    charterFile,
    prompt: "# Review pull request #1\n\nReach for the calls.",
    sessionDirectory: ".squiz/agent-1/session",
    promptFile: ".squiz/1/rounds/1/prompt.md",
    reportsFile: ".squiz/1/rounds/1/reports.jsonl",
    scratchDirectory: ".squiz/agent-1/scratch",
    githubConfigDirectory: ".squiz/agent-1/rounds/1/gh",
    depth: "deep",
    thinking: "medium",
    model: null,
    // No space, so nothing records a group. What a refused call does is the whole
    // of what this reads.
    terminal: "none",
  };
}

/**
 * A git repository with the reviewed file committed, a file beside it outside
 * the tree, and the stand-in on `PATH` as `pi`, so a write that escaped shows in
 * `git status`.
 */
async function inTheFixture(run: (tree: string) => Promise<void>): Promise<void> {
  const under = mkdtempSync(join(tmpdir(), "squiz-refused-"));
  const tree = join(under, "tree");
  const wasOnPath = process.env["PATH"] ?? "";
  try {
    mkdirSync(join(tree, dirname(reviewedFile)), { recursive: true });
    writeFileSync(join(tree, outsideFile), "decoy\n");
    writeFileSync(join(tree, ".gitignore"), ".squiz/\n");
    writeFileSync(join(tree, reviewedFile), reviewedContent);
    git(["init", "--quiet"], tree);
    git(["config", "user.name", "squiz fixture"], tree);
    git(["config", "user.email", "fixture@squiz.invalid"], tree);
    git(["config", "commit.gpgsign", "false"], tree);
    git(["add", "--all"], tree);
    git(["commit", "--quiet", "--message", "Add lastSaid"], tree);

    process.env["PATH"] = `${piIn(under)}${delimiter}${wasOnPath}`;
    await run(tree);
  } finally {
    process.env["PATH"] = wasOnPath;
    rmSync(under, { recursive: true, force: true });
  }
}

/** One git command in the fixture, with the machine's own configuration shut out. */
function git(args: readonly string[], tree: string): string {
  return execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "init.templateDir=", ...args], {
    cwd: tree,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
}

/**
 * The stand-in as a command named `pi`, and the directory to put at the front of
 * `PATH` so the command line the adapter builds finds it.
 */
function piIn(under: string): string {
  const bin = join(under, "bin");
  mkdirSync(bin);
  standIn(bin, "pi", reviewer, "node");
  return bin;
}

/**
 * The stand-in for `pi`: it loads the extension named on the command line,
 * offers each call it makes to the handler the extension subscribed, and runs
 * only what the handler let through. Its message and its reports go through the
 * extension too, which is what writes them to the report file the round reads.
 *
 * The dispatch is `pi`'s own: the first handler that blocks wins, a handler that
 * throws blocks as well, and a blocked call is answered with an error result
 * carrying the reason. It reports one finding per call, headed with the call and
 * whether it ran, carrying what it was told back, so the round can be read for
 * what the reviewer was actually told.
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
const give = (said) => {
  process.stderr.write("pi stand-in: " + said + "\\n");
  process.exit(1);
};
const say = (event) => process.stdout.write(JSON.stringify(event) + "\\n");

const triesNothing = ${JSON.stringify(TRIES_NOTHING)};

/** What pi answers a blocked call with: an error result carrying the reason. */
const blocked = (reason) => ({
  content: [{ type: "text", text: reason || "Tool execution was blocked" }],
  details: {},
});

async function review() {
  const extension = after("--extension");
  if (extension === undefined) give("the command line carries no extension");

  const tools = new Map();
  const handlers = [];
  const ended = [];
  const loaded = await import(extension);
  loaded.default({
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (event, handler) => {
      if (event === "tool_call") handlers.push(handler);
      if (event === "message_end") ended.push(handler);
    },
  });
  if (handlers.length === 0) {
    give("the extension subscribed no tool_call handler, so every call the reviewer makes runs");
  }

  let calls = 0;
  const told = [];
  const attempt = async (label, toolName, input, perform) => {
    calls += 1;
    const toolCallId = String(calls);
    say({ type: "tool_execution_start", toolCallId, toolName, args: input });
    let stopped;
    try {
      for (const handler of handlers) {
        const answer = handler({ type: "tool_call", toolCallId, toolName, input });
        if (answer && answer.block) {
          stopped = answer;
          break;
        }
      }
    } catch (cause) {
      stopped = { block: true, reason: cause instanceof Error ? cause.message : String(cause) };
    }
    if (stopped) {
      const result = blocked(stopped.reason);
      told.push([label + " refused", result.content[0].text]);
      say({ type: "tool_execution_end", toolCallId, toolName, isError: true, result });
      return;
    }
    const ran = String(await perform());
    told.push([label + " ran", ran]);
    say({
      type: "tool_execution_end",
      toolCallId,
      toolName,
      isError: false,
      result: { content: [{ type: "text", text: ran }] },
    });
  };

  // pi reads the file an @ argument names as the first message.
  const named = args[args.length - 1] ?? "";
  const prompt = named.startsWith("@") ? fs.readFileSync(named.slice(1), "utf8") : undefined;
  const reviewed = path.join(process.cwd(), ${JSON.stringify(reviewedFile)});
  if (prompt !== triesNothing) {
    await attempt("edit", "edit", { path: ${JSON.stringify(reviewedFile)}, oldText: "length]", newText: "length - 1]" }, () => {
      fs.writeFileSync(reviewed, "edited\\n");
      return "edited";
    });
    await attempt("write", "write", { path: ${JSON.stringify(reviewedFile)}, content: "escaped" }, () => {
      fs.writeFileSync(reviewed, "escaped\\n");
      return "written";
    });
    await attempt("bash", "bash", { command: "touch escaped" }, () => {
      fs.writeFileSync(path.join(process.cwd(), "escaped"), "");
      return "ran";
    });
    await attempt("delete_everything", "delete_everything", {}, () => {
      fs.rmSync(reviewed);
      return "deleted";
    });
    await attempt("read outside", "read", { path: ${JSON.stringify(outsideFile)} }, () =>
      fs.readFileSync(path.join(process.cwd(), ${JSON.stringify(outsideFile)}), "utf8"),
    );
    await attempt("read inside", "read", { path: ${JSON.stringify(reviewedFile)} }, () =>
      fs.readFileSync(reviewed, "utf8"),
    );
    await attempt("git_log_search", "git_log_search", { term: "lastSaid" }, async () => {
      const answer = await tools.get("git_log_search").execute("g1", { term: "lastSaid" });
      return answer.content[0].text;
    });
  }

  const findings = told.map(([headline, reference]) => ({
    scope: "change",
    severity: "low",
    headline,
    reasoning: ["What came back is in the reference."],
    suggestedFix: "Nothing.",
    reference: reference || "nothing came back",
  }));

  const message = {
    type: "message_end",
    message: {
      role: "assistant",
      model: "stand-in",
      stopReason: "stop",
      content: [{ type: "text", text: "reviewed" }],
      usage: {
        input: 1000,
        output: 200,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1200,
        cost: { input: 0.0008, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.001 },
      },
    },
  };
  for (const handler of ended) handler(message);
  for (const [at, finding] of findings.entries()) await tools.get("report_finding").execute("f" + at, finding);
  await tools.get("finish_review").execute("finish", {});
  // The message the reviewer closes its run with, after the finish.
  for (const handler of ended) handler(message);
}

review().catch((cause) => give(cause instanceof Error ? cause.message : String(cause)));
`;
