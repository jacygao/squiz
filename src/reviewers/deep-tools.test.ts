import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type DeepRound, deepToolNames, deepTools, ROUND_VARIABLE, roundVariable } from "./deep-tools.ts";
import { historyTools } from "./git-tools.ts";
import { runTestsTool, STOP_MARGIN_MS } from "./run-tests.ts";

test("the deep tools are the shared runners, under their own names and schemas", () => {
  assert.deepEqual(deepToolNames, ["run_tests", "git_log_search", "git_blame", "git_show"]);
  const tools = deepTools({});
  assert.deepEqual(
    tools.map((tool) => tool.name),
    deepToolNames,
  );
  for (const shared of [runTestsTool, ...historyTools]) {
    const served = tools.find((tool) => tool.name === shared.name);
    assert.ok(served !== undefined, `${shared.name} is not served`);
    assert.deepEqual(served.parameters, shared.parameters, `${shared.name} is served under a schema of its own`);
    assert.ok(served.description.trim() !== "", `${shared.name} has no description for the model`);
  }
});

// A round that set nothing must not get a run_tests that runs unbounded, in
// whatever directory the extension happens to be in.
test("with no round handed over, every tool fails and nothing runs", async () => {
  for (const environment of [{}, { [ROUND_VARIABLE]: "{not json" }, { [ROUND_VARIABLE]: '{"snapshot":1}' }]) {
    for (const tool of deepTools(environment)) {
      const result = await tool.call(tool.name === "git_show" ? { commit: "HEAD" } : {});
      assert.ok(result.failed, `${tool.name} answered ${result.text}`);
      assert.match(result.text, new RegExp(`could not run: .*${ROUND_VARIABLE}`, "u"), result.text);
    }
  }
});

test("run_tests runs the round's command in the round's snapshot, with the round's scratch space", async () => {
  await inARepository(async ({ snapshot, scratch }) => {
    const round: DeepRound = { snapshot, scratch, test: 'pwd; echo "$TMPDIR"', endsAt: Date.now() + 60_000 };
    const result = await runTests(round, {});
    assert.ok(!result.failed, result.text);
    assert.match(result.text, /^The test command exited 0\./u);
    assert.ok(result.text.includes(realpathSync(snapshot)), result.text);
    assert.ok(result.text.includes(scratch), result.text);
  });
});

test("run_tests runs the command with the environment it was handed", async () => {
  await inARepository(async ({ snapshot, scratch }) => {
    const round: DeepRound = { snapshot, scratch, test: 'echo "token=[$GH_TOKEN] seen=$SEEN"', endsAt: Date.now() + 60_000 };
    const result = await runTests(round, { GH_TOKEN: "", SEEN: "yes" });
    assert.ok(result.text.includes("token=[] seen=yes"), result.text);
  });
});

test("run_tests with no command configured runs nothing, and says so as its error", async () => {
  await inARepository(async ({ snapshot, scratch }) => {
    const result = await runTests({ snapshot, scratch, test: null, endsAt: Date.now() + 60_000 }, {});
    assert.ok(result.failed);
    assert.match(result.text, /No test command is configured/u);
  });
});

// The bound is the round's: a test command that would outlast the round is
// stopped before the round ends, rather than running until something else ends it.
test("run_tests stops a command that would outlast the round's deadline", async () => {
  await inARepository(async ({ snapshot, scratch }) => {
    const endsAt = Date.now() + STOP_MARGIN_MS + 1_500;
    const started = Date.now();
    const result = await runTests({ snapshot, scratch, test: "sleep 60", endsAt }, {});
    const took = Date.now() - started;
    assert.match(result.text, /was stopped after \d+ seconds, because the round's time ran out/u);
    assert.ok(took < 10_000, `run_tests took ${took} ms with ${STOP_MARGIN_MS + 1_500} ms left in the round`);
  });
});

test("a history tool reads the round's snapshot, not the directory it runs in", async () => {
  await inARepository(async ({ snapshot, scratch }) => {
    const tool = deepTools(roundVariable({ snapshot, scratch, test: null, endsAt: Date.now() + 60_000 })).find(
      (each) => each.name === "git_show",
    );
    assert.ok(tool !== undefined);
    const result = await tool.call({ commit: "HEAD" });
    assert.ok(!result.failed, result.text);
    assert.ok(result.text.includes("The commit only the snapshot holds"), result.text);
  });
});

/** Run the round's `run_tests` through the round variable, as an adapter's tool would. */
async function runTests(round: DeepRound, environment: Record<string, string>) {
  const tool = deepTools({ ...environment, ...roundVariable(round) }).find((each) => each.name === "run_tests");
  assert.ok(tool !== undefined);
  return tool.call({});
}

type Repository = { readonly snapshot: string; readonly scratch: string };

/** A repository with one commit of its own, and a scratch space beside it. */
async function inARepository(run: (repository: Repository) => Promise<void>): Promise<void> {
  const under = mkdtempSync(join(tmpdir(), "squiz-deep-tools-"));
  const snapshot = join(under, "snapshot");
  const scratch = join(under, "scratch");
  try {
    mkdirSync(snapshot);
    mkdirSync(scratch);
    writeFileSync(join(snapshot, "file.txt"), "one\n");
    const git = (...args: string[]): void => {
      execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "init.templateDir=", ...args], {
        cwd: snapshot,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      });
    };
    git("init", "--quiet");
    git("add", "--all");
    git(
      "-c",
      "user.name=squiz fixture",
      "-c",
      "user.email=fixture@squiz.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--message",
      "The commit only the snapshot holds",
    );
    await run({ snapshot, scratch });
  } finally {
    rmSync(under, { recursive: true, force: true });
  }
}
