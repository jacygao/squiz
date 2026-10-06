import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { standIn } from "../testing/stand-in.ts";
import { deadlineIn } from "./deadline.ts";
import {
  discardRoundSpace,
  KEEPER_VARIABLE,
  makeRoundSpace,
  RECORD_VARIABLE,
  recordedGroups,
  shellPrefix,
  stopRecordedGroups,
  type GroupsStopped,
  type RoundSpace,
} from "./groups.ts";

/** The grace each stop is given, short enough that the tests are not the grace. */
const GRACE_MS = 1_500;

/**
 * The reading bound every test but the two about it is given.
 *
 * Generous, so that a slow machine is never what a test is measuring. The two
 * tests of the bound itself pass their own.
 */
const INSPECTION_MS = 20_000;

/** Stop the round's groups, on a reading bound nothing here is waiting on. */
function stopGroups(space: RoundSpace): Promise<GroupsStopped> {
  return stopRecordedGroups(space, GRACE_MS, deadlineIn(INSPECTION_MS));
}

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

    const stopped = await stopGroups(space);
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

      const stopped = await stopGroups(space);
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

    const stopped = await stopGroups(space);
    assert.deepEqual(stopped, { signalled: [], refused: [] });
  });
});

/**
 * A shell that started nothing still leads a group its keeper holds, so the round
 * reaches it and the keeper goes with it. A group left unheld would be a number
 * free to name something else by the time the round read it.
 */
test("a shell that started nothing still has its group held, and the round signals it", async () => {
  await inADirectory(async (directory) => {
    const space = madeIn(directory);
    const shell = await shellRan("true", space);
    assert.equal(running(shell), false, "the shell exits first, which is the case this is for");

    const stopped = await stopGroups(space);
    assert.deepEqual(stopped.signalled, [shell]);
    assert.deepEqual(stopped.refused, []);
    assert.equal(
      heldBy(shell, space.keeperName),
      false,
      "the round's own keeper outlived the round that started it",
    );
  });
});

/**
 * Shutdown signals the group, waits the grace, then establishes identity again
 * before `SIGKILL`. The keeper answers that first signal and is gone by the
 * second reading, so what says the group is still this round's own is the
 * stubborn tool itself: the first reading found it in the group, and a number
 * cannot be handed out while anything still holds it.
 *
 * A second reading that asked for the keeper would refuse the group it had just
 * signalled, leaving running the one tool the escalation exists for.
 */
test("a tool that ignores SIGTERM is still killed, because the round saw it in the group", async () => {
  await inADirectory(async (directory) => {
    const space = madeIn(directory);
    const ready = join(directory, "ignoring");
    const childFile = join(directory, "stubborn");
    // The sleep is a child and answers the group's signal itself, so the loop is
    // what keeps the tool there after the signal rather than the trap alone.
    const tool = toolIn(
      directory,
      "ignores-term",
      ['trap "" TERM', `: > ${ready}`],
      "while true; do sleep 1; done",
    );
    const shell = await shellRan(`${tool} & printf '%s\\n' "$!" > ${childFile}`, space);
    const child = Number(readFileSync(childFile, "utf8").trim());
    await untilThere(ready);
    assert.ok(running(child), "nothing was left running for the escalation to reach");

    const stopped = await stopGroups(space);

    assert.deepEqual(stopped.signalled, [shell]);
    assert.deepEqual(stopped.refused, [], "the group was refused at the second reading");
    assert.equal(
      running(child),
      false,
      "a tool that ignored SIGTERM outlived the round, so the escalation never reached it",
    );
  });
});

/**
 * The second reading accepts a group only where it still holds a process the
 * first one found. Every process in this group began after the round signalled
 * it, so nothing says the number was not handed on in between, and `SIGKILL`
 * cannot be taken back.
 *
 * The tool answers `SIGTERM` by leaving a fresh process behind and exiting, which
 * is what empties the group of everything the first reading saw while leaving it
 * occupied.
 */
