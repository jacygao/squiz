import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Invocation } from "../adapter.ts";
import { makeRoundSpace, shellPrefix, type RoundSpace } from "../groups.ts";
import { confine } from "./settings.ts";

test("at a depth granting no shell nothing is written and nothing is added", () => {
  inADirectory((root) => {
    const theirs = agentDirectory(root, { defaultModel: "deepseek-v4-pro" });
    const space = spaceIn(root);
    withAgentDirectory(theirs, () => {
      assert.deepEqual(confine(at(undefined)), { outcome: "prepared", environment: {} });
    });
    assert.deepEqual(entriesIn(space.directory), ["groups"]);
  });
});

test("the setting goes where pi reads it, and the reviewer is pointed there", () => {
  inADirectory((root) => {
    const theirs = agentDirectory(root, {});
    const space = spaceIn(root);
    const prepared = withAgentDirectory(theirs, () => confine(at(space)));

    assert.equal(prepared.outcome, "prepared");
    const mine = prepared.outcome === "prepared" ? prepared.environment["PI_CODING_AGENT_DIR"] : "";
    assert.ok(mine?.startsWith(space.directory), `pi was pointed at ${mine ?? "nothing"}`);
    assert.equal(settingsIn(mine ?? "")["shellCommandPrefix"], shellPrefix);
  });
});

/**
 * The command line names no model, so the model comes from the user's own
 * settings. Settings quietly dropped are a round reviewed by a model nobody
 * chose, which looks exactly like a round that went well.
 */
test("the user's own settings are carried into the one pi is given", () => {
  inADirectory((root) => {
    const theirs = agentDirectory(root, {
      defaultProvider: "deepseek",
      defaultModel: "deepseek-v4-pro",
      retry: { maxRetries: 4 },
    });
    const space = spaceIn(root);
    const mine = preparedIn(theirs, space);

    const settings = settingsIn(mine);
    assert.equal(settings["defaultProvider"], "deepseek");
    assert.equal(settings["defaultModel"], "deepseek-v4-pro");
    assert.deepEqual(settings["retry"], { maxRetries: 4 });
  });
});

test("the user's own settings file is not written to", () => {
  inADirectory((root) => {
    const theirs = agentDirectory(root, { defaultModel: "deepseek-v4-pro" });
    const before = readFileSync(join(theirs, "settings.json"), "utf8");
    preparedIn(theirs, spaceIn(root));
    assert.equal(readFileSync(join(theirs, "settings.json"), "utf8"), before);
  });
});

/**
 * Every path `pi` resolves hangs off the directory this variable names: its
 * credential, its model catalogue, and the binaries it puts on the shell's path.
 * A directory holding the settings alone is a reviewer with no credential.
 */
test("everything else of the user's is reachable from the directory pi is given", () => {
  inADirectory((root) => {
    const theirs = agentDirectory(root, {});
    writeFileSync(join(theirs, "auth.json"), '{"deepseek":{"type":"api_key","key":"secret"}}', "utf8");
    mkdirSync(join(theirs, "bin"), { recursive: true });
    writeFileSync(join(theirs, "bin", "rg"), "#!/bin/sh\n", "utf8");

    const mine = preparedIn(theirs, spaceIn(root));
    assert.match(readFileSync(join(mine, "auth.json"), "utf8"), /secret/u);
    assert.equal(readFileSync(join(mine, "bin", "rg"), "utf8"), "#!/bin/sh\n");
  });
});

/**
 * The credential is reached through a link, and `pi` refreshing an expired token
 * writes the file in place. A write that replaced the file instead would leave a
 * copy of the user's credential in the round's own directory.
 */
test("a write to the linked credential reaches the user's own file, link and all", () => {
  inADirectory((root) => {
    const theirs = agentDirectory(root, {});
    writeFileSync(join(theirs, "auth.json"), "{}", "utf8");
    const mine = preparedIn(theirs, spaceIn(root));

    writeFileSync(join(mine, "auth.json"), '{"deepseek":{"type":"api_key"}}', "utf8");
    assert.match(readFileSync(join(theirs, "auth.json"), "utf8"), /deepseek/u);
    assert.ok(lstatSync(join(mine, "auth.json")).isSymbolicLink(), "the link was replaced by a copy");
  });
});

test("the round's own line runs before a prefix the user configured", () => {
  inADirectory((root) => {
    const theirs = agentDirectory(root, { shellCommandPrefix: "shopt -s expand_aliases" });
    const mine = preparedIn(theirs, spaceIn(root));
    assert.equal(
      settingsIn(mine)["shellCommandPrefix"],
      `${shellPrefix}\nshopt -s expand_aliases`,
      "a prefix of the user's that exits would stop the recording line from ever running",
    );
  });
});

/**
 * `pi` merges a trusted project's own settings over the user's global ones, and
 * one string key replaces the other rather than adding to it. A project prefix
 * would therefore leave the round's recording line unrun, with the round reporting
 * itself prepared and no shell recording anything.
 *
 * The command line untrusts the tree, so the project's file reaches `pi` through
 * this and nowhere else. What it configured still runs, and runs second.
 */
