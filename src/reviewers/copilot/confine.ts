/**
 * What a Copilot round is handed outside its command line: a `COPILOT_HOME` of
 * its own, holding the agent whose instructions are the charter, and the
 * variables that keep the project and the user out.
 *
 * **`COPILOT_HOME` is the round's session directory, and holds no trusted
 * folders.** Copilot runs a project's hooks and MCP servers only in a folder it
 * trusts, and a user who trusted any folder above the snapshots would have
 * trusted every one of them. Under a home of the round's own Copilot trusts nothing. The
 * credential is in the system's credential store, so the reviewer still signs
 * in. Nothing else of the user's configuration reaches the reviewer except its
 * model.
 *
 * Nothing here throws. Every outcome is a value the caller reads.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { Confinement, Invocation } from "../adapter.ts";
import { AGENT_NAME } from "./argv.ts";

/**
 * Prepare the round's `COPILOT_HOME`, and say what to add to Copilot's
 * environment. `environment` is the round host's own, where the user's
 * Copilot settings and default model are found.
 */
export function confine(invocation: Invocation, environment: NodeJS.ProcessEnv = process.env): Confinement {
  const model = modelOf(environment);
  if (typeof model === "object") return { outcome: "failed", reason: model.problem };

  let charter: string;
  try {
    charter = readFileSync(invocation.charterFile, "utf8");
  } catch (cause) {
    return { outcome: "failed", reason: `the charter ${invocation.charterFile} could not be read: ${reasonFor(cause)}` };
  }

  const home = resolve(invocation.directory, invocation.sessionDirectory);
  const agents = join(home, "agents");
  try {
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, `${AGENT_NAME}.agent.md`), agentFile(charter), "utf8");
  } catch (cause) {
    return { outcome: "failed", reason: `the reviewer's agent could not be written to ${agents}: ${reasonFor(cause)}` };
  }

  return {
    outcome: "prepared",
    environment: {
      COPILOT_HOME: home,
      // Exactly `true` would trust the tree under review whatever COPILOT_HOME
      // holds. Copilot reads empty as off, where an unset variable would leave
      // whatever the round host inherited.
      COPILOT_ALLOW_ALL: "",
      // Set even where the host carries it, because a pane runs with its
      // server's environment rather than the host's.
      ...(model === undefined ? {} : { COPILOT_MODEL: model }),
    },
  };
}

/** The agent Copilot loads from `<COPILOT_HOME>/agents/`, its body the charter. */
function agentFile(charter: string): string {
  return `---\nname: ${AGENT_NAME}\ndescription: Reviews a pull request for squiz.\n---\n\n${charter}`;
}

/**
 * The user's default model: the host's `COPILOT_MODEL`, or else `model` in the
 * user's own `settings.json`. `undefined` where the user has neither.
 */
function modelOf(environment: NodeJS.ProcessEnv): string | undefined | { readonly problem: string } {
  const set = environment["COPILOT_MODEL"];
  if (set !== undefined && set.trim() !== "") return set;

  const theirs = environment["COPILOT_HOME"];
  const directory =
    theirs !== undefined && theirs.trim() !== ""
      ? resolve(theirs)
      : join(environment["HOME"] ?? homedir(), ".copilot");
  const file = join(directory, "settings.json");

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (cause) {
    if (codeOf(cause) === "ENOENT") return undefined;
    return { problem: `the user's Copilot settings ${file} could not be read: ${reasonFor(cause)}` };
  }
  let settings: unknown;
  try {
    // Copilot heads the files it manages with `//` lines, which JSON does not allow.
    settings = JSON.parse(text.replace(/^\s*\/\/.*$/gmu, ""));
  } catch (cause) {
    return { problem: `the user's Copilot settings ${file} are not JSON: ${reasonFor(cause)}` };
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return { problem: `the user's Copilot settings ${file} are not an object` };
  }
  const model = (settings as Record<string, unknown>)["model"];
  return typeof model === "string" && model.trim() !== "" ? model : undefined;
}

function codeOf(cause: unknown): unknown {
  return typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