test("a group holding nothing the round saw in it is not killed outright", async () => {
  await inADirectory(async (directory) => {
    const space = madeIn(directory);
    const ready = join(directory, "forking");
    const afterFile = join(directory, "after-the-signal");
    const tool = toolIn(
      directory,
      "forks-on-term",
      [
        `after() { sleep 30 & printf '%s\\n' "$!" > ${afterFile}; exit 0; }`,
        "trap after TERM",
        `: > ${ready}`,
      ],
      "sleep 30",
    );
    const shell = await shellRan(`${tool} &`, space);
    await untilThere(ready);

    const stopped = await stopGroups(space);

    await untilThere(afterFile);
    const after = Number(readFileSync(afterFile, "utf8").trim());
    try {
      assert.deepEqual(stopped.signalled, [shell]);
      assert.equal(stopped.refused.length, 1, JSON.stringify(stopped.refused));
      assert.match(stopped.refused[0]?.reason ?? "", /was there when the round signalled it/u);
      assert.ok(
        running(after),
        "a group holding only processes the round never saw was killed outright",
      );
    } finally {
      try {
        process.kill(after, "SIGKILL");
      } catch {
        // Already gone, which the assertions above have already reported.
      }
    }
  });
});

/**
 * A backgrounded job stays in the shell's job table, and a bare `wait` waits for
 * every job there. A keeper left in that table makes `wait` sit out its whole
 * sleep, so a command joining its own parallel work would spend the round's bound
 * rather than return.
 */
test("a command that waits for its own background work is not held by the keeper", async () => {
  await inADirectory(async (directory) => {
    const space = madeIn(directory);
    const started = Date.now();
    const { status, stdout, pid: shell } = await runShell(
      `sleep 0.05 & wait; printf 'done\n'`,
      space,
    );
    const elapsedMs = Date.now() - started;

    assert.equal(status, 0);
    assert.equal(stdout.trim(), "done", "the command's own output is what the reviewer reads");
    assert.ok(
      elapsedMs < 5_000,
      `the keeper was still a job of the shell's, so wait sat out its sleep: ${elapsedMs}ms`,
    );
    assert.ok(
      heldBy(shell, space.keeperName),
      "leaving the job table must not cost the keeper its group",
    );
  });
});

/**
 * A shell whose keeper never started leaves the group to empty, and an empty
 * group is neither this round's to signal nor a stranger's to refuse. This is
 * what a shell without `exec -a` comes to.
 */
test("a group nothing holds is neither signalled nor refused", async () => {
  await inADirectory(async (directory) => {
    const space = madeIn(directory);
    const { pid: shell } = await runShell("true", space, "no keeper");
    assert.equal(running(shell), false);

    const stopped = await stopGroups(space);
    assert.deepEqual(stopped, { signalled: [], refused: [] });
  });
});

/**
 * The number of a group left unheld is handed out again inside one round — the
 * space turns over in well under a round's bound — and what takes it began after
 * the round did, exactly as everything the round started did. So age says nothing
 * here and the keeper is the whole of the answer.
 */
