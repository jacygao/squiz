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
 * Nothing here runs a process.
 */

import type { Depth } from "../../config/config.ts";
import type { CommandLine, Invocation } from "../adapter.ts";

const readGrant = Object.freeze(["read", "grep", "find", "ls"] as const);

/**
 * The tools `pi` is given at each depth. `edit` and `write` are in neither.
 *
 * Every name is spelled once, and `deep` is the `read` grant plus the shell. An
 * unrecognised name is dropped with exit status 0 and empty stderr, so a
 * misspelling costs the reviewer a tool and says nothing.
 */
export const grants: Readonly<Record<Depth, readonly string[]>> = Object.freeze({
  read: readGrant,
  // The shell is all `deep` adds, and it is the one granted tool that writes.
  deep: Object.freeze([...readGrant, "bash"]),
});

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
      "--tools",
      grants[invocation.depth].join(","),
      "--append-system-prompt",
      invocation.charterFile,
      invocation.prompt,
    ],
  };
}
