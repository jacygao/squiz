/**
 * The fixer: a fresh headless coding agent the round host starts on a round's
 * handoff, in the change's worktree, where `.squiz.json` names one.
 *
 * Its own stop fires squiz's hook as any run's does, and that stop is what
 * starts the next round. A new run inherits no plugin directory from the run
 * before it, so the fixer is handed the plugin directory of the squiz that
 * starts it. Without it no hook fires, nothing starts the next round, and the
 * episode stays open with nothing saying why.
 *
 * It is started detached, as the round host is, so it outlives the host that
 * started it. Nothing here throws.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FixerAgent } from "../config/config.ts";
import { COPILOT_QUIET_FLAGS } from "../reviewers/copilot/argv.ts";
import { startDetached, type Detached } from "../sessions/detach.ts";

// The checkout or installed copy this module runs from: the plugin whose hooks start the next round.
const PLUGIN_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export type FixerSpec = {
  readonly agent: FixerAgent;
  /** The absolute path of the round's `handoff.md`. */
  readonly handoff: string;
  readonly worktree: string;
  /** Where the fixer's output goes, opened for appending. Its directory must exist. */
  readonly logPath: string;
  /** The environment `fixerEnvironment` makes the fixer's from: the round host's own. */
  readonly environment: NodeJS.ProcessEnv;
};

/**
 * What the fixer is asked to do.
 *
 * The handoff ends with the venue's follow-up, which asks for `squiz review`.
 * A fixer that ran it would wait on a round it then works itself, beside the
 * fixer that round's host starts, so the prompt rules it out.
 */
export function fixerPrompt(handoff: string): string {
  return [
    `Squiz reviewed this change and left threads open. ${handoff} holds them, each with every reply on it, with the change's description, the agents' final reports and the diff the reviewer read.`,
    "Work the threads as it says: fix what applies, and reply on each one to say what you changed or why you disagree. Do not run `squiz review`: squiz reviews your work again when you finish.",
  ].join("\n\n");
}

/**
 * The command line that starts `agent` headless on `prompt`, loading squiz from
 * `root`.
 *
 * It may edit files and run `squiz` and `git`, and nothing asks it anything,
 * because nobody is there to answer.
 */
export function fixerCommand(agent: FixerAgent, prompt: string, root: string): { readonly command: string; readonly args: readonly string[] } {
  switch (agent) {
    case "claude":
      // The prompt follows -p at once: `--allowedTools` takes every argument after it.
      return {
        command: "claude",
        args: ["-p", prompt, "--plugin-dir", root, "--permission-mode", "acceptEdits", "--allowedTools", "Bash(squiz:*)", "Bash(git:*)"],
      };
    case "copilot":
      return {
        command: "copilot",
        args: ["-p", prompt, "--plugin-dir", root, "--no-ask-user", "--allow-tool=write", "--allow-tool=shell(squiz)", "--allow-tool=shell(git)", ...COPILOT_QUIET_FLAGS],
      };
  }
}

/**
 * The fixer's environment: the round host's, without the messaging socket of
 * the session whose hook started the host. The fixer's own hook would record
 * that socket as the fixer's, and it names a session that has ended.
 */
export function fixerEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { CLAUDE_CODE_MESSAGING_SOCKET: _socket, ...kept } = environment;
  return kept;
}

/** Start the fixer `spec` describes, detached, and say what started. `boundMs` bounds the start. */
export function startFixer(spec: FixerSpec, boundMs: number): Detached {
  const { command, args } = fixerCommand(spec.agent, fixerPrompt(spec.handoff), PLUGIN_ROOT);
  return startDetached({ command, args, cwd: spec.worktree, logPath: spec.logPath, env: fixerEnvironment(spec.environment) }, boundMs);
}