test("a group younger than the round but holding no keeper of it is left alone", async () => {
  await inADirectory(async (directory) => {
    const stranger = await detachedGroup(directory, "newcomer");
    try {
      const space = madeIn(directory);
      writeFileSync(space.shellRecord, `${stranger.group}\n`, "utf8");

      const stopped = await stopGroups(space);

      assert.deepEqual(stopped.signalled, []);
      assert.equal(stopped.refused.length, 1);
      assert.match(stopped.refused[0]?.reason ?? "", /is a keeper of this round/u);
      assert.ok(
        running(stranger.child),
        "a process younger than the round was killed over a number it was handed",
      );
    } finally {
      stranger.stop();
    }
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

      const stopped = await stopGroups(space);
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

/**
 * `ps` is a subprocess with no bound of its own, and the grace bounds the signals
 * rather than the readings between them. A reading that cannot be bounded holds
 * the round in its cleanup until the runtime kills the hook, with the review paid
 * for, its spend unrecorded and nothing posted.
 *
 * The shim hangs for longer than any grace here, and is asked about more groups
 * than one `ps` covers, so a reading that worked through its batches would take
 * several times what it is given.
 */
test("a ps that will not answer is cut off, and the groups it covered are left alone", async () => {
  await inADirectory(async (directory) => {
    const group = await detachedGroup(directory, "tool");
    const previous = process.env["PATH"];
    const calls = join(directory, "ps-calls");
    try {
      const space = madeIn(directory);
      const many = [group.group, ...Array.from({ length: 300 }, (_, at) => 100_000 + at)];
      writeFileSync(space.shellRecord, `${many.join("\n")}\n`, "utf8");
      process.env["PATH"] = hangingPs(directory, calls);

      const started = Date.now();
      const stopped = await stopRecordedGroups(space, GRACE_MS, deadlineIn(1_000));
      const took = Date.now() - started;

      assert.ok(took < HANGS_FOR_MS, `the shutdown took ${took}ms, so the reading was not bounded`);
      assert.deepEqual(stopped.signalled, []);
      assert.match(stopped.refused[0]?.reason ?? "", /ps ran out of the time/u);
      assert.ok(
        asked(calls) < 2,
        "the reading carried on to a second batch after the time it was given had gone",
      );
      assert.ok(running(group.child), "a group nothing could be established about was signalled");
    } finally {
      if (previous === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previous;
      group.stop();
    }
  });
});

/**
 * A bound with nothing left on it still has to cut the call off. `spawnSync` reads
 * a timeout of zero as no timeout at all, so this is the one bound under which the
 * call that went out would be the call nothing could stop.
 */
test("a shutdown with nothing left of its reading bound still cuts the reading off", async () => {
  await inADirectory(async (directory) => {
    const group = await detachedGroup(directory, "tool");
    const previous = process.env["PATH"];
    const calls = join(directory, "ps-calls");
    try {
      const space = madeIn(directory);
      writeFileSync(space.shellRecord, `${group.group}\n`, "utf8");
      process.env["PATH"] = hangingPs(directory, calls);

      const started = Date.now();
      const stopped = await stopRecordedGroups(space, GRACE_MS, deadlineIn(0));
      const took = Date.now() - started;

      assert.ok(
        took < HANGS_FOR_MS,
        `the shutdown took ${took}ms on a bound with nothing left of it`,
      );
      assert.deepEqual(stopped.signalled, []);
      assert.match(stopped.refused[0]?.reason ?? "", /ps ran out of the time/u);
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
    keeperName: "squiz-nowhere",
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

/**
 * The spaces the running test made, so that the keepers its shells left go with
 * it.
 *
 * A keeper holds its group's number for a quarter of an hour, and a test that
 * records a group without stopping it leaves one. Several of these tests do, and
 * a file run back to back would otherwise leave a process for each of them
 * sleeping on the machine the next run is timed on.
 */
let spacesMade: RoundSpace[] = [];

/**
 * The groups the running test's shells led, which is how a keeper is reached where
 * the record never named its group.
 */
let groupsLed: number[] = [];

function madeIn(directory: string): RoundSpace {
  const made = makeRoundSpace(directory);
  assert.equal(made.outcome, "made", "the round's own space must be there before anything records");
  const space = made.outcome === "made" ? made.space : ({} as RoundSpace);
  spacesMade.push(space);
  return space;
}

/**
 * Kill what the running test's own shells left holding their groups.
 *
 * Only a process whose `argv[0]` is one of this test's keeper names, which no other
 * round and nothing else on the machine answers to. A group number alone would not
 * do: by here it may name something the test never started.
 */
function discardKeepers(): void {
  const names = new Set(spacesMade.map((space) => space.keeperName).filter(Boolean));
  if (names.size === 0) return;
  const groups = new Set(groupsLed);
  for (const space of spacesMade) for (const group of recordedGroups(space)) groups.add(group);
  for (const group of groups) {
    const read = spawnSync("ps", ["-o", "pid=,command=", "-g", String(group)], {
      encoding: "utf8",
    });
    for (const row of read.stdout.split("\n")) {
      const [pid, ...rest] = row.trim().split(/\s+/u);
      if (pid === undefined || rest[0] === undefined || !names.has(rest[0])) continue;
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // The test stopped the group itself, which is most of them.
      }
    }
  }
}

type ShellOutput = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * Run one command behind the prefix, on the line before it, with the shell
 * detached so that it leads its own group, and the record named in
 * the environment.
 *
 * It waits for the shell's own exit rather than for its output to close, because
 * a backgrounded descendant holds the pipe open after the shell has gone.
 */
function runShell(
  command: string,
  space: RoundSpace,
  keeper: "keeper" | "no keeper" = "keeper",
): Promise<ShellOutput & { pid: number }> {
  const child = spawn("/bin/bash", ["-c", `${shellPrefix}\n${command}`], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      [RECORD_VARIABLE]: space.shellRecord,
      // Unset is what a shell without `exec -a` comes to: the group is recorded
      // and nothing holds it.
      ...(keeper === "keeper" ? { [KEEPER_VARIABLE]: space.keeperName } : {}),
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  groupsLed.push(child.pid ?? 0);
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

/**
 * The command for a tool that sets itself up, says so, and then holds.
 *
 * The lines of `setup` run before the file the test waits on appears, so a test
 * that waits for it knows the handler is installed. Without that the round's
 * signal can arrive first, and a tool that died on it exercises nothing.
 *
 * The command hands the script to bash rather than executing the file. macOS
 * checks a new executable the first time it runs, one at a time across the
 * machine, and under other suites that check can outlast the wait for the tool
 * to start.
 */
function toolIn(
  directory: string,
  name: string,
  setup: readonly string[],
  hold: string,
): string {
  const path = join(directory, name);
  writeFileSync(path, [...setup, hold, ""].join("\n"), "utf8");
  return `/bin/bash ${path}`;
}

/** Wait for the file to appear, failing the test rather than hanging if it does not. */
async function untilThere(path: string): Promise<void> {
  const until = Date.now() + 5_000;
  for (;;) {
    if (existsSync(path)) return;
    assert.ok(Date.now() < until, `${path} never appeared, so the tool never started`);
    await pause(10);
  }
}

/** Whether the group holds a process running under `named`. */
function heldBy(group: number, named: string): boolean {
  const read = spawnSync("ps", ["-o", "command=", "-g", String(group)], { encoding: "utf8" });
  return read.stdout.split("\n").some((row) => row.trim().split(/\s+/u)[0] === named);
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
  standIn(binaries, "ps", '#!/bin/sh\necho "ps fell over" >&2\nexit 2\n');
  return `${binaries}:${process.env["PATH"] ?? ""}`;
}

/**
 * How long the shim hangs, which every bound in these two tests is measured
 * against.
 *
 * Longer than any grace here, so a shutdown that waited on the shim would be
 * waiting on the shim rather than on anything it signalled, and an elapsed time
 * below this is the bound having done its work.
 */
const HANGS_FOR_MS = 30_000;

/**
 * A directory holding a `ps` that never answers, ahead of the real one on the path.
 *
 * It records each time it was run, so that a reading which carried on past the
 * time it was given is told from one that stopped.
 */
function hangingPs(directory: string, calls: string): string {
  const binaries = join(directory, "bin");
  mkdirSync(binaries, { recursive: true });
  // One process after the `exec`, so the bound's own kill reaches what is hanging
  // rather than a shell holding a child that outlives it.
  standIn(binaries, "ps", `#!/bin/sh\necho ran >> ${calls}\nexec sleep ${HANGS_FOR_MS / 1_000}\n`);
  return `${binaries}:${process.env["PATH"] ?? ""}`;
}

/**
 * How many times the shim got as far as saying it had run.
 *
 * None where the bound killed it before its first line, which is the same answer
 * as one for what the test asks: either way the reading was taken once and cut
 * off.
 */
function asked(calls: string): number {
  if (!existsSync(calls)) return 0;
  return readFileSync(calls, "utf8").trim().split("\n").length;
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((settle) => setTimeout(settle, milliseconds));
}

/** A fresh directory, removed however the test ends. */
async function inADirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "squiz-groups-"));
  spacesMade = [];
  groupsLed = [];
  try {
    await run(directory);
  } finally {
    discardKeepers();
    spacesMade = [];
    groupsLed = [];
    rmSync(directory, { recursive: true, force: true });
  }
}
