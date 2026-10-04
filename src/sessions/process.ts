/**
 * A process's identity, and whether the process it names is still running.
 *
 * **A pid is not an identity.** Pids are reused, so a pid written down and read
 * back later can name a stranger's process. The identity is the pid and the
 * second the process started, and a pid now held by a process that started at
 * another second is the identity's process gone.
 *
 * **"Gone" is said only where `ps` said it.** `ps` exits non-zero both for a pid
 * no process holds and for a failure of its own, so the exit status alone cannot
 * tell them apart. Gone is the one ending with nothing on either stream. A `ps`
 * that could not be run, ran past its bound, was killed, said anything on stderr
 * whatever it exited with, or printed something that is not one row of a state
 * and a start time could not tell. A caller that
 * read any of those as gone would kill what holds the pid now, or remove what a
 * live process is using.
 *
 * **A zombie is gone.** It has exited and runs nothing, and it never will again.
 * It still holds its pid until it is reaped, so no other process can be mistaken
 * for it in the meantime. Its process group is another matter, and a caller that
 * cares what is left in the group asks about the group.
 *
 * Nothing here throws. Every answer is a value the caller reads.
 */

import { spawnSync } from "node:child_process";

export type ProcessIdentity = {
  readonly pid: number;
  /** When the process started, in whole seconds since the epoch, as `ps` gives it. */
  readonly startedAt: number;
};

export type IdentityRead =
  | { readonly outcome: "read"; readonly identity: ProcessIdentity }
  | { readonly outcome: "gone" }
  | { readonly outcome: "unknown"; readonly reason: string };

export type Presence =
  | { readonly outcome: "running" }
  | { readonly outcome: "gone" }
  | { readonly outcome: "unknown"; readonly reason: string };

/**
 * The identity of the process that holds `pid` now.
 *
 * `boundMs` bounds the `ps` it runs. One cut short at the bound could not tell.
 */
export function identityOf(pid: number, boundMs: number): IdentityRead {
  if (!Number.isInteger(pid) || pid < 1) return { outcome: "unknown", reason: `${pid} is no process id` };
  const listed = list(pid, boundMs);
  if (listed.outcome !== "listed") return listed;
  if (listed.zombie) return { outcome: "gone" };
  return { outcome: "read", identity: { pid, startedAt: listed.startedAt } };
}

/**
 * Whether the process `identity` names is still running.
 *
 * `boundMs` bounds the `ps` it runs. One cut short at the bound could not tell.
 */
export function stillRunning(identity: ProcessIdentity, boundMs: number): Presence {
  if (!Number.isInteger(identity.startedAt)) {
    return { outcome: "unknown", reason: `${identity.startedAt} is no start time` };
  }
  const read = identityOf(identity.pid, boundMs);
  if (read.outcome !== "read") return read;
  if (read.identity.startedAt !== identity.startedAt) return { outcome: "gone" };
  return { outcome: "running" };
}

type Listing =
  | { readonly outcome: "listed"; readonly zombie: boolean; readonly startedAt: number }
  | { readonly outcome: "gone" }
  | { readonly outcome: "unknown"; readonly reason: string };

/** What `ps` says of `pid`: its state and when it started. */
function list(pid: number, boundMs: number): Listing {
  const result = spawnSync("ps", ["-o", "stat=,lstart=", "-p", String(pid)], {
    encoding: "utf8",
    // The start time is parsed, so neither the locale nor the time zone may word it.
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    // Never zero, which `spawnSync` reads as no bound at all.
    timeout: Math.max(1, boundMs),
  });

  if (result.error !== undefined) {
    if ("code" in result.error && result.error.code === "ETIMEDOUT") {
      return { outcome: "unknown", reason: `ps did not answer within ${boundMs}ms` };
    }
    return { outcome: "unknown", reason: `ps could not be run: ${result.error.message}` };
  }
  if (result.status === null) {
    return { outcome: "unknown", reason: `ps was killed by ${result.signal ?? "a signal"} before it answered` };
  }

  const said = result.stdout.trim();
  const complaint = result.stderr.trim().split("\n", 1)[0] ?? "";
  if (result.status !== 0 && said === "" && complaint === "") return { outcome: "gone" };
  // A complaint casts doubt on the row beside it, whatever the exit status.
  if (result.status !== 0 || complaint !== "") {
    return { outcome: "unknown", reason: `ps exited ${result.status}: ${complaint === "" ? said : complaint}` };
  }

  const row = /^(\S+)\s+(.+)$/u.exec(said);
  const startedAt = row === null ? undefined : secondsOf(row[2] ?? "");
  if (row === null || startedAt === undefined) {
    return { outcome: "unknown", reason: `ps printed no start time it can be read by: ${JSON.stringify(said)}` };
  }
  return { outcome: "listed", zombie: (row[1] ?? "").startsWith("Z"), startedAt };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `lstart` as whole seconds since the epoch, or nothing where it is not one.
 *
 * Under the C locale and UTC both macOS and procps print it as
 * `Sun Oct  4 10:50:51 2026`. The weekday is not checked, and anything else that
 * differs from that is not read.
 */
function secondsOf(lstart: string): number | undefined {
  const parts = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/u.exec(lstart);
  if (parts === null) return undefined;
  const [, monthName, day, hours, minutes, seconds, year] = parts.map(String);
  const month = MONTHS.indexOf(monthName ?? "");
  if (month < 0) return undefined;
  const at = new Date(
    Date.UTC(Number(year), month, Number(day), Number(hours), Number(minutes), Number(seconds)),
  );
  // `Date.UTC` carries an out-of-range field into the next one rather than refusing it.
  const exact =
    at.getUTCMonth() === month &&
    at.getUTCDate() === Number(day) &&
    at.getUTCHours() === Number(hours) &&
    at.getUTCMinutes() === Number(minutes) &&
    at.getUTCSeconds() === Number(seconds);
  return exact ? at.getTime() / 1_000 : undefined;
}