test("a prefix the tree under review configured runs, after the round's own line", () => {
  inADirectory((root) => {
    const theirs = agentDirectory(root, { shellCommandPrefix: "export GLOBAL_PREFIX=1" });
    const worktree = projectIn(root, { shellCommandPrefix: "export PROJECT_PREFIX=1" });
    const mine = preparedIn(theirs, spaceIn(root), worktree);
    assert.equal(
      settingsIn(mine)["shellCommandPrefix"],
      `${shellPrefix}\nexport PROJECT_PREFIX=1`,
      "pi resolves the project's prefix over the global one, so the round's line goes in front of it",
    );
  });
});

/**
 * The other way of making the round's line effective is to write the setting into
 * the tree, and it is not open: an untracked file in the worktree is one the
 * round's own reading of the files reports as a change the round made.
 */
test("nothing is written into the tree under review", () => {
  inADirectory((root) => {
    const theirs = agentDirectory(root, {});
    const worktree = projectIn(root, { shellCommandPrefix: "export PROJECT_PREFIX=1" });
    const before = readFileSync(join(worktree, ".pi", "settings.json"), "utf8");

    preparedIn(theirs, spaceIn(root), worktree);

    assert.deepEqual(entriesIn(worktree), [".pi"]);
    assert.deepEqual(entriesIn(join(worktree, ".pi")), ["settings.json"]);
    assert.equal(readFileSync(join(worktree, ".pi", "settings.json"), "utf8"), before);
  });
});

/**
 * A project file `pi` would not read is one it drops whole, so reading it here has
 * to come to the same thing: the user's own global prefix, and the round's line in
 * front of it.
 */
test("a project file that will not read leaves the user's own prefix where it was", () => {
  inADirectory((root) => {
    const theirs = agentDirectory(root, { shellCommandPrefix: "export GLOBAL_PREFIX=1" });
    const worktree = join(root, "worktree");
    mkdirSync(join(worktree, ".pi"), { recursive: true });
    writeFileSync(join(worktree, ".pi", "settings.json"), "{ not json", "utf8");

    const mine = preparedIn(theirs, spaceIn(root), worktree);
    assert.equal(
      settingsIn(mine)["shellCommandPrefix"],
      `${shellPrefix}\nexport GLOBAL_PREFIX=1`,
    );
  });
});

test("settings that will not read fail the round rather than being dropped", () => {
  inADirectory((root) => {
    const theirs = join(root, "agent");
    mkdirSync(theirs, { recursive: true });
    writeFileSync(join(theirs, "settings.json"), "{ not json", "utf8");

    const prepared = withAgentDirectory(theirs, () => confine(at(spaceIn(root))));
    assert.equal(prepared.outcome, "failed");
    assert.match(prepared.outcome === "failed" ? prepared.reason : "", /is not valid JSON/u);
  });
});

test("a user with no pi configuration still gets the setting", () => {
  inADirectory((root) => {
    const mine = preparedIn(join(root, "not-there"), spaceIn(root));
    assert.equal(settingsIn(mine)["shellCommandPrefix"], shellPrefix);
  });
});

/** The agent directory the user's own runs would read, with the settings given. */
function agentDirectory(root: string, settings: Record<string, unknown>): string {
  const directory = join(root, "agent");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return directory;
}

/** A tree under review holding the project settings given, which `pi` reads at `.pi/`. */
function projectIn(root: string, settings: Record<string, unknown>): string {
  const worktree = join(root, "worktree");
  mkdirSync(join(worktree, ".pi"), { recursive: true });
  writeFileSync(
    join(worktree, ".pi", "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );
  return worktree;
}

function spaceIn(root: string): RoundSpace {
  const made = makeRoundSpace(join(root, "episode"));
  assert.equal(made.outcome, "made");
  return made.outcome === "made" ? made.space : ({} as RoundSpace);
}

function at(roundSpace: RoundSpace | undefined, directory = "/tmp/squiz/worktree"): Invocation {
  return {
    directory,
    charterFile: "/tmp/squiz/plugin/charter.md",
    prompt: "Review pull request 142.",
    sessionDirectory: ".squiz/agent-7/session",
    reportsFile: ".squiz/7/rounds/1/reports.jsonl",
    scratchDirectory: ".squiz/agent-7/scratch",
    depth: roundSpace === undefined ? "read" : "deep",
    thinking: "medium",
    roundSpace,
    terminal: "none",
  };
}

/** The directory `pi` is pointed at, having prepared it. */
function preparedIn(theirs: string, space: RoundSpace, directory?: string): string {
  const prepared = withAgentDirectory(theirs, () => confine(at(space, directory)));
  assert.equal(prepared.outcome, "prepared", JSON.stringify(prepared));
  const mine = prepared.outcome === "prepared" ? prepared.environment["PI_CODING_AGENT_DIR"] : "";
  assert.ok(mine !== undefined && mine !== "", "nothing pointed pi at a directory");
  return mine;
}

/** Run with the user's agent directory where `pi` itself would look for it. */
function withAgentDirectory<T>(directory: string, run: () => T): T {
  const previous = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = directory;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previous;
  }
}

function settingsIn(directory: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(directory, "settings.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

function entriesIn(directory: string): readonly string[] {
  return readdirSync(directory).toSorted();
}

function inADirectory(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "squiz-pi-settings-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
