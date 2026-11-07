/**
 * `squiz host <key>`: the round host as a command, run in the worktree it
 * serves. The GitHub venue's key is the pull request's number.
 *
 * It answers nothing on stdout. What it did goes to the episode's host.log, and
 * only a host that never started says why on stderr.
 */

import { fileURLToPath } from "node:url";

import { defaultsLine, findProjectConfig } from "../config/config.ts";
import { reportFailure } from "../hook/report.ts";
import type { HookExit } from "../hook/trap.ts";
import { adapterFor } from "../reviewers/adapters.ts";
import { venueFor } from "../venues/venue.ts";
import { worktreeToplevel } from "../worktree/toplevel.ts";
import { runHost } from "./host.ts";

// The charter ships beside the code, so it is found from this file rather than
// from a working directory that belongs to the project under review.
const charterFile = fileURLToPath(new URL("../../charter.md", import.meta.url));

/** Run the host for the change whose key `args` names, in the worktree `directory` is in. */
export async function hostCommand(args: readonly string[], directory: string): Promise<HookExit> {
  const [key] = args;
  if (args.length !== 1 || key === undefined) {
    reportFailure("no round host started: squiz host <number>, where <number> is the pull request's");
    return 0;
  }

  const worktree = worktreeToplevel(directory);
  if (worktree.outcome === "failed") {
    reportFailure(`no round host started: the worktree could not be resolved: ${worktree.reason}`);
    return 0;
  }

  let project;
  try {
    project = findProjectConfig(worktree.path);
  } catch (cause) {
    // The settings refuse a value they cannot use by throwing.
    reportFailure(`no round host started: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 0;
  }
  const { config } = project;

  const chosen = venueFor(process.env);
  if (chosen.outcome === "failed") {
    reportFailure(`no round host started: ${chosen.reason}`);
    return 0;
  }

  const note = defaultsLine(project);
  // The trigger that started the host ran in the coding agent's terminal, and
  // its environment names the Herdr or tmux server the reviewer's pane opens on.
  const ended = await runHost({
    worktree: worktree.path,
    key,
    round: {
      venue: chosen.venue,
      config,
      adapter: adapterFor(config.reviewer),
      charterFile,
      sessionEnvironment: process.env,
    },
    ...(note === undefined ? {} : { note }),
  });
  if (ended.outcome === "no episode") reportFailure(`no round host started: ${ended.reason}`);
  return 0;
}
