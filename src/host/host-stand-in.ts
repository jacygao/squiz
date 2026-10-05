/**
 * A round host for the trigger tests, run as a process of its own.
 *
 * Its arguments are the episode's directory and a file to append to. It takes
 * the host lock as `squiz host` does, appends `took <pid>` or what it found
 * instead, and holds the lock for a minute before it exits. It runs no round.
 */

import { appendFileSync } from "node:fs";

import { takeHostLock } from "./lock.ts";

const [directory = "", log = ""] = process.argv.slice(2);

const taking = takeHostLock(directory, { boundMs: 5_000 });
appendFileSync(log, `${taking.outcome === "taken" ? "took" : taking.outcome} ${process.pid}\n`);
if (taking.outcome === "taken") setTimeout(() => {}, 60_000);
