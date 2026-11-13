/**
 * The fixer: the headless coding agent the round host starts on a round's
 * handoff, in the change's worktree, where `.squiz.json` names one. It starts
 * in a session squiz names, which each later round of the episode resumes.
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

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FixerAgent } from "../config/config.ts";
import { COPILOT_QUIET_FLAGS } from "../sessions/copilot-settings.ts";
import { startDetached, type Detached } from "../sessions/detach.ts";

// The checkout or installed copy this module runs from: the plugin whose hooks start the next round.
const PLUGIN_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export type FixerSpec = {
  readonly agent: FixerAgent;
  /** The commands it may run beyond `squiz` and `git`: `.squiz.json`'s `fixerCommands`. */
  readonly commands: readonly string[];
  /** The absolute path of the round's `handoff.md`. */
  readonly handoff: string;
  readonly worktree: string;
  /** Where the fixer's output goes, opened for appending. Its directory must exist. */
  readonly logPath: string;
  /** The environment `fixerEnvironment` makes the fixer's from: the round host's own. */
  readonly environment: NodeJS.ProcessEnv;
  /** The session it starts, or resumes where `resume` is given. */
  readonly session: string;
  /** For a resume: the round's update, and where the CLI's exit status goes. */
  readonly resume?: { readonly update: string; readonly exitPath: string };
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
    WORK,
    ...FIX_RULES,
  ].join("\n\n");
}

/** What a resumed fixer is asked to do: work what changed since its last handoff, which `update` holds. */
export function resumePrompt(update: string, handoff: string): string {
  return [
    `Squiz reviewed your work again and left threads open. ${update} holds what changed since your last handoff: the threads opened since, the replies and rulings posted since, and the threads closed since. ${handoff} holds the whole handoff again, should you need it.`,
    WORK,
    ...FIX_RULES,
  ].join("\n\n");
}

const WORK =
  "Work the threads as it says: fix what applies, and reply on each one to say what you changed or why you disagree. Do not run `squiz review`: squiz reviews your work again when you finish.";

const FIX_RULES = [
  "- Before changing code, check that the finding holds. Where it does not, change nothing for it, and say why in your reply.",
  "- Name the invariant each finding breaks, and every place in the changed area where it must hold. Fix it at all of them, with the same small correction or at the one boundary they share, not only where the finding points.",
  "- Add no machinery: no new handling, state, fallback, retry or subsystem to manage a symptom.",
  "- Make every edit first. Then re-trace the failing sequence each finding describes through the code as it now is, and the ordinary path through every function you changed and its callers, and remove anything your fix left unreachable.",
  "- Then run one focused check of the changed area, such as the test file you touched, rather than the whole suite. Where you cannot run it, say so in your reply.",
];

/** The session a fixer runs in: started under `id`, or resumed by it. */
export type SessionStart = { readonly id: string; readonly resume: boolean };

/** A new session id. Both CLIs take only a UUID. */
export function newSessionId(): string {
  return randomUUID();
}

/**
 * The command line that starts `agent` headless on `prompt` in `session`,
 * loading squiz from `root`.
 *
 * It may edit files and run `squiz`, `git` and each of `commands`, and nothing
 * asks it anything, because nobody is there to answer. Each command is granted
 * by its name alone, so it runs with any arguments. A resume inherits none of
 * this, so it gets the same line.
 */
export function fixerCommand(
  agent: FixerAgent,
  prompt: string,
  root: string,
  commands: readonly string[],
  session: SessionStart,
): { readonly command: string; readonly args: readonly string[] } {
  const granted = ["squiz", "git", ...commands];
  switch (agent) {
    case "claude":
      // The prompt follows -p at once: `--allowedTools` takes every argument after it.
      return {
        command: "claude",
        args: [
          "-p",
          prompt,
          session.resume ? "--resume" : "--session-id",
          session.id,
          "--plugin-dir",
          root,
          "--permission-mode",
          "acceptEdits",
          "--allowedTools",
          ...granted.map((name) => `Bash(${name}:*)`),
        ],
      };
    case "copilot":
      // `--session-id` resumes a session it finds, and starts one where it finds none, so only `--resume` fails on an unknown id.
      return {
        command: "copilot",
        args: [
          "-p",
          prompt,
          session.resume ? `--resume=${session.id}` : `--session-id=${session.id}`,
          "--plugin-dir",
          root,
          "--no-ask-user",
          "--allow-tool=write",
          ...granted.map((name) => `--allow-tool=shell(${name})`),
          ...COPILOT_QUIET_FLAGS,
        ],
      };
  }
}

/**
 * Set in the fixer's environment, which both CLIs hand on to its hooks. The
 * fixer's prompt is squiz's, and a hook that recorded it would describe the
 * run's change by it.
 */
export const FIXER_VARIABLE = "SQUIZ_FIXER";

/**
 * The fixer's environment: the round host's, without the messaging socket of
 * the session whose hook started the host, and with `FIXER_VARIABLE` set. The
 * fixer's own hook would record that socket as the fixer's, and it names a
 * session that has ended.
 */
export function fixerEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { CLAUDE_CODE_MESSAGING_SOCKET: _socket, ...kept } = environment;
  return { ...kept, [FIXER_VARIABLE]: "1" };
}

/**
 * Start the fixer `spec` describes, detached, and say what started. `boundMs`
 * bounds the start.
 *
 * A resume runs under `/bin/sh`, which writes the CLI's exit status to
 * `resume.exitPath` when it ends. Both CLIs exit 1 at once on a session they
 * cannot find, before any stop fires, so the status is the only sign a resume
 * failed. The process started, and recorded, is that shell.
 */
export function startFixer(spec: FixerSpec, boundMs: number): Detached {
  const prompt = spec.resume === undefined ? fixerPrompt(spec.handoff) : resumePrompt(spec.resume.update, spec.handoff);
  const { command, args } = fixerCommand(spec.agent, prompt, PLUGIN_ROOT, spec.commands, { id: spec.session, resume: spec.resume !== undefined });
  const env = fixerEnvironment(spec.environment);
  if (spec.resume === undefined) return startDetached({ command, args, cwd: spec.worktree, logPath: spec.logPath, env }, boundMs);
  const wrapped = ["-c", '"$@"; printf "%s\\n" "$?" > "$0"', spec.resume.exitPath, command, ...args];
  return startDetached({ command: "/bin/sh", args: wrapped, cwd: spec.worktree, logPath: spec.logPath, env }, boundMs);
}
