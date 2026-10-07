import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { Confinement, Invocation } from "../adapter.ts";
import { AGENT_NAME } from "./argv.ts";
import { confine } from "./confine.ts";

const CHARTER = "# Squiz review charter\n\nReview the change.\n";

type Fixture = { readonly invocation: Invocation; readonly home: string; readonly session: string };

/** A tree with a charter, and a home directory with no Copilot settings yet. */
function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), "squiz-copilot-confine-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tree = join(root, "tree");
  const home = join(root, "home");
  mkdirSync(tree);
  mkdirSync(home);
  writeFileSync(join(root, "charter.md"), CHARTER);
  const invocation: Invocation = {
    directory: tree,
    charterFile: join(root, "charter.md"),
    prompt: "Review pull request 142.",
    sessionDirectory: ".squiz/7/rounds/1/session",
    promptFile: ".squiz/7/rounds/1/prompt.md",
    reportsFile: ".squiz/7/rounds/1/reports.jsonl",
    scratchDirectory: ".squiz/7/scratch",
    githubConfigDirectory: ".squiz/7/rounds/1/gh",
    depth: "read",
    test: null,
    thinking: "medium",
    model: null,
    roundSpace: undefined,
    terminal: "none",
  };
  return { invocation, home, session: join(tree, ".squiz/7/rounds/1/session") };
}

function environmentOf(confinement: Confinement): Readonly<Record<string, string>> {
  assert.equal(confinement.outcome, "prepared", JSON.stringify(confinement));
  return confinement.outcome === "prepared" ? confinement.environment : {};
}

function settingsIn(directory: string, text: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "settings.json"), text);
}

test("COPILOT_HOME is the session directory, holding the agent whose instructions are the charter and nothing else", (t) => {
  const { invocation, home, session } = fixture(t);
  const environment = environmentOf(confine(invocation, { HOME: home }));
  assert.equal(environment["COPILOT_HOME"], session);
  assert.deepEqual(readdirSync(session), ["agents"]);
  assert.deepEqual(readdirSync(join(session, "agents")), [`${AGENT_NAME}.agent.md`]);
  const agent = readFileSync(join(session, "agents", `${AGENT_NAME}.agent.md`), "utf8");
  assert.equal(
    agent,
    `---\nname: ${AGENT_NAME}\ndescription: Reviews a pull request for squiz.\n---\n\n${CHARTER}`,
  );
});

// Set to exactly `true`, the host's value would trust the tree under review.
test("COPILOT_ALLOW_ALL is set, and set empty, whatever the host carries", (t) => {
  const { invocation, home } = fixture(t);
  const environment = environmentOf(confine(invocation, { HOME: home, COPILOT_ALLOW_ALL: "true" }));
  assert.ok("COPILOT_ALLOW_ALL" in environment, "an unset variable leaves the host's value in place");
  assert.equal(environment["COPILOT_ALLOW_ALL"], "");
});

test("the user's default model is read from their own settings and handed over as COPILOT_MODEL", (t) => {
  const { invocation, home } = fixture(t);
  settingsIn(join(home, ".copilot"), JSON.stringify({ model: "gpt-6-astra", effortLevel: "high" }));
  const environment = environmentOf(confine(invocation, { HOME: home }));
  assert.equal(environment["COPILOT_MODEL"], "gpt-6-astra");
  assert.deepEqual(Object.keys(environment).toSorted(), ["COPILOT_ALLOW_ALL", "COPILOT_HOME", "COPILOT_MODEL"]);
});

// The configured model is on the command line, and `--model` wins over the
// variable. Nothing of the user's model is read, so settings that would fail the
// read do not fail a round that has no use for them.
test("a configured model hands over no COPILOT_MODEL, and reads none of the user's settings", (t) => {
  const { invocation, home } = fixture(t);
  settingsIn(join(home, ".copilot"), "{ not json");
  const environment = environmentOf(
    confine({ ...invocation, model: "gpt-5-mini" }, { HOME: home, COPILOT_MODEL: "gpt-6-astra" }),
  );
  assert.deepEqual(Object.keys(environment).toSorted(), ["COPILOT_ALLOW_ALL", "COPILOT_HOME"]);
});

