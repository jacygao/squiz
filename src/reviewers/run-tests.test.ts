import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { deadlineIn } from "./deadline.ts";
import {
  discardRoundSpace,
  KEEPER_VARIABLE,
  makeRoundSpace,
  RECORD_VARIABLE,
  stopRecordedGroups,
} from "./groups.ts";
import {
  describeTestsRun,
  OUTPUT_CAP_BYTES,
  runTests,
  runTestsTool,
  STOP_MARGIN_MS,
  type RunTestsInput,
  type TestsRun,
} from "./run-tests.ts";

/** A round with far more time left than any command here takes. */
const PLENTY_MS = 120_000;

test("the tool takes no argument and is called run_tests", () => {
  assert.equal(runTestsTool.name, "run_tests");
  assert.deepEqual(runTestsTool.parameters, {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
});

test("with no test command configured, it runs nothing and says so as an error", async () => {
  await inPlace(async (place) => {
    const run = await runTests({ ...place, command: null });
    assert.equal(run.outcome, "not run");
    const said = describeTestsRun(run);
    assert.ok(said.isError, "a run that could not happen is the tool's error");
    assert.match(said.text, /no test command/iu);
  });
});

test("the command runs in the snapshot with TMPDIR at the scratch directory", async () => {
  await inPlace(async (place) => {
    const run = await runTests({ ...place, command: 'pwd; printf "tmp=%s\\n" "$TMPDIR"; exit 3' });
    assert.equal(run.outcome, "exited");
    assert.equal(run.outcome === "exited" ? run.status : undefined, 3);
    const text = textOf(run);
    assert.ok(text.includes(place.snapshot), `the command ran outside the snapshot: ${text}`);
    assert.ok(text.includes(`tmp=${place.scratch}`), `TMPDIR was not the scratch: ${text}`);
    const said = describeTestsRun(run);
    assert.ok(!said.isError, "a suite that ran and failed is a result, not the tool's error");
    assert.match(said.text, /exited 3/u);
  });
});

test("the command gets the environment it is handed and nothing of the process's own", async () => {
  await inPlace(async (place) => {
    process.env["SQUIZ_RUN_TESTS_LEAK"] = "leaked";
    try {
      const run = await runTests({
        ...place,
        environment: { ...place.environment, GIVEN: "given" },
        command: 'printf "%s %s\\n" "${GIVEN:-unset}" "${SQUIZ_RUN_TESTS_LEAK:-unset}"',
      });
      assert.equal(textOf(run).trim(), "given unset");
    } finally {
      delete process.env["SQUIZ_RUN_TESTS_LEAK"];
    }
  });
});

test("the output is cut to its last bytes, and the result names the cap", async () => {
  await inPlace(async (place) => {
    const total = OUTPUT_CAP_BYTES * 4;
    const run = await runTests({
      ...place,
      command: `head -c ${total} /dev/zero | tr '\\0' x; printf END >&2`,
    });
    assert.equal(run.outcome, "exited");
    const output = run.outcome === "exited" ? run.output : undefined;
    assert.equal(output?.bytes, total + 3, "every byte the command wrote is counted");
    assert.equal(output?.text.length, OUTPUT_CAP_BYTES);
    assert.ok(output?.text.endsWith("xEND"), "the tail is the end of the output, both streams");
    assert.ok(
      describeTestsRun(run).text.includes(OUTPUT_CAP_BYTES.toLocaleString("en")),
      "the reviewer is told how much it is shown",
    );
  });
});

test("a run cut short by the round says so, and not as a failing suite", async () => {
  await inPlace(async (place) => {
    const leftPid = join(place.scratch, "left");
    const started = Date.now();
    const run = await runTests({
      ...place,
      deadline: deadlineIn(STOP_MARGIN_MS + 1_000),
      command: `sleep 60 & printf '%s' "$!" > ${leftPid}; wait`,
    });
    const took = Date.now() - started;
    assert.equal(run.outcome, "stopped");
    assert.ok(took < STOP_MARGIN_MS + 1_000, `the stop ran past the round's deadline: ${took} ms`);
    const said = describeTestsRun(run);
    assert.doesNotMatch(said.text, /exited/u);
    assert.match(said.text, /time/u);
    assert.match(said.text, /says nothing about whether the tests pass/u);
    assert.ok(!running(Number(readFileSync(leftPid, "utf8"))), "the command's child outlived the stop");
  });
});

test("with too little of the round left to run and stop the tests, nothing runs", async () => {
  await inPlace(async (place) => {
    const ran = join(place.scratch, "ran");
    const run = await runTests({
      ...place,
      deadline: deadlineIn(STOP_MARGIN_MS - 1_000),
      command: `touch ${ran}`,
    });
    assert.equal(run.outcome, "not run");
    assert.ok(describeTestsRun(run).isError);
    assert.ok(!existsSync(ran), "the command ran with no time to stop it");
  });
});

test("a child the command leaves behind, ignoring SIGTERM, is killed before the run returns", async () => {
  await inPlace(async (place) => {
    const leftPid = join(place.scratch, "left");
    const command = [
      `sh -c 'trap "" TERM; printf "%s" "$$" > ${leftPid}; exec sleep 60' &`,
      `while [ ! -s ${leftPid} ]; do sleep 0.05; done`,
      "exit 0",
    ].join("\n");
    const run = await runTests({ ...place, command });
    assert.equal(run.outcome, "exited");
    assert.equal(run.outcome === "exited" ? run.status : undefined, 0);
    assert.ok(!running(Number(readFileSync(leftPid, "utf8"))), "the child outlived the run");
  });
});

test("a run the round ends from outside is reached through the round's record", async () => {
  await inPlace(async (place) => {
    const made = makeRoundSpace(place.scratch);
    assert.equal(made.outcome, "made");
    if (made.outcome !== "made") return;
    const space = made.space;
    try {
      const leftPid = join(place.scratch, "left");
      const running_ = runTests({
        ...place,
        environment: {
          ...place.environment,
          [RECORD_VARIABLE]: space.shellRecord,
          [KEEPER_VARIABLE]: space.keeperName,
        },
        command: `sleep 60 & printf '%s' "$!" > ${leftPid}; wait`,
      });
      await untilThere(leftPid);
      const stopped = await stopRecordedGroups(space, 1_500, deadlineIn(20_000));
      assert.equal(stopped.signalled.length, 1, `the round reached no group: ${JSON.stringify(stopped)}`);
      const run = await running_;
      assert.equal(run.outcome, "signalled");
      assert.match(describeTestsRun(run).text, /says nothing about whether the tests pass/u);
      assert.ok(!running(Number(readFileSync(leftPid, "utf8"))), "the child outlived the round");
    } finally {
      discardRoundSpace(space);
    }
  });
});

test("a snapshot that is not there is a run that could not start", async () => {
  await inPlace(async (place) => {
    const run = await runTests({ ...place, snapshot: join(place.scratch, "absent"), command: "true" });
    assert.equal(run.outcome, "not run");
    assert.ok(describeTestsRun(run).isError);
  });
});

type Place = Omit<RunTestsInput, "command">;

/** A snapshot and a scratch directory of their own, removed however the test ends. */
async function inPlace(body: (place: Place) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "squiz-run-tests-")));
  const snapshot = join(root, "tree");
  const scratch = join(root, "scratch");
  mkdirSync(snapshot);
  mkdirSync(scratch);
  try {
    await body({
      snapshot,
      scratch,
      deadline: deadlineIn(PLENTY_MS),
      environment: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function textOf(run: TestsRun): string {
  return "output" in run ? run.output.text : "";
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function untilThere(path: string): Promise<void> {
  const until = Date.now() + 10_000;
  while (!existsSync(path) || readFileSync(path, "utf8") === "") {
    assert.ok(Date.now() < until, `${path} never appeared, so the command never started`);
    await new Promise((settle) => setTimeout(settle, 20));
  }
}
