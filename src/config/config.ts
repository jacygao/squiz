/**
 * The `.squiz.json` loader: the five settings, their defaults and their ranges.
 * A project that writes no file runs on the defaults, and a value outside its
 * range is refused rather than replaced.
 * (review-harness-spec, "Configuration")
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const configFileName = ".squiz.json";

/**
 * The two grants a reviewer can be given. A union of string literals stands
 * where an enum would: Node cannot strip an enum.
 * (review-harness-spec, "Depth" and "Language")
 */
export type Depth = "read" | "deep";

export type Config = {
  // The round cap. (review-harness-spec, "The round cap")
  rounds: number;
  // `deep` adds the shell. (review-harness-spec, "Depth")
  depth: Depth;
  /**
   * The non-mutating command that runs the tests, read only at depth `deep`.
   * `null` where the file names none, so a caller can tell "no test command"
   * from a command that runs and does nothing.
   */
  test: string | null;
  // Seconds one round's reviewer may run. (review-harness-spec, "The review budget")
  timeout: number;
  // Dollars an episode may cost. (review-harness-spec, "The review budget")
  budget: number;
};

// Every setting has a default, so a project that writes no file still runs.
// (review-harness-spec, "Configuration")
export const defaultConfig: Readonly<Config> = Object.freeze({
  rounds: 3,
  depth: "read",
  test: null,
  timeout: 420,
  budget: 0.1,
});

/**
 * A `.squiz.json` that cannot be read or parsed, or that holds a value the
 * settings table does not give it.
 *
 * This is a failure the harness controls, so the round exits 0 and the hook's
 * stderr names it rather than the throw reaching the coding agent.
 * (review-harness-spec, "Failure modes")
 */
export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
  }
}

const settingNames = ["rounds", "depth", "test", "timeout", "budget"] as const;

const settingList = `"rounds", "depth", "test", "timeout" and "budget"`;

const depths = ["read", "deep"] as const;

/**
 * Reads `.squiz.json` from the root of the repository. Its absence is not an
 * error: it yields the defaults. Every other way of failing throws a
 * `ConfigError` naming the setting, the value given and what was expected.
 */
export function loadConfig(repositoryRoot: string): Config {
  const path = join(repositoryRoot, configFileName);
  const source = read(path);
  if (source === null) return { ...defaultConfig };
  return parse(source, path);
}

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    // Only a missing file means "no configuration". A file that is there and
    // cannot be read is a failure, and must not read as an empty one.
    if (isMissing(cause)) return null;
    throw new ConfigError(`${path} could not be read: ${reasonFor(cause)}`, { cause });
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function parse(source: string, path: string): Config {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new ConfigError(`${path} is not valid JSON: ${reasonFor(cause)}`, { cause });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(
      `${path} must hold a JSON object, but it holds ${render(parsed)}`,
    );
  }

  const raw = parsed as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!isSettingName(key)) {
      throw new ConfigError(
        `${path}: "${key}" is not a setting, and the settings are ${settingList}`,
      );
    }
  }

  // Presence is decided by whether the key is there, never by whether its value
  // is truthy. `0` is a value a person wrote, and it is refused as out of range
  // rather than replaced by the default.
  return {
    rounds: has(raw, "rounds")
      ? wholeNumber(path, "rounds", raw["rounds"], 1, 8, "a whole number from 1 to 8")
      : defaultConfig.rounds,
    depth: has(raw, "depth") ? depthOf(path, raw["depth"]) : defaultConfig.depth,
    test: has(raw, "test") ? testCommandOf(path, raw["test"]) : defaultConfig.test,
    timeout: has(raw, "timeout")
      ? wholeNumber(
          path,
          "timeout",
          raw["timeout"],
          1,
          480,
          "a whole number of seconds from 1 to 480",
        )
      : defaultConfig.timeout,
    budget: has(raw, "budget") ? budgetOf(path, raw["budget"]) : defaultConfig.budget,
  };
}

function has(raw: Record<string, unknown>, setting: string): boolean {
  return Object.hasOwn(raw, setting);
}

function isSettingName(key: string): boolean {
  return (settingNames as readonly string[]).includes(key);
}

function wholeNumber(
  path: string,
  setting: string,
  value: unknown,
  low: number,
  high: number,
  expected: string,
): number {
  // `Number.isInteger` refuses NaN, the infinities and a fractional count, and
  // the bounds are inclusive on both sides.
  if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high) {
    throw new ConfigError(reject(path, setting, value, expected));
  }
  return value;
}

function budgetOf(path: string, value: unknown): number {
  // Above 0 rather than from 0: a budget of 0 buys no round at all.
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 5) {
    throw new ConfigError(
      reject(path, "budget", value, "a number of dollars above 0 and at most 5"),
    );
  }
  return value;
}

function depthOf(path: string, value: unknown): Depth {
  for (const depth of depths) {
    if (value === depth) return depth;
  }
  throw new ConfigError(reject(path, "depth", value, `"read" or "deep"`));
}

function testCommandOf(path: string, value: unknown): string {
  // An empty command is one that runs and does nothing, which is not the same
  // as running no tests. Absence is how a project says it has none.
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(
      reject(
        path,
        "test",
        value,
        `a command to run; leave "test" out for no test command`,
      ),
    );
  }
  return value;
}

function reject(path: string, setting: string, value: unknown, expected: string): string {
  return `${path}: "${setting}" is ${render(value)}, but it must be ${expected}`;
}

/** Shows the value as it was written, so a string is quoted and a number is not. */
function render(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}
