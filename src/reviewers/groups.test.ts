import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  discardRoundSpace,
  makeRoundSpace,
  recordedGroups,
  shellPrefix,
  stopRecordedGroups,
  type RoundSpace,
} from "./groups.ts";

/** The grace each stop is given, short enough that the tests are not the grace. */
const GRACE_MS = 1_500;

/**
 * A prefix that never reached the CLI leaves an empty record, and so does a
 * round whose reviewer detached nothing. Nothing else tells those two apart, so
 * every shell records whether or not it leaves anything behind: a round where
 * any shell ran and whose record is empty is a round that stopped recording.
 */
test("a shell that detaches nothing still records the group it leads", async () => {
  await inADirectory(async (directory) => {
    const space = madeIn(directory);
    const shell = await shellRan("echo hello", space);
    assert.deepEqual(recordedGroups(space), [shell]);
  });
});

test("every shell of a round records, each group once", async () => {
  await inADirectory(async (directory) => {
    const space = madeIn(directory);
    const first = await shellRan("true", space);
    const second = await shellRan("true", space);
    assert.deepEqual(recordedGroups(space).toSorted(), [first, second].toSorted());
  });
});

/**
 * The prefix is prepended as a line, so a command that could swallow it is the
 * case worth naming: a here-document eats the lines that follow it, `exec`
 * replaces the shell, and an unterminated quote fails the parse.
 */
test("the prefix records before a command that would swallow it", async () => {
  const commands = [
    "exec /bin/echo replaced",
    "cat <<END\nbody\nEND",
    'echo "never closed',
    "# only a comment",
    "",
  ];
  for (const command of commands) {
    await inADirectory(async (directory) => {
      const space = madeIn(directory);
      const shell = await shellRan(command, space);
      assert.deepEqual(recordedGroups(space), [shell], `${JSON.stringify(command)} swallowed it`);
    });
  }
});

/**
 * A command that is a comment or is empty leaves the prefix as the last thing
 * the shell ran, so a prefix that failed would be reported as that command
 * failing.
 */
test("the prefix leaves the command's own exit status alone", async () => {
  await inADirectory(async (directory) => {
    const space = madeIn(directory);
    assert.equal(await statusOf("# only a comment", space), 0);
    assert.equal(await statusOf("exit 7", space), 7);
  });
});

/** A shell that cannot record says nothing about it, on either stream. */
test("a record that cannot be written costs the shell nothing", async () => {
  await inADirectory(async (directory) => {
    const space = { ...madeIn(directory), shellRecord: join(directory, "no/such/place") };
    const said = await outputOf("echo hello", space);
    assert.deepEqual(said, { status: 0, stdout: "hello\n", stderr: "" });
  });
});

test("everything the shell started is stopped, after the shell itself has gone", async () => {
  await inADirectory(async (directory) => {
    const space = madeIn(directory);
    const childFile = join(directory, "child");
    const shell = await shellRan(`sleep 30 & printf '%s\\n' "$!" > ${childFile}`, space);
    const child = Number(readFileSync(childFile, "utf8").trim());
    assert.ok(running(child), "nothing was left running for the stop to be worth anything");
    assert.equal(running(shell), false, "the shell exits first, which is the case this is for");

    const stopped = await stopRecordedGroups(space, GRACE_MS);
    assert.deepEqual(stopped.signalled, [shell]);
    assert.equal(running(child), false, "a tool the shell left running outlived the round");
  });
});

/**
 * A recorded identifier is not an identity: the shell that wrote it is reaped,
 * and the number is then free. A group whose processes are older than the round
 * is not the group the round recorded, whether the number was reused or the
 * record never named a shell of this round at all.
 */
test("a group older than the round is left alone", async () => {
  await inADirectory(async (directory) => {
    const stranger = await detachedGroup(directory, "stranger");
    try {
      // Longer than the second `ps` may round an elapsed time by and the second
      // the round allows for it, so that the group is older than the round by
      // more than either can account for.
      await pause(3_200);
      const made = madeIn(directory);
      writeFileSync(made.shellRecord, `${stranger.group}\n`, "utf8");
      // The round begins here, which is what makes the group older than it. Read
      // from the clock rather than from when the space was made, so that a
      // machine slow between the two does not make the round look the older.
      const space = { ...made, startedAt: Date.now() };

      const stopped = await stopRecordedGroups(space, GRACE_MS);
      assert.deepEqual(stopped.signalled, []);
      assert.equal(stopped.refused.length, 1);
      assert.match(stopped.refused[0]?.reason ?? "", /longer than the round/u);
      assert.ok(
        running(stranger.child),
        "a process older than the round was killed over its number",
      );
    } finally {
      stranger.stop();
    }
  });
});

/**
 * The record is written by the reviewer's own shell, into a file the reviewer
 * can write anything to. A signal to group 1 reaches every process the harness
 * may signal and one to group 0 reaches the harness's own, so neither may depend
 * on what the system says next.
 */
test("a record naming no process group is read as naming nothing", async () => {
  await inADirectory(async (directory) => {
    const space = madeIn(directory);
    const junk = ["0", "1", "-1", "", "  ", "nonsense", "12.5"].join("\n");
    writeFileSync(space.shellRecord, junk, "utf8");
    assert.deepEqual(recordedGroups(space), []);

    const stopped = await stopRecordedGroups(space, GRACE_MS);
    assert.deepEqual(stopped, { signalled: [], refused: [] });
  });
});

