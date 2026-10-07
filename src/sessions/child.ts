/**
 * Start a command as a child of the caller, with no terminal.
 *
 * The child leads a process group of its own, so that stopping the group stops
 * whatever the command started. It stays the caller's child: the caller reads
 * its output, waits for it and reaps it through the handle this returns.
 *
 * **Its standard input is `/dev/null`.** A command reading an inherited stdin
 * would wait on it forever and say nothing, which looks exactly like a command
 * at work. Its stdout and stderr are pipes the caller must drain, since a full
 * pipe stops the process writing to it.
 *
 * Nothing here throws. Every answer is a value the caller reads.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { identityOf, type IdentityRead, type ProcessIdentity } from "./process.ts";

export type ChildCommand = {
  readonly program: string;
  readonly arguments: readonly string[];
  readonly directory: string;
};

export type ChildProcessHandle = ChildProcessByStdio<null, Readable, Readable>;

/**
 * `failed`: nothing is left running. `ran` is there where the command ran
 * before it was stopped, so whatever it did meanwhile is done.
 */
export type ChildStart =
  | { readonly outcome: "started"; readonly identity: ProcessIdentity; readonly child: ChildProcessHandle }
  | { readonly outcome: "failed"; readonly reason: string; readonly ran?: true };

/**
 * Start `command` in `environment`, which is its whole environment.
 *
 * `boundMs` bounds the `ps` that reads the child's identity, which `identify`
 * reads where it is given.
 */
export async function startChild(
  command: ChildCommand,
  environment: NodeJS.ProcessEnv,
  boundMs: number,
  identify: (pid: number, boundMs: number) => IdentityRead = identityOf,
): Promise<ChildStart> {
  let child: ChildProcessHandle;
  try {
    child = spawn(command.program, [...command.arguments], {
      cwd: command.directory,
      env: environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (cause) {
    return { outcome: "failed", reason: `${command.program} could not be started: ${messageOf(cause)}` };
  }

  const spawned = await new Promise<string | undefined>((settle) => {
    child.once("spawn", () => settle(undefined));
    child.once("error", (cause) => settle(messageOf(cause)));
  });
  if (spawned !== undefined) return { outcome: "failed", reason: `${command.program} could not be started: ${spawned}` };
  const pid = child.pid;
  if (pid === undefined) return { outcome: "failed", reason: `${command.program} started with no pid` };

  const read = identify(pid, boundMs);
  if (read.outcome === "read") return { outcome: "started", identity: read.identity, child };
  // A child that has exited ran, and what it said on the way out is the
  // caller's to read. Nothing needs to find it again, so the second it was
  // found exited stands in for its start, and names no process running now.
  if (read.outcome === "gone") {
    return { outcome: "started", identity: { pid, startedAt: Math.floor(Date.now() / 1_000) }, child };
  }
  // A child that cannot be named cannot be found again, so it is stopped here,
  // while the handle still says which process it is.
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Its group has already gone.
  }
  return {
    outcome: "failed",
    reason: `${command.program} started as pid ${pid}, and was stopped: ${read.reason}`,
    ran: true,
  };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