test("the user's settings are read under the COPILOT_HOME the user set", (t) => {
  const { invocation, home } = fixture(t);
  settingsIn(join(home, ".copilot"), JSON.stringify({ model: "not-this-one" }));
  settingsIn(join(home, "elsewhere"), JSON.stringify({ model: "claude-haiku-4.5" }));
  const environment = environmentOf(confine(invocation, { HOME: home, COPILOT_HOME: join(home, "elsewhere") }));
  assert.equal(environment["COPILOT_MODEL"], "claude-haiku-4.5");
  assert.equal(environment["COPILOT_HOME"], join(invocation.directory, invocation.sessionDirectory));
});

test("a COPILOT_MODEL the host carries is the user's default, and is handed on over the settings", (t) => {
  const { invocation, home } = fixture(t);
  settingsIn(join(home, ".copilot"), JSON.stringify({ model: "gpt-6-astra" }));
  const environment = environmentOf(confine(invocation, { HOME: home, COPILOT_MODEL: "gpt-5-mini" }));
  assert.equal(environment["COPILOT_MODEL"], "gpt-5-mini");
});

test("where the user has no default model, none is handed over", (t) => {
  const { invocation, home } = fixture(t);
  const environment = environmentOf(confine(invocation, { HOME: home }));
  assert.deepEqual(Object.keys(environment).toSorted(), ["COPILOT_ALLOW_ALL", "COPILOT_HOME"]);
  settingsIn(join(home, ".copilot"), JSON.stringify({ effortLevel: "high" }));
  assert.ok(!("COPILOT_MODEL" in environmentOf(confine(invocation, { HOME: home, COPILOT_MODEL: "" }))));
});

test("settings carrying a comment line are still read", (t) => {
  const { invocation, home } = fixture(t);
  settingsIn(join(home, ".copilot"), '// User settings.\n{\n  "model": "gpt-6-astra"\n}\n');
  assert.equal(environmentOf(confine(invocation, { HOME: home }))["COPILOT_MODEL"], "gpt-6-astra");
});

// A round run on a model other than the user's could be the coding agent's own.
test("settings that cannot be read as JSON fail the confinement", (t) => {
  const { invocation, home } = fixture(t);
  settingsIn(join(home, ".copilot"), '{ "model": ');
  const confinement = confine(invocation, { HOME: home });
  assert.equal(confinement.outcome, "failed");
  assert.match(confinement.outcome === "failed" ? confinement.reason : "", /settings\.json/u);
});

test("a charter that cannot be read fails the confinement", (t) => {
  const { invocation, home } = fixture(t);
  const confinement = confine({ ...invocation, charterFile: join(home, "no-charter.md") }, { HOME: home });
  assert.equal(confinement.outcome, "failed");
  assert.match(confinement.outcome === "failed" ? confinement.reason : "", /charter/u);
});

test("a session directory that cannot be made fails the confinement", (t) => {
  const { invocation, home } = fixture(t);
  // A file where the directory would go.
  writeFileSync(join(invocation.directory, ".squiz"), "");
  const confinement = confine(invocation, { HOME: home });
  assert.equal(confinement.outcome, "failed", JSON.stringify(confinement));
});

test("deep is confined as read is, with the same environment and the same agent", (t) => {
  const { invocation, home, session } = fixture(t);
  const environment = environmentOf(confine({ ...invocation, depth: "deep" }, { HOME: home }));
  assert.deepEqual(Object.keys(environment).toSorted(), ["COPILOT_ALLOW_ALL", "COPILOT_HOME"]);
  assert.deepEqual(readdirSync(join(session, "agents")), [`${AGENT_NAME}.agent.md`]);
});
