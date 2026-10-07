/**
 * `pi`'s command line, and the tools it is granted.
 *
 * The grant confines what the reviewer may call, and the extension where it may
 * read. `pi`'s own default set, used when no `--tools` reaches it, is `read`,
 * `bash`, `edit` and `write`, so a grant that goes missing does not fall back
 * to something safe: it offers the reviewer two writers and a shell over the
 * code it is reviewing, and only the extension's refusal of every tool outside
 * the grant it was handed stops them. `--tools` is enforced by
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
 * configuration, the model the review runs on and the system prompt the charter
 * is appended to among it. So `--no-approve` untrusts the project, and none of
 * its `.pi/` reaches `pi`. Its `AGENTS.md` or `CLAUDE.md` still does, because
 * `pi` loads a context file whatever the trust.
 *
 * `--thinking` is on every command line. Without it `pi` takes
 * the level from the user's own settings, which the harness does not choose, and
 * the same change gets a different review on two machines. A level `pi` does
 * not recognise is warned about on stderr and otherwise ignored, so an
 * unchecked name leaves the level where it was and the round succeeds anyway.
 *
 * Nothing here runs a process.
 */

import { fileURLToPath } from "node:url";

import type { CommandLine, Invocation } from "../adapter.ts";
import { historyTools } from "../git-tools.ts";
import { REPORTS_VARIABLE } from "../report-file.ts";
import { reportingTools } from "../reporting.ts";
import { GRANT_VARIABLE } from "./refusals.ts";

/**
 * The tools `pi` is given: the reading tools, the reporting calls and the
 * history tools. `edit`, `write` and `bash` are not among them.
 *
 * An unrecognised name is dropped with exit status 0 and empty stderr, so a
 * misspelling costs the reviewer a tool and says nothing.
 */
export const grants: readonly string[] = Object.freeze([
  "read",
  "grep",
  "find",
  "ls",
  ...reportingTools,
  ...historyTools.map((tool) => tool.name),
]);

/**
 * The file `pi` loads the reporting calls from, which ships beside this.
 *
 * Absolute, and resolved against this module rather than the working directory,
 * because the reviewer runs in the tree under review and the harness runs from
 * wherever the runtime put it.
 */
export const extensionFile = fileURLToPath(new URL("extension.ts", import.meta.url));

/**
 * Build the command line for one round, for a reviewer in a pane or one with no
 * terminal.
 *
 * In a pane `pi` runs interactively, with the pane as its terminal. With no
 * terminal it runs in print mode, and its stdin must be `/dev/null`: with stdin
 * inherited, `pi --print` blocks forever, emitting no output, no error and no
 * exit. Nothing else differs between the two.
 */
export function argv(invocation: Invocation): CommandLine {
  const detached = invocation.terminal === "none";
  // The extension refuses whatever this leaves out, so it is handed the very
  // list --tools is, and the two cannot name different tools.
  const grant = grants.join(",");
  return {
    command: "pi",
    directory: invocation.directory,
    stdin: detached ? "/dev/null" : "terminal",
    environment: { [REPORTS_VARIABLE]: invocation.reportsFile, [GRANT_VARIABLE]: grant },
    args: [
      // Nothing reads pi's output, so print mode needs no event stream.
      ...(detached ? ["--print"] : []),
      // The session is kept so a person can resume it, under .squiz/ rather
      // than in the user's own history. Nothing of it reaches the next round,
      // which starts a fresh process.
      "--session-dir",
      invocation.sessionDirectory,
      "--no-approve",
      // Only the harness's own extension loads. Whatever the machine or the
      // tree under review has installed could otherwise register a tool of the
      // reporting calls' names and take the round's findings.
      "--no-extensions",
      "--extension",
      extensionFile,
      "--tools",
      grant,
      "--thinking",
      invocation.thinking,
      // Always `provider/id` as `pi --list-models` lists it, which `confine`
      // checks, so `pi` matches it exactly rather than by part of a name.
      ...(invocation.model === null ? [] : ["--model", invocation.model]),
      "--append-system-prompt",
      invocation.charterFile,
      // `pi` reads an `@` argument's file into the first message, wrapped in a
      // `<file>` tag, and exits 1 where the file is missing. The prompt itself
      // would put its newlines on the command line, which Herdr refuses.
      `@${invocation.promptFile}`,
    ],
  };
}
