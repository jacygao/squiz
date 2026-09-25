/**
 * `pi`'s command line, and the tools it is granted at each depth.
 *
 * The grant is the confinement. `pi`'s own default set, used when no `--tools`
 * reaches it, is `read`, `bash`, `edit` and `write`, so a grant that goes
 * missing does not fall back to something safe: it hands the reviewer two
 * writers and a shell over the code it is reviewing. `--tools` is enforced by
 * filtering the registered tools, so a name outside the grant has no definition
 * and no implementation.
 *
 * The grant is also how the reviewer reports. The reporting calls are tools
 * like any other, and `--tools` filters them the same way, so a grant that does
 * not name them leaves the reviewer with nothing to report through and says
 * nothing about it.
 *
 * `--thinking` is on every command line, at both depths. Without it `pi` takes
 * the level from `~/.pi/agent/settings.json`, a file the harness does not own,
 * and the same change gets a different review on two machines. A level `pi` does
 * not recognise is warned about on stderr and otherwise ignored, so an
 * unchecked name leaves the level where it was and the round succeeds anyway.
 *
 * Nothing here runs a process.
 */

import { fileURLToPath } from "node:url";

import type { Depth } from "../../config/config.ts";
import type { CommandLine, Invocation } from "../adapter.ts";
import { reportingTools } from "./reporting.ts";

const readGrant = Object.freeze(["read", "grep", "find", "ls"] as const);

/**
 * The tools `pi` is given at each depth. `edit` and `write` are in neither.
 *
 * Every name is spelled once, and `deep` is the `read` grant plus the shell. An
 * unrecognised name is dropped with exit status 0 and empty stderr, so a
 * misspelling costs the reviewer a tool and says nothing.
 */
export const grants: Readonly<Record<Depth, readonly string[]>> = Object.freeze({
  read: Object.freeze([...readGrant, ...reportingTools]),
  // The shell is all `deep` adds, and it is the one granted tool that writes.
  deep: Object.freeze([...readGrant, ...reportingTools, "bash"]),
});

/**
 * The file `pi` loads the reporting calls from, which ships beside this.
 *
 * Absolute, and resolved against this module rather than the working directory,
 * because the reviewer runs in the tree under review and the harness runs from
 * wherever the runtime put it.
 */
export const extensionFile = fileURLToPath(new URL("extension.ts", import.meta.url));

/**
 * Build the command line for one round at the depth given.
 *
 * The caller starts the process, and owes it stdin from `/dev/null`: with stdin
 * inherited `pi` blocks forever, emitting no output, no error and no exit.
 */
export function argv(invocation: Invocation): CommandLine {
  return {
    command: "pi",
    directory: invocation.directory,
    args: [
      "--print",
      "--mode",
      "json",
      // Each round is a fresh process holding no state.
      "--no-session",
      // What pi writes lands under .squiz/ rather than in interactive history.
      "--session-dir",
      invocation.sessionDirectory,
      // Only the harness's own extension loads. Whatever the machine or the
      // tree under review has installed could otherwise register a tool of the
      // reporting calls' names and take the round's findings.
      "--no-extensions",
      "--extension",
      extensionFile,
      "--tools",
      grants[invocation.depth].join(","),
      "--thinking",
      invocation.thinking,
      "--append-system-prompt",
      invocation.charterFile,
      invocation.prompt,
    ],
  };
}
