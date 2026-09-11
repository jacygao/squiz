import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  type Config,
  ConfigError,
  configFileName,
  defaultConfig,
  loadConfig,
} from "./config.ts";

/** A repository root holding the given `.squiz.json`, or none where it is null. */
function repositoryWith(contents: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "squiz-config-"));
  if (contents !== null) writeFileSync(join(root, configFileName), contents);
  return root;
}

function load(contents: string | null): Config {
  const root = repositoryWith(contents);
  try {
    return loadConfig(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function rejectionOf(attempt: () => unknown, what: string): ConfigError {
  try {
    attempt();
  } catch (error) {
    assert.ok(
      error instanceof ConfigError,
      `${what} must be refused with a ConfigError, and threw ${String(error)}`,
    );
    return error;
  }
  assert.fail(`${what} must be refused, and was accepted`);
}

function rejection(contents: string): ConfigError {
  return rejectionOf(() => load(contents), contents);
}

test("an absent .squiz.json is not an error, and yields the five defaults", () => {
  assert.deepEqual(load(null), {
    rounds: 3,
    depth: "read",
    test: null,
    timeout: 420,
    budget: 0.1,
  });
});

test("a .squiz.json with no keys yields the same five defaults", () => {
  assert.deepEqual(load("{}"), { ...defaultConfig });
});

test("the loaded defaults are a fresh object, so a caller cannot alter them", () => {
  const loaded = load(null);
  loaded.rounds = 8;
  assert.equal(defaultConfig.rounds, 3);
});

test("every setting the file names is read", () => {
  assert.deepEqual(
    load(`{"rounds": 5, "depth": "deep", "test": "npm test", "timeout": 90, "budget": 1.5}`),
    { rounds: 5, depth: "deep", test: "npm test", timeout: 90, budget: 1.5 },
  );
});

// The ranges are inclusive on both sides, so each is checked at the last value
// it accepts and the first it refuses.

test("rounds accepts 1 and 8, and refuses 0 and 9", () => {
  assert.equal(load(`{"rounds": 1}`).rounds, 1);
  assert.equal(load(`{"rounds": 8}`).rounds, 8);
  rejection(`{"rounds": 0}`);
  rejection(`{"rounds": 9}`);
  rejection(`{"rounds": -1}`);
});

test("timeout accepts 1 and 480, and refuses 0 and 481", () => {
  assert.equal(load(`{"timeout": 1}`).timeout, 1);
  assert.equal(load(`{"timeout": 480}`).timeout, 480);
  rejection(`{"timeout": 0}`);
  rejection(`{"timeout": 481}`);
  rejection(`{"timeout": -1}`);
});

test("budget accepts anything above 0 up to 5, and refuses 0 and 5.01", () => {
  assert.equal(load(`{"budget": 0.01}`).budget, 0.01);
  assert.equal(load(`{"budget": 5}`).budget, 5);
  assert.equal(load(`{"budget": 5.00}`).budget, 5);
  rejection(`{"budget": 0}`);
  rejection(`{"budget": 5.01}`);
  rejection(`{"budget": -0.5}`);
});

test("a count that is not whole is refused", () => {
  rejection(`{"rounds": 2.5}`);
  rejection(`{"timeout": 90.5}`);
});

// A zero is falsy, so a loader deciding presence by truthiness would return the
// default and report nothing. These are the two settings where that wrong
// answer is silent.

test("a budget of 0 is refused rather than replaced by the default", () => {
  const error = rejection(`{"budget": 0}`);
  assert.match(error.message, /"budget" is 0/);
  assert.doesNotMatch(error.message, /0\.1\b/);
});

test("a timeout of 0 is refused rather than replaced by the default", () => {
  const error = rejection(`{"timeout": 0}`);
  assert.match(error.message, /"timeout" is 0/);
});

test("a value in range but below the default survives the load", () => {
  // The other half of the truthiness trap: a small valid number is kept, not
  // rounded up to the default.
  assert.equal(load(`{"rounds": 1}`).rounds, 1);
  assert.equal(load(`{"timeout": 1}`).timeout, 1);
  assert.equal(load(`{"budget": 0.01}`).budget, 0.01);
});

test("depth is read or deep, and anything else is refused", () => {
  assert.equal(load(`{"depth": "read"}`).depth, "read");
  assert.equal(load(`{"depth": "deep"}`).depth, "deep");
  rejection(`{"depth": "shallow"}`);
  rejection(`{"depth": "READ"}`);
  rejection(`{"depth": ""}`);
});

test("a value of the wrong type is refused like one out of range", () => {
  rejection(`{"rounds": "3"}`);
  rejection(`{"rounds": null}`);
  rejection(`{"rounds": true}`);
  rejection(`{"depth": 3}`);
  rejection(`{"test": 5}`);
  rejection(`{"timeout": null}`);
  rejection(`{"budget": "0.10"}`);
  rejection(`{"budget": []}`);
});

test("no test command is null rather than an empty string", () => {
  assert.equal(load("{}").test, null);
  assert.equal(load(`{"rounds": 3}`).test, null);
  assert.equal(load(`{"test": "npm test"}`).test, "npm test");
});

test("an empty test command is refused, because it is not the same as none", () => {
  const error = rejection(`{"test": ""}`);
  assert.match(error.message, /"test" is ""/);
  assert.match(error.message, /leave "test" out/);
  rejection(`{"test": "   "}`);
});

// The error names the setting, the value given and what was expected. One
// saying only that the configuration is invalid is the failure this checks for.

test("every refusal names the setting, the value given and what was expected", () => {
  const cases: ReadonlyArray<{
    contents: string;
    setting: string;
    given: string;
    expected: RegExp;
  }> = [
    { contents: `{"rounds": 12}`, setting: "rounds", given: "12", expected: /whole number from 1 to 8/ },
    { contents: `{"rounds": "3"}`, setting: "rounds", given: `"3"`, expected: /whole number from 1 to 8/ },
    { contents: `{"depth": "shallow"}`, setting: "depth", given: `"shallow"`, expected: /"read" or "deep"/ },
    { contents: `{"depth": 3}`, setting: "depth", given: "3", expected: /"read" or "deep"/ },
    { contents: `{"test": ""}`, setting: "test", given: `""`, expected: /a command to run/ },
    { contents: `{"timeout": 600}`, setting: "timeout", given: "600", expected: /seconds from 1 to 480/ },
    { contents: `{"timeout": null}`, setting: "timeout", given: "null", expected: /seconds from 1 to 480/ },
    { contents: `{"budget": 9.99}`, setting: "budget", given: "9.99", expected: /above 0 and at most 5/ },
    { contents: `{"budget": true}`, setting: "budget", given: "true", expected: /above 0 and at most 5/ },
  ];

  for (const { contents, setting, given, expected } of cases) {
    const { message } = rejection(contents);
    assert.ok(
      message.includes(`"${setting}"`),
      `${contents} must name the setting, and said: ${message}`,
    );
    assert.ok(
      message.includes(`is ${given},`),
      `${contents} must give the value as written, and said: ${message}`,
    );
    assert.match(message, expected, `${contents} must say what was expected`);
    assert.ok(
      message.includes(configFileName),
      `${contents} must name the file, and said: ${message}`,
    );
  }
});

test("malformed JSON is refused with an error that names the file", () => {
  const error = rejection(`{"rounds": 3,}`);
  assert.match(error.message, /is not valid JSON/);
  assert.ok(error.message.includes(configFileName));
  assert.ok(error.cause instanceof Error, "the parse error is kept as the cause");
});

test("a file that does not hold a JSON object is refused", () => {
  const array = rejection(`[3]`);
  assert.match(array.message, /must hold a JSON object, but it holds \[3\]/);
  rejection(`null`);
  rejection(`"read"`);
  rejection(`3`);
});

test("a key that is not a setting is refused rather than ignored", () => {
  const error = rejection(`{"round": 5}`);
  assert.match(error.message, /"round" is not a setting/);
  assert.match(error.message, /"rounds", "depth", "test", "timeout" and "budget"/);
});

test("a .squiz.json that is there and cannot be read is not read as absent", () => {
  const root = mkdtempSync(join(tmpdir(), "squiz-config-"));
  // A directory in its place is the portable way to make the read fail with
  // something other than ENOENT.
  mkdirSync(join(root, configFileName));
  try {
    const error = rejectionOf(() => loadConfig(root), "a .squiz.json that is a directory");
    assert.match(error.message, /could not be read/);
    assert.ok(error.message.includes(configFileName));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
