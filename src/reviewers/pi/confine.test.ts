import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { Invocation } from "../adapter.ts";
import { confine } from "./confine.ts";

// What `pi --list-models` prints with no terminal: a header, then one row a model.
const LISTED = [
  "provider  model                 context  max-out  thinking  images",
  "deepseek  deepseek-v4-pro       1M       384K     yes       no    ",
  "openai    gpt-5-mini            400K     128K     yes       yes   ",
  "openai    gpt-5.4-mini          400K     128K     yes       yes   ",
  "",
].join("\n");

type Fixture = { readonly invocation: Invocation; readonly environment: NodeJS.ProcessEnv; readonly ran: string };

/**
 * A tree, and a stand-in `pi` first on the path that records its arguments and
 * working directory, then prints `listing` and exits `status`.
 */
function fixture(t: TestContext, listing: string, status = 0): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "squiz-pi-confine-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tree = join(root, "tree");
  const bin = join(root, "bin");
  mkdirSync(tree);
  mkdirSync(bin);
  writeFileSync(join(root, "listing"), listing);
  const ran = join(root, "ran");
  writeFileSync(
    join(bin, "pi"),
    [
      "#!/bin/sh",
      `{ pwd; printf "%s\\n" "$@"; } > '${ran}'`,
      `cat '${join(root, "listing")}'`,
      `[ ${status} -eq 0 ] || echo "pi failed for the test" >&2`,
      `exit ${status}`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "pi"), 0o755);
  const invocation: Invocation = {
    directory: tree,
    charterFile: join(root, "charter.md"),
    prompt: "Review pull request 142.",
    sessionDirectory: ".squiz/7/rounds/1/session",
    promptFile: ".squiz/7/rounds/1/prompt.md",
    reportsFile: ".squiz/7/rounds/1/reports.jsonl",
    githubConfigDirectory: ".squiz/7/rounds/1/gh",
    thinking: "medium",
    model: null,
    terminal: "none",
  };
  return { invocation, environment: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` }, ran };
}

test("with no model configured, pi is handed nothing and nothing runs", (t) => {
  const { invocation, environment, ran } = fixture(t, LISTED);
  assert.deepEqual(confine(invocation, environment), { outcome: "prepared", environment: {} });
  assert.ok(!existsSync(ran), "pi was run to check a model nobody configured");
});

test("a model pi lists as provider/id is prepared, checked the way the round runs pi", (t) => {
  const { invocation, environment, ran } = fixture(t, LISTED);
  const confinement = confine({ ...invocation, model: "openai/gpt-5-mini" }, environment);
  assert.deepEqual(confinement, { outcome: "prepared", environment: {} });
  const [directory, ...args] = readLines(ran);
  assert.equal(directory, invocation.directory);
  assert.deepEqual(args, ["--no-approve", "--no-extensions", "--list-models"]);
});

// `pi --model` matches a name it does not have by part of it, so `gpt-5` would
// run on whichever listed model's name contains it.
test("a model pi does not list fails the confinement, naming the setting and the value", (t) => {
  const { invocation, environment } = fixture(t, LISTED);
  for (const model of ["openai/gpt-5", "gpt-5", "openai/GPT-5-MINI", "anthropic/gpt-5-mini", "mini"]) {
    const confinement = confine({ ...invocation, model }, environment);
    assert.equal(confinement.outcome, "failed", `${model} was prepared`);
    const reason = confinement.outcome === "failed" ? confinement.reason : "";
    assert.ok(reason.includes(`"model"`), `the reason names no setting: ${reason}`);
    assert.ok(reason.includes(`"${model}"`), `the reason names no value: ${reason}`);
  }
});

test("a bare id pi lists under one provider is refused, and the refusal gives its full name", (t) => {
  const { invocation, environment } = fixture(t, LISTED);
  const confinement = confine({ ...invocation, model: "gpt-5-mini" }, environment);
  assert.equal(confinement.outcome, "failed");
  assert.match(confinement.outcome === "failed" ? confinement.reason : "", /"openai\/gpt-5-mini"/u);
});

test("a pi that cannot list its models fails the confinement rather than running unchecked", (t) => {
  const { invocation, environment } = fixture(t, LISTED, 1);
  const confinement = confine({ ...invocation, model: "openai/gpt-5-mini" }, environment);
  assert.equal(confinement.outcome, "failed");
  assert.match(confinement.outcome === "failed" ? confinement.reason : "", /pi failed for the test/u);
});

test("a pi that is not installed fails the confinement", (t) => {
  const { invocation } = fixture(t, LISTED);
  const confinement = confine({ ...invocation, model: "openai/gpt-5-mini" }, { PATH: "/nonexistent" });
  assert.equal(confinement.outcome, "failed");
});

function readLines(file: string): readonly string[] {
  assert.ok(existsSync(file), "pi was never run");
  return readFileSync(file, "utf8").trimEnd().split("\n");
}
