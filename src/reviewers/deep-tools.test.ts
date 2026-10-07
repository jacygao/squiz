import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { deepToolNames, deepTools, ROUND_VARIABLE, roundVariable } from "./deep-tools.ts";
import { historyTools } from "./git-tools.ts";

test("the deep tools are the shared history tools, under their own names and schemas", () => {
  assert.deepEqual(deepToolNames, ["git_log_search", "git_blame", "git_show"]);
  const tools = deepTools({});
  assert.deepEqual(
    tools.map((tool) => tool.name),
    deepToolNames,
  );
  for (const shared of historyTools) {
    const served = tools.find((tool) => tool.name === shared.name);
    assert.ok(served !== undefined, `${shared.name} is not served`);
    assert.deepEqual(served.parameters, shared.parameters, `${shared.name} is served under a schema of its own`);
    assert.ok(served.description.trim() !== "", `${shared.name} has no description for the model`);
  }
});

// A round that set nothing must not get tools that read whatever directory the
// extension happens to be in.
test("with no round handed over, every tool fails and nothing runs", async () => {
  for (const environment of [{}, { [ROUND_VARIABLE]: "{not json" }, { [ROUND_VARIABLE]: '{"snapshot":1}' }]) {
    for (const tool of deepTools(environment)) {
      const result = await tool.call(tool.name === "git_show" ? { commit: "HEAD" } : {});
      assert.ok(result.failed, `${tool.name} answered ${result.text}`);
      assert.match(result.text, new RegExp(`could not run: .*${ROUND_VARIABLE}`, "u"), result.text);
    }
  }
});

test("a history tool reads the round's snapshot, not the directory it runs in", async () => {
  await inARepository(async (snapshot) => {
    const tool = deepTools(roundVariable({ snapshot })).find(
      (each) => each.name === "git_show",
    );
    assert.ok(tool !== undefined);
    const result = await tool.call({ commit: "HEAD" });
    assert.ok(!result.failed, result.text);
    assert.ok(result.text.includes("The commit only the snapshot holds"), result.text);
  });
});

/** A repository with one commit of its own. */
async function inARepository(run: (snapshot: string) => Promise<void>): Promise<void> {
  const under = mkdtempSync(join(tmpdir(), "squiz-deep-tools-"));
  const snapshot = join(under, "snapshot");
  try {
    mkdirSync(snapshot);
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
    await run(snapshot);
  } finally {
    rmSync(under, { recursive: true, force: true });
  }
}
