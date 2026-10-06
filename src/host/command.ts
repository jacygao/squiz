/**
 * `squiz host <number>`: the round host as a command, run in the worktree it
 * serves.
 *
 * It answers nothing on stdout. What it did goes to the episode's host.log, and
 * only a host that never started says why on stderr.
 */

import { fileURLToPath } from "node:url";

import { loadConfig } from "../config/config.ts";
import { reportFailure } from "../hook/report.ts";
import type { HookExit } from "../hook/trap.ts";
import { adapterFor } from "../reviewers/adapters.ts";
import { worktreeToplevel } from "../worktree/toplevel.ts";
import { runHost } from "./host.ts";

// The charter ships beside the code, so it is found from this file rather than
// from a working directory that belongs to the project under review.
const charterFile = fileURLToPath(new URL("../../charter.md", import.meta.url));

const numberSpelling = /^[1-9][0-9]*$/u;

/** Run the host for the pull request `args` names, in the worktree `directory` is in. */
export async function hostCommand(args: readonly string[], directory: string): Promise<HookExit> {
  const named = args[0] ?? "";
  const pullRequest = Number(named);
  if (args.length !== 1 || !numberSpelling.test(named) || !Number.isSafeInteger(pullRequest)) {
    reportFailure("no round host started: squiz host <number>, where <number> is the pull request's");
    return 0;
  }

  const worktree = worktreeToplevel(directory);
  if (worktree.outcome === "failed") {
    reportFailure(`no round host started: the worktree could not be resolved: ${worktree.reason}`);
    return 0;
  }

  let config;
  try {
    config = loadConfig(worktree.path);
  } catch (cause) {
    // The settings refuse a value they cannot use by throwing.
    reportFailure(`no round host started: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 0;
  }

  // The trigger that started the host ran in the coding agent's terminal, and
  // its environment names the Herdr or tmux server the reviewer's pane opens on.
  await runHost({
    worktree: worktree.path,
    pullRequest,
    round: { config, adapter: adapterFor(config.reviewer), charterFile, sessionEnvironment: process.env },
  });
  return 0;
}
