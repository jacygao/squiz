/**
 * What a `pi` round is checked for before it starts: that the configured model is
 * one `pi` offers, under the name `pi` matches exactly.
 *
 * `pi --model` takes a name it does not have as part of one, and runs on
 * whichever model's name contains it. So a configured model must be `provider/id`
 * exactly as `pi --list-models` lists it, and anything else fails the round
 * before `pi` starts.
 *
 * Nothing here throws. Every outcome is a value the caller reads.
 */

import { spawnSync } from "node:child_process";

import type { Confinement, Invocation } from "../adapter.ts";

// Listing reads the user's model catalogue and makes no model request.
const LIST_TIMEOUT_MS = 30_000;

/**
 * Check the configured model against what `pi` lists, run as the round runs it.
 * `environment` is the round host's own, where `pi` and its credentials are
 * found. `pi` is handed nothing outside its command line, so a round that passes
 * adds nothing to its environment.
 */
export function confine(invocation: Invocation, environment: NodeJS.ProcessEnv = process.env): Confinement {
  const model = invocation.model;
  if (model === null) return { outcome: "prepared", environment: {} };

  const listed = listedModels(invocation.directory, environment);
  if (typeof listed === "string") return { outcome: "failed", reason: listed };
  if (listed.includes(model)) return { outcome: "prepared", environment: {} };

  const named = listed.filter((name) => name.slice(name.indexOf("/") + 1) === model);
  const instead =
    named.length === 1
      ? `; write it as "${named[0]}", the provider and model as pi lists them`
      : "; it must be a provider and model as pi --list-models lists them, such as \"openai/gpt-5-mini\"";
  return {
    outcome: "failed",
    reason: `"model" in .squiz.json is "${model}", which is not a model pi offers${instead}`,
  };
}

/** Every model `pi` lists, as `provider/id`, or why they could not be listed. */
function listedModels(directory: string, environment: NodeJS.ProcessEnv): readonly string[] | string {
  const ran = spawnSync("pi", ["--no-approve", "--no-extensions", "--list-models"], {
    cwd: directory,
    env: { ...environment, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: LIST_TIMEOUT_MS,
  });
  if (ran.error !== undefined) return `pi --list-models could not run to check "model": ${ran.error.message}`;
  if (ran.status !== 0) {
    const said = ran.stderr.trim();
    return `pi --list-models exited ${ran.status ?? ran.signal} checking "model"${said === "" ? "" : `, and said: ${said}`}`;
  }
  // One row a model, its first two columns the provider and the id, under a header.
  return ran.stdout
    .split("\n")
    .slice(1)
    .map((row) => row.trim().split(/\s+/u))
    .filter((columns) => columns.length >= 2)
    .map(([provider, id]) => `${provider}/${id}`);
}
