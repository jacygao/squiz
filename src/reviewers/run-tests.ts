/**
 * The `deep` tool `run_tests`: the configured test command, run in the snapshot
 * and stopped before the round ends.
 *
 * Nothing the reviewer sends reaches the command. The tool takes no argument, and
 * the command is the string the user configured, which is why it is handed to a
 * shell as it stands.
 *
 * **Nothing the command starts outlives the run.** The command runs in a process
 * group of its own, led by a shell that does not exit until the runner has
 * stopped everything else in it. So the group's number is held while it is
 * signalled, and a test runner's workers are stopped whether the command
 * finished, failed, or ran out of time. The shell also records its group the way
 * every reviewer shell does, so a run the round ends from outside is reached by
 * the round's own stop.
 *
 * Nothing here throws. Every outcome is a value, because the reviewer reads it as
 * the tool's result.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { Readable } from "node:stream";

import { deadlineIn, type Deadline } from "./deadline.ts";
import { shellPrefix } from "./groups.ts";

/** How much of the output the reviewer is shown: its last this-many bytes. */
export const OUTPUT_CAP_BYTES = 16_384;

/** How long each signal is given before the next, or before the runner gives up. */
const GRACE_MS = 2_000;

/**
 * How long before the round's deadline the run is stopped.
 *
 * Both signals and their waits, and a second over, so the stop has finished
 * before the round stops the reviewer that is running it.
 */
export const STOP_MARGIN_MS = 2 * GRACE_MS + 1_000;

export type RunTestsInput = {
  /** The snapshot of the head commit, where the command runs. */
  readonly snapshot: string;
  /** The configured `test` command, or `null` where none is configured. */
  readonly command: string | null;
  /** The round's scratch directory, which `TMPDIR` names. */
  readonly scratch: string;
  /** The moment the round's review must be over by. */
  readonly deadline: Deadline;
  /** The reviewer's environment, which the command runs with in place of this process's own. */
  readonly environment: Readonly<Record<string, string>>;
};

/** The end of what the command wrote to either stream, in the order it arrived. */
export type Output = {
  readonly text: string;
  /** How many bytes the command wrote in all. */
  readonly bytes: number;
  /** The most the text holds, in bytes. */
  readonly cap: number;
};

export type TestsRun =
  /** The command ran to its end. A non-zero status is a suite that failed. */
  | { readonly outcome: "exited"; readonly status: number; readonly output: Output }
  /** Something outside the runner ended the run before the command finished. */
  | { readonly outcome: "signalled"; readonly signal: string; readonly output: Output }
  /** The round's time ran out first, and the runner stopped the command. */
  | { readonly outcome: "stopped"; readonly seconds: number; readonly output: Output }
  /** Nothing ran. */
  | { readonly outcome: "not run"; readonly reason: string };

/**
 * The tool as an adapter grants it: its name, a schema that admits no argument,
 * and the run.
 */
export const runTestsTool = {
  name: "run_tests",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  run: runTests,
} as const;

/**
 * The shell that leads the command's group.
 *
 * The command runs as this shell's child rather than in its place, so the shell
 * is still there, holding the group's number, when the runner signals the group.
 * It writes the command's status on descriptor 3, which nothing else holds, so a
 * worker left holding the output pipes cannot keep the runner from seeing the
 * command end. It then waits on its own standard input, which the runner never
 * writes, until the runner's signal ends it.
 */
const LEADER = [
  shellPrefix,
  `/bin/sh -c "$1" </dev/null 3>&-`,
  `printf '%s\\n' "$?" >&3`,
  `exec 3>&-`,
  `read -r _ || :`,
].join("\n");

/**
 * The leader's shell: bash where the system has it, because only bash starts the
 * keeper that lets the round's own stop claim the group. A plain `sh` still runs
 * the command and is still stopped by the runner; only the round's stop then
 * leaves the group alone.
 */
const LEADER_SHELL = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";

/**
 * Run the configured test command in the snapshot, and stop everything it
 * started before returning.
 */
