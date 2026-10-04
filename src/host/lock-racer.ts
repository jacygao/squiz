/**
 * One contender in the lock tests' races, run as a process of its own.
 *
 * Each line on its standard input names a directory and a moment, in epoch
 * milliseconds. It waits for that moment by spinning, so that every contender
 * moves within the same millisecond, then takes the host lock in that directory
 * and prints the directory and the outcome. It keeps every lock it takes until
 * its input closes, so a contender that lost finds the winner still running.
 */

import { createInterface } from "node:readline";

import { identityOf, stillRunning, type Presence, type ProcessIdentity } from "../sessions/process.ts";
import { takeHostLock } from "./lock.ts";

const BOUND_MS = 5_000;

const read = identityOf(process.pid, BOUND_MS);
if (read.outcome !== "read") {
  process.stderr.write(`own identity not read: ${JSON.stringify(read)}\n`);
  process.exit(1);
}
const self = read.identity;
process.stdout.write("ready\n");

// Contenders' `ps` runs end within a millisecond of each other when the machine
// is idle, which closes the window between finding a holder gone and acting on
// it. A random delay of up to 20ms, as a loaded machine gives, holds it open.
const pause = new Int32Array(new SharedArrayBuffer(4));
function slowly(identity: ProcessIdentity): Presence {
  Atomics.wait(pause, 0, 0, Math.random() * 20);
  return stillRunning(identity, BOUND_MS);
}

for await (const line of createInterface({ input: process.stdin })) {
  const [directory = "", at = "0"] = line.split("\t");
  while (Date.now() < Number(at));
  const taking = takeHostLock(directory, { boundMs: BOUND_MS, self, presence: slowly });
  process.stdout.write(`${directory}\t${taking.outcome}\n`);
}
