/**
 * Finding and stopping the processes a test left behind. Only tests use it.
 *
 * A test that removes its temporary directory while a process it started still
 * writes there fails in its clean-up with `ENOTEMPTY`, though what it checked
 * passed. The processes the tests start name that directory on their command
 * lines, so that is how a clean-up finds them, detached ones included.
 */

import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Kill every process whose command line contains `text`, and resolve once none
 * is left. Throws where one is still there after `boundMs`.
 *
 * A process started a moment ago is found as well as one that has done its
 * work, which a list of what reported back would miss.
 */
export async function stopEveryNaming(text: string, boundMs: number): Promise<void> {
  const until = Date.now() + boundMs;
  for (let found = processesNaming(text); found.length > 0; found = processesNaming(text)) {
    if (Date.now() > until) throw new Error(`still running ${boundMs}ms after a kill: ${found.join(", ")}`);
    for (const pid of found) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await sleep(25);
  }
}

/** The pids of the processes, other than this one, whose command line contains `text`. */
export function processesNaming(text: string): number[] {
  const listed = spawnSync("ps", ["-A", "-ww", "-o", "pid=,args="], { encoding: "utf8" });
  if (listed.error !== undefined) throw listed.error;
  if (listed.status !== 0) throw new Error(`ps exited ${listed.status}: ${listed.stderr}`);
  return listed.stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s(.*)$/u.exec(line))
    .filter((match) => match !== null && (match[2] ?? "").includes(text))
    .map((match) => Number(match?.[1]))
    .filter((pid) => pid !== process.pid);
}
