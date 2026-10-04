import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { identityOf, stillRunning, type ProcessIdentity } from "./process.ts";

const BOUND_MS = 5_000;

function ownIdentity(): ProcessIdentity {
  const read = identityOf(process.pid, BOUND_MS);
  assert.equal(read.outcome, "read", `this process's identity was not read: ${JSON.stringify(read)}`);
  return read.outcome === "read" ? read.identity : { pid: 0, startedAt: 0 };
}

/** Run `body` with `PATH` changed as `change` says, and restore it after. */
function withPath<T>(change: (previous: string) => string, body: () => T): T {
  const previous = process.env["PATH"];
  try {
    process.env["PATH"] = change(previous ?? "");
    return body();
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
  }
}

/**
 * Run `body` with a `ps` on `PATH` that runs `script` instead of the real one.
 *
 * The fake is run once before `body`, because macOS checks a new executable the
 * first time it runs, and under load that check alone can spend a test's bound.
 */
function withPsThat<T>(script: string, body: () => T): T {
  const directory = mkdtempSync(join(tmpdir(), "squiz-sessions-ps-"));
  try {
    const fake = join(directory, "ps");
    writeFileSync(fake, `#!/bin/sh\n[ "$1" = warm ] && exit 0\n${script}\n`, "utf8");
    chmodSync(fake, 0o755);
    spawnSync(fake, ["warm"], { stdio: "ignore" });
    return withPath((previous) => `${directory}:${previous}`, body);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Run `body` with `variables` set in this process's environment, and restore them after. */
function withEnvironment<T>(variables: Record<string, string>, body: () => T): T {
  const previous = Object.fromEntries(Object.keys(variables).map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, variables);
    return body();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function assertUnknown(read: { readonly outcome: string }, reason: RegExp): void {
  assert.equal(read.outcome, "unknown", `read as ${JSON.stringify(read)}`);
  assert.match("reason" in read && typeof read.reason === "string" ? read.reason : "", reason);
}

test("a running process's identity names it, and it is still running", () => {
  const identity = ownIdentity();

  assert.equal(identity.pid, process.pid);
  const started = (Date.now() - process.uptime() * 1_000) / 1_000;
  assert.ok(
    Math.abs(identity.startedAt - started) <= 2,
    `read as starting at ${identity.startedAt}, and it started near ${started}`,
  );
  assert.deepEqual(stillRunning(identity, BOUND_MS), { outcome: "running" });
});

test("the identity is read the same whatever the locale and the time zone", () => {
  const identity = ownIdentity();

  const elsewhere = withEnvironment(
    { LC_ALL: "fr_FR.UTF-8", LANG: "fr_FR.UTF-8", LC_TIME: "fr_FR.UTF-8", TZ: "Pacific/Kiritimati" },
    () => identityOf(process.pid, BOUND_MS),
  );

  assert.deepEqual(elsewhere, { outcome: "read", identity });
});

test("a process that has exited is gone, by its pid and by its identity", async () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const pid = child.pid ?? 0;
  const read = identityOf(pid, BOUND_MS);
  assert.equal(read.outcome, "read", `the child was not read while running: ${JSON.stringify(read)}`);

  const exited = new Promise((settle) => child.once("exit", settle));
  child.kill("SIGKILL");
  await exited;

  assert.deepEqual(identityOf(pid, BOUND_MS), { outcome: "gone" });
  if (read.outcome === "read") assert.deepEqual(stillRunning(read.identity, BOUND_MS), { outcome: "gone" });
});

test("a pid now held by a process that started at another time is gone", () => {
  const identity = ownIdentity();

  assert.deepEqual(stillRunning({ ...identity, startedAt: identity.startedAt - 1 }, BOUND_MS), {
    outcome: "gone",
  });
  assert.deepEqual(stillRunning({ ...identity, startedAt: identity.startedAt + 1 }, BOUND_MS), {
    outcome: "gone",
  });
});

/**
 * A zombie holds its pid until its parent reaps it, so it is listed with its
 * start time. The shell leaves one by backgrounding a short sleep and then
 * becoming a long one, which never waits for its child.
 */
test("a zombie is gone", async () => {
  const parent = spawn("/bin/sh", ["-c", "sleep 0.1 & echo $!; exec sleep 30"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    const zombie = await new Promise<number>((settle) => {
      parent.stdout.once("data", (chunk: Buffer) => settle(Number(chunk.toString().trim())));
    });
    const seen = identityOf(zombie, BOUND_MS);
    assert.equal(seen.outcome, "read", `the sleep was not read before it exited: ${JSON.stringify(seen)}`);

    let state = "";
    for (let tries = 0; tries < 100 && !state.startsWith("Z"); tries += 1) {
      await new Promise((settle) => setTimeout(settle, 20));
      state = spawnSync("ps", ["-o", "stat=", "-p", String(zombie)], { encoding: "utf8" }).stdout.trim();
    }
    assert.match(state, /^Z/u, "the sleep never became a zombie");

    assert.deepEqual(identityOf(zombie, BOUND_MS), { outcome: "gone" });
    if (seen.outcome === "read") assert.deepEqual(stillRunning(seen.identity, BOUND_MS), { outcome: "gone" });
  } finally {
    parent.kill("SIGKILL");
  }
});

test("Linux's ps, which pads nothing after the time, is read", () => {
  const read = withPsThat("printf 'S    Sun Oct  4 10:50:51 2026\\n'", () => identityOf(4242, BOUND_MS));

  assert.deepEqual(read, {
    outcome: "read",
    identity: { pid: 4242, startedAt: Date.UTC(2026, 9, 4, 10, 50, 51) / 1_000 },
  });
});

test("a day of the month in two digits is read", () => {
  const read = withPsThat("printf 'Ss   Wed Oct 14 09:05:01 2026   \\n'", () => identityOf(4242, BOUND_MS));

  assert.deepEqual(read, {
    outcome: "read",
    identity: { pid: 4242, startedAt: Date.UTC(2026, 9, 14, 9, 5, 1) / 1_000 },
  });
});

// Every case below is one a caller that read it as gone would act on, by
// killing what holds the pid now or by removing what a live process is using.

test("a ps that is not on the path could not tell", () => {
  const empty = mkdtempSync(join(tmpdir(), "squiz-sessions-path-"));
  try {
    const identity = ownIdentity();
    withPath(
      () => empty,
      () => {
        assertUnknown(identityOf(process.pid, BOUND_MS), /ps could not be run/u);
        assertUnknown(stillRunning(identity, BOUND_MS), /ps could not be run/u);
      },
    );
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("a ps that does not answer within the bound could not tell, and is not waited out", () => {
  const started = Date.now();
  const read = withPsThat("sleep 30", () => identityOf(process.pid, 300));
  const elapsedMs = Date.now() - started;

  assertUnknown(read, /ps did not answer within 300ms/u);
  assert.ok(elapsedMs < 3_000, `the ps was waited on for ${elapsedMs}ms`);
});

test("a ps killed before it answered could not tell", () => {
  assertUnknown(
    withPsThat("kill -TERM $$", () => identityOf(process.pid, BOUND_MS)),
    /ps was killed by SIGTERM/u,
  );
});

test("a ps that complains could not tell, whatever it exits with", () => {
  assertUnknown(
    withPsThat("echo 'ps: something went wrong' >&2; exit 1", () => identityOf(process.pid, BOUND_MS)),
    /ps exited 1: ps: something went wrong/u,
  );

  // A row that would otherwise be read, with a complaint beside it.
  const complaining = "printf 'S    Sun Oct  4 10:50:51 2026\\n'; echo 'ps: something went wrong' >&2; exit 0";
  withPsThat(complaining, () => {
    assertUnknown(identityOf(4242, BOUND_MS), /ps exited 0: ps: something went wrong/u);
    // A start time other than the row's, which read past the complaint would be gone.
    assertUnknown(stillRunning({ pid: 4242, startedAt: 0 }, BOUND_MS), /ps exited 0: ps: something went wrong/u);
  });
});

test("a ps that prints what is not a state and a start time could not tell", () => {
  assertUnknown(
    withPsThat("echo 'S    dim.  4 oct. 21:50:06 2026'", () => identityOf(process.pid, BOUND_MS)),
    /ps printed no start time it can be read by/u,
  );
  assertUnknown(
    withPsThat("echo 'S    Sun Oct 44 10:50:51 2026'", () => identityOf(process.pid, BOUND_MS)),
    /ps printed no start time it can be read by/u,
  );
});

test("a ps that succeeds saying nothing could not tell", () => {
  assertUnknown(
    withPsThat("exit 0", () => identityOf(process.pid, BOUND_MS)),
    /ps printed no start time it can be read by/u,
  );
});

test("a ps that exits 1 saying nothing is ps's own word for a process that is not there", () => {
  assert.deepEqual(
    withPsThat("exit 1", () => identityOf(process.pid, BOUND_MS)),
    { outcome: "gone" },
  );
});

test("a pid no process can have could not tell, and ps is never asked", () => {
  // A ps that would answer for any pid it was given.
  withPsThat("printf 'S    Sun Oct  4 10:50:51 2026\\n'", () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      assertUnknown(identityOf(pid, BOUND_MS), /is no process id/u);
      assertUnknown(stillRunning({ pid, startedAt: 0 }, BOUND_MS), /is no process id/u);
    }
  });
});

test("an identity whose start time is no number of seconds could not tell", () => {
  for (const startedAt of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assertUnknown(stillRunning({ pid: process.pid, startedAt }, BOUND_MS), /is no start time/u);
  }
});
