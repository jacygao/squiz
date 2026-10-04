/**
 * Starting a process that outlives whatever started it.
 *
 * A runtime that kills a command signals its process group and every process
 * descended from it. A process escapes both only if it leads a session of its
 * own and is no longer the caller's descendant, so it is started by a double
 * fork: an intermediate process starts the target in a session of its own,
 * hands back its pid, and exits. The target is reparented before the call
 * returns.
 *
 * Node has no fork, so the intermediate is a second Node process. Nothing here
 * runs a `setsid` binary, which macOS does not have.
 *
 * **The target holds none of the caller's streams.** Its standard input is
 * `/dev/null` and its output goes to the log the caller names. A target holding
 * the caller's stdout would keep whatever reads that stdout waiting for an end
 * that never comes.
 *
 * Nothing here throws. Every answer is a value the caller reads.
 */

import { spawnSync } from "node:child_process";

import { identityOf, type ProcessIdentity } from "./process.ts";

export type DetachSpec = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Opened for appending. Its directory must already exist. */
  readonly logPath: string;
  /** The target's whole environment. Without it the target gets the caller's. */
  readonly env?: NodeJS.ProcessEnv;
};

export type Detached =
  | { readonly outcome: "started"; readonly identity: ProcessIdentity }
  /** It started, and ended before its identity could be read. */
  | { readonly outcome: "exited"; readonly pid: number }
  /** Nothing was started. */
  | { readonly outcome: "failed"; readonly reason: string }
  /** Something may have been started, and what it is could not be read. */
  | { readonly outcome: "unknown"; readonly reason: string };

/**
 * The intermediate process, as a CommonJS script for `node -e`.
 *
 * It reads the spec as JSON on its standard input rather than in its arguments,
 * where `ps` would show the environment to anyone. It answers with one JSON
 * object, written synchronously because it exits straight after.
 */
const INTERMEDIATE = `
const { spawn } = require("node:child_process");
const { openSync, readFileSync, writeSync } = require("node:fs");
const answer = (value) => {
  writeSync(1, JSON.stringify(value));
  process.exit(0);
};
const spec = JSON.parse(readFileSync(0, "utf8"));
let log;
try {
  log = openSync(spec.logPath, "a");
} catch (error) {
  answer({ failed: "the log could not be opened: " + error.message });
}
const target = spawn(spec.command, spec.args, {
  cwd: spec.cwd,
  env: spec.env,
  detached: true,
  stdio: ["ignore", log, log],
});
target.on("error", (error) => answer({ failed: error.message }));
target.on("spawn", () => answer({ pid: target.pid }));
`;

/**
 * Start `spec.command` detached, and read back the identity of what started.
 *
 * `boundMs` bounds each of the two steps: the intermediate process, and the
 * `ps` that reads the target's identity.
 */
export function startDetached(spec: DetachSpec, boundMs: number): Detached {
  const result = spawnSync(process.execPath, ["-e", INTERMEDIATE], {
    input: JSON.stringify({ ...spec, env: spec.env ?? process.env }),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    // Never zero, which `spawnSync` reads as no bound at all.
    timeout: Math.max(1, boundMs),
  });

  if (result.error !== undefined) {
    // Cut short, it may already have started the target.
    if ("code" in result.error && result.error.code === "ETIMEDOUT") {
      return { outcome: "unknown", reason: `the intermediate process did not answer within ${boundMs}ms` };
    }
    return { outcome: "failed", reason: `the intermediate process could not be run: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const complaint = result.stderr.trim().split("\n", 1)[0] ?? "";
    const ended = result.status === null ? `was killed by ${result.signal ?? "a signal"}` : `exited ${result.status}`;
    return { outcome: "unknown", reason: `the intermediate process ${ended}: ${complaint}` };
  }

  const answer = parsed(result.stdout);
  if (answer === undefined) {
    return { outcome: "unknown", reason: `the intermediate process answered ${JSON.stringify(result.stdout)}` };
  }
  if ("failed" in answer) return { outcome: "failed", reason: answer.failed };

  const read = identityOf(answer.pid, boundMs);
  if (read.outcome === "read") return { outcome: "started", identity: read.identity };
  if (read.outcome === "gone") return { outcome: "exited", pid: answer.pid };
  return { outcome: "unknown", reason: `started as pid ${answer.pid}, whose identity could not be read: ${read.reason}` };
}

type Answer = { readonly pid: number } | { readonly failed: string };

/** The intermediate's answer, or nothing where it printed anything else. */
function parsed(stdout: string): Answer | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  if ("pid" in value && typeof value.pid === "number" && Number.isInteger(value.pid)) return { pid: value.pid };
  if ("failed" in value && typeof value.failed === "string") return { failed: value.failed };
  return undefined;
}
