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

/** What the harness hands the reviewer for one round. */
export type Invocation = {
  /**
   * The git work tree holding the change under review. `pi` runs with this as
   * its current directory.
   */
  readonly directory: string;
  /** The charter file, whose contents `pi` appends to its system prompt. */
  readonly charterFile: string;
  /** The task prompt, carrying the pull request and the threads already on it. */
  readonly prompt: string;
  readonly sessionDirectory: string;
  /**
   * How much the reviewer is allowed to do. The harness decides it; the adapter
   * turns it into the grant and never chooses a value of its own.
   */
  readonly depth: Depth;
};

/** A process to start: what to run, what to pass it, and where it runs. */
export type CommandLine = {
  readonly command: string;
  readonly args: readonly string[];
  readonly directory: string;
};

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