export async function runTests(input: RunTestsInput): Promise<TestsRun> {
  if (input.command === null) {
    return { outcome: "not run", reason: "No test command is configured, so nothing was run." };
  }
  const left = input.deadline.remaining();
  if (left <= STOP_MARGIN_MS) {
    return {
      outcome: "not run",
      reason: `The round has ${seconds(left)} seconds left, too few to run the tests and stop them, so nothing was run.`,
    };
  }
  const bound = deadlineIn(left - STOP_MARGIN_MS);
  const started = Date.now();

  const child = spawn(LEADER_SHELL, ["-c", LEADER, "squiz-run-tests", input.command], {
    cwd: input.snapshot,
    env: environmentFor(input),
    detached: true,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const output = tailOf(child);
  const ended = await endOf(child, bound);

  if (ended.how === "unstartable" || child.pid === undefined) {
    output.close();
    const reason = ended.how === "unstartable" ? ended.reason : "the shell was never started";
    return { outcome: "not run", reason: `The test command could not be started: ${reason}` };
  }
  await stop(child.pid);
  output.close();
  const read = output.read();

  if (ended.how === "status") return { outcome: "exited", status: ended.status, output: read };
  if (ended.how === "time") {
    return { outcome: "stopped", seconds: seconds(Date.now() - started), output: read };
  }
  return { outcome: "signalled", signal: await signalOf(child), output: read };
}

/**
 * The command's environment.
 *
 * The reviewer's own, which carries no credential, with what the run itself
 * requires laid over it. A variable every test run needs goes here.
 */
function environmentFor(input: RunTestsInput): Record<string, string> {
  return { ...input.environment, TMPDIR: input.scratch };
}

/** What the reviewer is told, and whether it is the tool's error rather than a result. */
export function describeTestsRun(run: TestsRun): { readonly text: string; readonly isError: boolean } {
  if (run.outcome === "not run") return { text: run.reason, isError: true };
  const head =
    run.outcome === "exited"
      ? `The test command exited ${run.status}.`
      : run.outcome === "stopped"
        ? `The test command was stopped after ${run.seconds} seconds, because the round's time ran out. It did not finish, so this says nothing about whether the tests pass.`
        : `The test command was ended by ${run.signal} from outside run_tests before it finished, so this says nothing about whether the tests pass.`;
  return { text: `${head}\n\n${outputLine(run.output)}\n${run.output.text}`, isError: false };
}

function outputLine(output: Output): string {
  const cap = output.cap.toLocaleString("en");
  const bytes = output.bytes.toLocaleString("en");
  if (output.bytes === 0) return `It wrote no output. run_tests shows at most the last ${cap} bytes.`;
  if (output.bytes <= output.cap) {
    return `Its output, all ${bytes} bytes of it. run_tests shows at most the last ${cap} bytes.`;
  }
  return `Its output was ${bytes} bytes, and this is the last ${cap} of them, which is the most run_tests shows.`;
}

type Ended =
  | { readonly how: "status"; readonly status: number }
  | { readonly how: "time" }
  | { readonly how: "lost" }
  | { readonly how: "unstartable"; readonly reason: string };

/** Wait for the command's status, for the bound, or for the leader to go without one. */
function endOf(child: ChildProcess, bound: Deadline): Promise<Ended> {
  return new Promise((settle) => {
    let said = "";
    let cancel = (): void => {};
    const done = (ended: Ended): void => {
      cancel();
      settle(ended);
    };
    child.once("error", (cause) => {
      done({ how: "unstartable", reason: cause.message });
    });
    const status = child.stdio[3] as Readable | null;
    if (status === null) {
      done({ how: "unstartable", reason: "the shell was given no status descriptor" });
      return;
    }
    status.on("data", (chunk: Buffer) => {
      said += chunk.toString("utf8");
    });
    status.once("close", () => {
      const value = Number(said.trim());
      done(said.trim() !== "" && Number.isInteger(value) ? { how: "status", status: value } : { how: "lost" });
    });
    status.once("error", () => {
      done({ how: "lost" });
    });
    cancel = bound.whenPassed(() => {
      done({ how: "time" });
    });
  });
}

/**
 * Stop everything in the group: `SIGTERM`, then `SIGKILL` to whatever is left
 * after the grace, and wait for neither longer than the grace.
 *
 * The leader holds the group's number until the first signal, and whatever
 * survives it holds the number after. The number is only free once the group is
 * empty, which the wait notices within one look, so the `SIGKILL` reaches a group
 * that was never emptied.
 */
async function stop(group: number): Promise<void> {
  signal(group, "SIGTERM");
  if (await emptied(group, GRACE_MS)) return;
  signal(group, "SIGKILL");
  await emptied(group, GRACE_MS);
}

/** How often the group is asked whether anything of it is left. */
const LOOK_MS = 25;

async function emptied(group: number, milliseconds: number): Promise<boolean> {
  const bound = deadlineIn(milliseconds);
  for (;;) {
    if (!groupRuns(group)) return true;
    if (bound.passed()) return false;
    await new Promise((settle) => setTimeout(settle, LOOK_MS));
  }
}

function groupRuns(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (cause) {
    // Refused rather than absent means it is there and not ours to signal.
    return cause instanceof Error && "code" in cause && cause.code === "EPERM";
  }
}

function signal(group: number, sent: NodeJS.Signals): void {
  try {
    process.kill(-group, sent);
  } catch {
    // Nothing left in it. The wait that follows is what bounds this either way.
  }
}

/** The signal that ended the leader, waited for briefly because its exit can trail its status pipe. */
async function signalOf(child: ChildProcess): Promise<string> {
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((settle) => {
      const timer = setTimeout(settle, GRACE_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        settle(undefined);
      });
    });
  }
  return child.signalCode ?? "a signal";
}

type Tail = {
  readonly read: () => Output;
  /** Stop reading and let go of every pipe, which a stray process may still hold. */
  readonly close: () => void;
};

/** Collect the last bytes of both streams, in the order they arrive. */
function tailOf(child: ChildProcess): Tail {
  let chunks: Buffer[] = [];
  let held = 0;
  let bytes = 0;
  const take = (chunk: Buffer): void => {
    bytes += chunk.length;
    chunks.push(chunk);
    held += chunk.length;
    if (held > 2 * OUTPUT_CAP_BYTES) {
      const kept = Buffer.concat(chunks).subarray(held - OUTPUT_CAP_BYTES);
      chunks = [kept];
      held = kept.length;
    }
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  return {
    read: () => {
      const all = Buffer.concat(chunks);
      const text = all.subarray(Math.max(0, all.length - OUTPUT_CAP_BYTES)).toString("utf8");
      return { text, bytes, cap: OUTPUT_CAP_BYTES };
    },
    close: () => {
      for (const stream of child.stdio) stream?.destroy();
    },
  };
}

function seconds(milliseconds: number): number {
  return Math.round(milliseconds / 1_000);
}
