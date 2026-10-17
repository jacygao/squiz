/**
 * `squiz init`: link `squiz` onto `PATH` for the shells of coding agents that do
 * not put the plugin's `bin/` there, and allow the coding agent's three `squiz`
 * commands in Claude Code's user settings.
 *
 * The exit is the link's alone. Settings it could not change are reported on
 * stderr and leave the exit as the link set it.
 *
 * It never touches `AGENTS.md`. A section an earlier version appended there is
 * the host project's to keep or delete.
 */

import { allowSquizCommands } from "./claude-settings.ts";
import { linkOntoPath, type LinkEnvironment, type LinkPrinted } from "./path-link.ts";

/** Link `target` onto `PATH`, reading relative `PATH` entries from `directory`, and allow the commands under `HOME`. */
export function squizInit(directory: string, environment: LinkEnvironment, target: string): LinkPrinted {
  const linked = linkOntoPath(target, environment, directory);
  const allowed = allowSquizCommands(environment.HOME);
  return { stdout: linked.stdout + allowed.stdout, stderr: linked.stderr + allowed.stderr, exit: linked.exit };
}