test("a group that has already gone is neither signalled nor refused", async () => {
  await inADirectory(async (directory) => {
    const space = madeIn(directory);
    const shell = await shellRan("true", space);
    assert.equal(running(shell), false);

    const stopped = await stopRecordedGroups(space, GRACE_MS);
    assert.deepEqual(stopped, { signalled: [], refused: [] });
  });
});

/**
 * A group nothing could be established about is refused rather than signalled.
 * Read the other way, a machine whose `ps` is missing or broken would have the
 * round signalling every number its record held.
 */
test("a group the system would not answer about is left alone", async () => {
  await inADirectory(async (directory) => {
    const group = await detachedGroup(directory, "tool");
    const previous = process.env["PATH"];
    try {
      const space = madeIn(directory);
      writeFileSync(space.shellRecord, `${group.group}\n`, "utf8");
      process.env["PATH"] = brokenPs(directory);

      const stopped = await stopRecordedGroups(space, GRACE_MS);
      assert.deepEqual(stopped.signalled, []);
      assert.match(stopped.refused[0]?.reason ?? "", /ps exited 2: ps fell over/u);
      assert.ok(running(group.child), "a group nothing could be established about was signalled");
    } finally {
      if (previous === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previous;
      group.stop();
    }
  });
});

test("a record that is not there names no groups", () => {
  const space: RoundSpace = {
    directory: "/no/such/directory",
    shellRecord: "/no/such/directory/groups",
    startedAt: Date.now(),
  };
  assert.deepEqual(recordedGroups(space), []);
});

/**
 * A round that was killed leaves its space behind, and the next round in the
 * same episode must not read it as its own groups.
 */
test("two rounds of one episode own two spaces, and a space goes when it is discarded", () => {
  const directory = mkdtempSync(join(tmpdir(), "squiz-groups-"));
  try {
    const one = madeIn(directory);
    const other = madeIn(directory);
    assert.notEqual(one.directory, other.directory);
    assert.notEqual(one.shellRecord, other.shellRecord);

    writeFileSync(one.shellRecord, "12345\n", "utf8");
    discardRoundSpace(one);
    assert.deepEqual(recordedGroups(one), []);
    assert.deepEqual(recordedGroups(other), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a space that cannot be made says where and why", () => {
  const directory = mkdtempSync(join(tmpdir(), "squiz-groups-"));
  try {
    // A file where the directory has to go, which cannot be turned into one.
    writeFileSync(join(directory, "taken"), "", "utf8");
    const made = makeRoundSpace(join(directory, "taken"));
    assert.equal(made.outcome, "failed");
    assert.match(made.outcome === "failed" ? made.reason : "", /could not be made/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function madeIn(directory: string): RoundSpace {
  const made = makeRoundSpace(directory);
  assert.equal(made.outcome, "made", "the round's own space must be there before anything records");
  return made.outcome === "made" ? made.space : ({} as RoundSpace);
}

type ShellOutput = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * Run one command the way `pi` runs a shell tool: the prefix on the line before
 * it, the shell detached so that it leads its own group, and the record named in
 * the environment.
 *
 * It waits for the shell's own exit rather than for its output to close, because
 * a backgrounded descendant holds the pipe open after the shell has gone.
 */
function runShell(command: string, space: RoundSpace): Promise<ShellOutput & { pid: number }> {
  const child = spawn("/bin/bash", ["-c", `${shellPrefix}\n${command}`], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SQUIZ_GROUPS: space.shellRecord },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise((settle, fail) => {
    child.once("error", fail);
    child.once("exit", (status) => {
      settle({ status, stdout, stderr, pid: child.pid ?? 0 });
    });
  });
}

/** The group the shell led, which is its own identifier. */
async function shellRan(command: string, space: RoundSpace): Promise<number> {
  const { pid } = await runShell(command, space);
  return pid;
}

async function statusOf(command: string, space: RoundSpace): Promise<number | null> {
  return (await runShell(command, space)).status;
}

async function outputOf(command: string, space: RoundSpace): Promise<ShellOutput> {
  const { status, stdout, stderr } = await runShell(command, space);
  return { status, stdout, stderr };
}

/** A group led by a shell that has gone, with something of its own still in it. */
type Stranger = {
  readonly group: number;
  /** The backgrounded process the group is kept alive by. */
  readonly child: number;
  readonly stop: () => void;
};

async function detachedGroup(directory: string, name: string): Promise<Stranger> {
  const childFile = join(directory, name);
  const child = spawn(
    "/bin/bash",
    ["-c", `sleep 30 & printf '%s\\n' "$!" > ${JSON.stringify(childFile)}`],
    { detached: true, stdio: ["ignore", "ignore", "ignore"] },
  );
  const group = child.pid ?? 0;
  await new Promise((settle) => child.once("exit", settle));
  const kept = Number(readFileSync(childFile, "utf8").trim());
  return {
    group,
    child: kept,
    stop: () => {
      try {
        process.kill(-group, "SIGKILL");
      } catch {
        // Already gone, which is what the test wanted either way.
      }
    },
  };
}

/** Whether the process is there, asked without signalling it. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A directory holding a `ps` that answers nothing, ahead of the real one on the path. */
function brokenPs(directory: string): string {
  const binaries = join(directory, "bin");
  mkdirSync(binaries, { recursive: true });
  const ps = join(binaries, "ps");
  writeFileSync(ps, '#!/bin/sh\necho "ps fell over" >&2\nexit 2\n', "utf8");
  chmodSync(ps, 0o755);
  return `${binaries}:${process.env["PATH"] ?? ""}`;
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((settle) => setTimeout(settle, milliseconds));
}

/** A fresh directory, removed however the test ends. */
async function inADirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "squiz-groups-"));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
