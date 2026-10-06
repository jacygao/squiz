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
 * **The tree under review does not configure the reviewer.** `pi` reads a
 * project's own `.pi/settings.json` over the user's global settings wherever the
 * project is trusted, and a trust decision saved against any directory above the
 * worktree trusts it. What a tree could set there is the whole of the
 * configuration: the shell command prefix the round delivers its recording line
 * in, the model the review runs on, and the prompt the charter is appended to. So
 * `--no-approve` untrusts the project, and nothing of the tree's reaches `pi`. The
 * prefix the project configured is carried forward by `confine`, which resolves it
 * itself; nothing else of the project's applies.
 *
 * `--thinking` is on every command line, at both depths. Without it `pi` takes
 * the level from the user's own settings, which the harness does not choose, and
 * the same change gets a different review on two machines. A level `pi` does
 * not recognise is warned about on stderr and otherwise ignored, so an
 * unchecked name leaves the level where it was and the round succeeds anyway.
 *
 * Nothing here runs a process.
 */

import { fileURLToPath } from "node:url";

import type { Depth } from "../../config/config.ts";
import type { CommandLine, Invocation } from "../adapter.ts";
import { deepToolNames } from "../deep-tools.ts";
import { REPORTS_VARIABLE } from "../report-file.ts";
import { reportingTools } from "../reporting.ts";

const readGrant = Object.freeze(["read", "grep", "find", "ls"] as const);

/**
 * The tools `pi` is given at each depth. `edit`, `write` and `bash` are in
 * neither.
 *
 * Every name is spelled once, and `deep` is the `read` grant plus the tools the
 * extension serves for it. An unrecognised name is dropped with exit status 0
 * and empty stderr, so a misspelling costs the reviewer a tool and says nothing.
 */
export const grants: Readonly<Record<Depth, readonly string[]>> = Object.freeze({
  read: Object.freeze([...readGrant, ...reportingTools]),
  deep: Object.freeze([...readGrant, ...reportingTools, ...deepToolNames]),
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
 * Build the command line for one round at the depth given, for a reviewer in a
 * pane or one with no terminal.
 *
 * In a pane `pi` runs interactively, with the pane as its terminal. With no
 * terminal it runs in print mode, and its stdin must be `/dev/null`: with stdin
 * inherited, `pi --print` blocks forever, emitting no output, no error and no
 * exit. Nothing else differs between the two.
 */
export function argv(invocation: Invocation): CommandLine {
  const detached = invocation.terminal === "none";
  return {
    command: "pi",
    directory: invocation.directory,
    stdin: detached ? "/dev/null" : "terminal",
    environment: { [REPORTS_VARIABLE]: invocation.reportsFile },
    args: [
      // Nothing reads pi's output, so print mode needs no event stream.
      ...(detached ? ["--print"] : []),
      // The session is kept so a person can resume it, under .squiz/ rather
      // than in the user's own history. Nothing of it reaches the next round,
      // which starts a fresh process.
      "--session-dir",
      invocation.sessionDirectory,
      // The tree under review is not trusted to configure the reviewer. A
      // project prefix of its own would otherwise replace the one the round
      // delivers its recording line in, and every tool the reviewer detached
      // would be beyond the round's reach with nothing saying so.
      "--no-approve",
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
      // `pi` reads an `@` argument's file into the first message, wrapped in a
      // `<file>` tag, and exits 1 where the file is missing. The prompt itself
      // would put its newlines on the command line, which Herdr refuses.
      `@${invocation.promptFile}`,
    ],
  };
}
