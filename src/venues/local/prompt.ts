/**
 * The run's prompt: the first prompt a session in a worktree was given, which
 * describes the change where nobody wrote `description.md`.
 *
 * Only the first is kept. A later prompt in the same session, a second session,
 * or a resume asks for something narrower than the run did, and the fixer a
 * headless run hands its findings to has nothing else to tell what the run was
 * asked for. The prompt is kept apart from `description.md`, so that what a
 * caller wrote is never overwritten and always wins.
 *
 * Nothing here throws. Each failure comes back as a reason.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { makeStateDirectory } from "../../loop/state-directory.ts";
import type { Failed } from "../venue.ts";
import { localDirectory, place } from "./base.ts";

const PROMPT_FILE = "prompt.md";

/** Record `prompt` as `worktree`'s run's prompt, unless one is recorded already. `worktree` is a worktree's root. */
export function recordPrompt(worktree: string, prompt: string): { readonly outcome: "done" } | Failed {
  const local = localDirectory(worktree);
  try {
    makeStateDirectory(local);
  } catch (cause) {
    return failed(`${local} could not be made: ${messageOf(cause)}`);
  }
  return place(join(local, PROMPT_FILE), prompt);
}

/** The prompt recorded in `worktree`, or `null` where none is. */
export function readPrompt(worktree: string): string | null | Failed {
  const path = join(localDirectory(worktree), PROMPT_FILE);
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return null;
    return failed(`${path} could not be read: ${messageOf(cause)}`);
  }
}

function failed(reason: string): Failed {
  return { outcome: "failed", reason };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
