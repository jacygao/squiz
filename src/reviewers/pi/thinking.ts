/**
 * The thinking level `pi` runs a round at, which is not always the level the
 * round asked for.
 *
 * `pi` moves a level the model does not offer to the nearest level above it
 * that the model does, and says nothing. DeepSeek V4 Pro offers only off, high
 * and max, so `medium` runs at high. `pi` in RPC mode reports the level it
 * settled on, and the levels the model offers, before any prompt is sent, so
 * asking costs no model request.
 *
 * Nothing here throws.
 */

import { spawnSync } from "node:child_process";

import type { Thinking } from "../../config/config.ts";
import type { RunsAt, ThinkingAsked } from "../adapter.ts";

const LEVELS: readonly Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// Two commands and no prompt. `pi` exits once its stdin ends.
const ASKED = [
  JSON.stringify({ id: "levels", type: "get_available_thinking_levels" }),
  JSON.stringify({ id: "state", type: "get_state" }),
  "",
].join("\n");

/**
 * Start `pi` as a round would on `asked.model` with `asked.thinking`, untrusting
 * the project and keeping no session, and read back the level it settled on.
 */
export function runsAt(asked: ThinkingAsked): RunsAt {
  const ran = spawnSync(
    "pi",
    [
      "--mode",
      "rpc",
      "--no-session",
      "--no-approve",
      "--no-extensions",
      "--thinking",
      asked.thinking,
      ...(asked.model === null ? [] : ["--model", asked.model]),
    ],
    {
      cwd: asked.directory,
      env: asked.environment,
      input: ASKED,
      encoding: "utf8",
      timeout: asked.boundMs,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (ran.error !== undefined) {
    const code = "code" in ran.error ? ran.error.code : undefined;
    if (code === "ETIMEDOUT") return unknown(`pi did not answer within ${asked.boundMs / 1_000} seconds`);
    return unknown(`pi could not be started: ${ran.error.message}`);
  }
  if (ran.status !== 0) {
    const said = (ran.stderr.trim() || ran.stdout.trim()).split("\n", 1)[0] ?? "";
    const exit = ran.status === null ? `was killed by ${ran.signal ?? "a signal"}` : `exited ${ran.status}`;
    return unknown(said === "" ? `pi ${exit} and said nothing` : `pi ${exit}: ${said}`);
  }

  const answers = new Map<string, unknown>();
  for (const line of ran.stdout.split("\n")) {
    const answer = parsed(line);
    if (isRecord(answer) && typeof answer["id"] === "string" && answer["success"] === true) answers.set(answer["id"], answer["data"]);
  }
  const state = answers.get("state");
  const levels = answers.get("levels");
  const level = isRecord(state) ? state["thinkingLevel"] : undefined;
  const offered = isRecord(levels) ? levels["levels"] : undefined;
  if (typeof level !== "string" || !Array.isArray(offered)) return unknown("pi did not report its thinking level");
  const strange = [level, ...offered].find((each) => !isThinking(each));
  if (strange !== undefined) return unknown(`pi reported the thinking level ${JSON.stringify(strange)}, which squiz does not know`);
  return { outcome: "known", level: level as Thinking, offered: offered as Thinking[] };
}

function unknown(reason: string): RunsAt {
  return { outcome: "unknown", reason };
}

function parsed(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function isThinking(value: unknown): value is Thinking {
  return LEVELS.some((level) => level === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
