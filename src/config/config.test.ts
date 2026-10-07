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

test("an absent .squiz.json is not an error, and yields the six defaults", () => {
  assert.deepEqual(load(null), {
    reviewer: "pi",
    rounds: 3,
    timeout: 900,
    tokens: 10_000_000,
    thinking: "medium",
    model: null,
  });
});

test("a .squiz.json with no keys yields the same six defaults", () => {
  assert.deepEqual(load("{}"), { ...defaultConfig });
});

test("the loaded defaults are a fresh object, so a caller cannot alter them", () => {
  const loaded = load(null);
  loaded.rounds = 8;
  assert.equal(defaultConfig.rounds, 3);
});

test("every setting the file names is read", () => {
  assert.deepEqual(
    load(
      `{"reviewer": "copilot", "rounds": 5, "timeout": 90, "tokens": 400000, "thinking": "high", "model": "gpt-5-mini"}`,
    ),
    {
      reviewer: "copilot",
      rounds: 5,
      timeout: 90,
      tokens: 400_000,
      thinking: "high",
      model: "gpt-5-mini",
    },
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

test("timeout accepts 60 and 3,600, and refuses 59 and 3,601", () => {
  assert.equal(load(`{"timeout": 60}`).timeout, 60);
  assert.equal(load(`{"timeout": 3600}`).timeout, 3_600);
  rejection(`{"timeout": 59}`);
  rejection(`{"timeout": 3601}`);
  rejection(`{"timeout": 0}`);
  rejection(`{"timeout": -1}`);
});

test("the default timeout is 900 seconds", () => {
  assert.equal(defaultConfig.timeout, 900);
});

test("tokens accepts 100,000 and 10,000,000, and refuses 99,999 and 10,000,001", () => {
  assert.equal(load(`{"tokens": 100000}`).tokens, 100_000);
  assert.equal(load(`{"tokens": 10000000}`).tokens, 10_000_000);
  rejection(`{"tokens": 99999}`);
  rejection(`{"tokens": 10000001}`);
  rejection(`{"tokens": 0}`);
  rejection(`{"tokens": -100000}`);
});

// The floor is what a figure written in thousands by mistake lands below, and a
// bound under a single honest review closes every episode after its first round.
test("a token bound written in thousands is refused rather than closing every episode", () => {
  rejection(`{"tokens": 1500}`);
});

test("a count that is not whole is refused", () => {
  rejection(`{"rounds": 2.5}`);
  rejection(`{"timeout": 90.5}`);
  rejection(`{"tokens": 150000.5}`);
});

// A zero is falsy, so a loader deciding presence by truthiness would return the
// default and report nothing. These are the two settings where that wrong
// answer is silent.

test("a token bound of 0 is refused rather than replaced by the default", () => {
  const error = rejection(`{"tokens": 0}`);
  assert.match(error.message, /"tokens" is 0/);
  assert.doesNotMatch(error.message, /10000000/);
});

test("a timeout of 0 is refused rather than replaced by the default", () => {
  const error = rejection(`{"timeout": 0}`);
  assert.match(error.message, /"timeout" is 0/);
});

test("a value in range but below the default survives the load", () => {
  // The other half of the truthiness trap: a small valid number is kept, not
  // rounded up to the default.
  assert.equal(load(`{"rounds": 1}`).rounds, 1);
  assert.equal(load(`{"timeout": 60}`).timeout, 60);
  assert.equal(load(`{"tokens": 100000}`).tokens, 100_000);
});

// The grant is the same at every review, so the setting that chose one is gone.
test("an old depth key is refused like any unknown setting", () => {
  for (const value of [`"read"`, `"deep"`]) {
    assert.match(rejection(`{"depth": ${value}}`).message, /"depth" is not a setting, and the settings are /u);
  }
});

test("reviewer is pi or copilot, and anything else is refused", () => {
  assert.equal(load(`{"reviewer": "pi"}`).reviewer, "pi");
  assert.equal(load(`{"reviewer": "copilot"}`).reviewer, "copilot");
  rejection(`{"reviewer": "claude"}`);
  rejection(`{"reviewer": "Copilot"}`);
  rejection(`{"reviewer": "pi "}`);
  rejection(`{"reviewer": ""}`);
  rejection(`{"reviewer": null}`);
});

// A project that writes no reviewer is reviewed by pi, as every project was
// before the setting existed.
test("reviewer defaults to pi", () => {
  assert.equal(load("{}").reviewer, "pi");
  assert.equal(load(`{"rounds": 3}`).reviewer, "pi");
});

// The levels are the reviewer CLI's own names, matched exactly. A name it does
// not recognise costs nothing but a warning on a stream nothing reads, and the
// review then runs at whatever level the machine holds.
test("thinking accepts every level the reviewer has, and refuses anything else", () => {
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(load(`{"thinking": "${level}"}`).thinking, level);
  }
  rejection(`{"thinking": "higher"}`);
  rejection(`{"thinking": "HIGH"}`);
  rejection(`{"thinking": "xxhigh"}`);
  rejection(`{"thinking": "medium "}`);
  rejection(`{"thinking": ""}`);
});

test("thinking defaults to medium, and no value asks for the machine's own level", () => {
  assert.equal(load("{}").thinking, "medium");
  assert.equal(load(`{"rounds": 3}`).thinking, "medium");
  rejection(`{"thinking": "inherit"}`);
  rejection(`{"thinking": "default"}`);
  rejection(`{"thinking": null}`);
});

test("a value of the wrong type is refused like one out of range", () => {
  rejection(`{"rounds": "3"}`);
  rejection(`{"rounds": null}`);
  rejection(`{"rounds": true}`);
  rejection(`{"timeout": null}`);
  rejection(`{"tokens": "150000"}`);
  rejection(`{"tokens": []}`);
  rejection(`{"thinking": 3}`);
  rejection(`{"thinking": true}`);
  rejection(`{"thinking": ["high"]}`);
});

// The error names the setting, the value given and what was expected. One
// saying only that the configuration is invalid is the failure this checks for.

test("no model is null, which leaves the reviewer on its CLI's own default", () => {
  assert.equal(load("{}").model, null);
  assert.equal(load(`{"rounds": 3}`).model, null);
});

test("model takes a name as each reviewer CLI spells one", () => {
  for (const name of [
    "gpt-5-mini",
    "openai/gpt-5-mini",
    "claude-opus-4.8",
    "us.anthropic.claude-opus-4-6-v1",
    "cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6",
    "openrouter/qwen/qwen3-coder:free",
    "Ring-2.6-1T",
  ]) {
    assert.equal(load(JSON.stringify({ model: name })).model, name);
  }
});

// The name reaches the reviewer CLI as one argument, and a pane's command line
// is a shell's, so anything a shell or an option parser would read is refused.
test("a model that is empty, or holds what could change the command line, is refused", () => {
  for (const name of [
    "",
    " ",
    " gpt-5-mini",
    "gpt-5-mini ",
    "gpt 5",
    "gpt-5-mini;rm -rf ~",
    "$(whoami)",
    "`id`",
    "gpt'5",
    `gpt"5`,
    "gpt-5\nmini",
    "--help",
    "-m",
    "a|b",
    "a&b",
    "a>b",
    "~/model",
    "x".repeat(201),
  ]) {
    assert.match(rejection(JSON.stringify({ model: name })).message, /"model" is .*, but it must be /u);
  }
  for (const contents of [`{"model": null}`, `{"model": 5}`, `{"model": ["gpt-5-mini"]}`]) {
    assert.match(rejection(contents).message, /"model" is .*, but it must be /u);
  }
});

test("every refusal names the setting, the value given and what was expected", () => {
  const cases: ReadonlyArray<{
    contents: string;
    setting: string;
    given: string;
    expected: RegExp;
  }> = [
    { contents: `{"reviewer": "claude"}`, setting: "reviewer", given: `"claude"`, expected: /"pi" or "copilot"/ },
    { contents: `{"reviewer": 1}`, setting: "reviewer", given: "1", expected: /"pi" or "copilot"/ },
    { contents: `{"rounds": 12}`, setting: "rounds", given: "12", expected: /whole number from 1 to 8/ },
    { contents: `{"rounds": "3"}`, setting: "rounds", given: `"3"`, expected: /whole number from 1 to 8/ },
    { contents: `{"timeout": 3601}`, setting: "timeout", given: "3601", expected: /seconds from 60 to 3,600/ },
    { contents: `{"timeout": 59}`, setting: "timeout", given: "59", expected: /seconds from 60 to 3,600/ },
    { contents: `{"timeout": null}`, setting: "timeout", given: "null", expected: /seconds from 60 to 3,600/ },
    { contents: `{"tokens": 20000000}`, setting: "tokens", given: "20000000", expected: /tokens from 100,000 to 10,000,000/ },
    { contents: `{"tokens": true}`, setting: "tokens", given: "true", expected: /tokens from 100,000 to 10,000,000/ },
    { contents: `{"thinking": "higher"}`, setting: "thinking", given: `"higher"`, expected: /"medium".*"high".*"xhigh"/ },
    { contents: `{"thinking": 3}`, setting: "thinking", given: "3", expected: /one of "off"/ },
    { contents: `{"model": "gpt 5"}`, setting: "model", given: `"gpt 5"`, expected: /model name/ },
    { contents: `{"model": ""}`, setting: "model", given: `""`, expected: /leave "model" out/ },
    { contents: `{"model": ".hidden"}`, setting: "model", given: `".hidden"`, expected: /starting with a letter, a digit or @/ },
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
  assert.match(error.message, /"reviewer", "rounds", "timeout", "tokens", "thinking" and "model"/);
});

test("a .squiz.json still setting test is refused like any other key that is not a setting", () => {
  const error = rejection(`{"test": "npm test"}`);
  assert.match(error.message, /"test" is not a setting, and the settings are "reviewer", "rounds", "timeout", "tokens", "thinking" and "model"$/u);
});

// What a project upgrading from the dollar bound meets. Silently ignoring it
// would leave someone believing a figure in dollars still bounded their episodes.
test("a .squiz.json still setting budget is refused, and the refusal lists the settings", () => {
  const error = rejection(`{"rounds": 3, "budget": 0.5}`);
  assert.match(error.message, /"budget" is not a setting/);
  assert.match(error.message, /"tokens"/);
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
