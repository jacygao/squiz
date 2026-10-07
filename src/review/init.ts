/**
 * `squiz init`: link `squiz` onto `PATH` for the shells of coding agents that do
 * not put the plugin's `bin/` there.
 *
 * It never touches `AGENTS.md`. A section an earlier version appended there is
 * the host project's to keep or delete.
 */

import { linkOntoPath, type LinkEnvironment, type LinkPrinted } from "./path-link.ts";

/** Link `target` onto `PATH`, reading relative `PATH` entries from `directory`. */
export function squizInit(directory: string, environment: LinkEnvironment, target: string): LinkPrinted {
  return linkOntoPath(target, environment, directory);
}
