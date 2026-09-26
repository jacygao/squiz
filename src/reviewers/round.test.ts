import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type Adapter, type Invocation, unspent } from "./adapter.ts";
import { grants } from "./pi/argv.ts";
import { parse } from "./pi/parse.ts";
import { FINISH_REVIEW, REPORT_FINDING, REPORT_VERDICT } from "./pi/reporting.ts";
import { type Round, runRound } from "./round.ts";

/** The scratch space, named relative to the work tree as the harness names it. */
const scratchDirectory = ".squiz/agent-1/scratch";

/**
 * A short bound, in seconds.
 *
 * Every kill test runs the bound it is given, so it is the length of the tests
 * as well as the thing under test.
 */
const BOUND = 0.4;

test("the reviewer runs in the work tree holding the change", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(reporting("process.cwd()")).adapter, at(tree), 10);
    assert.equal(headlineOf(round), realpathSync(tree));
  });
});

test("TMPDIR is the scratch space, and it is there before the reviewer starts", async () => {
  await inATree(async (tree) => {
    const seen = reporting('process.env.TMPDIR + " exists:" + fs.existsSync(process.env.TMPDIR)');
    const round = await runRound(reviewer(seen).adapter, at(tree), 10);
    assert.equal(headlineOf(round), `${join(tree, scratchDirectory)} exists:true`);
  });
});

/**
 * With stdin inherited the reviewer blocks forever and emits nothing: no
 * output, no error, no exit, at any grant. A silent hang and a reviewer
 * thinking look the same from outside, so stdin is `/dev/null` unconditionally.
 */
test("stdin is /dev/null", async () => {
  await inATree(async (tree) => {
    const seen = reporting('fs.fstatSync(0).rdev === fs.statSync("/dev/null").rdev');
    const round = await runRound(reviewer(seen).adapter, at(tree), 10);
    assert.equal(headlineOf(round), "true");
  });
});

test("a review comes back with its findings, its verdicts and what it spent", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(reviewing).adapter, at(tree), 10);
    assert.equal(round.outcome, "reviewed");
    assert.deepEqual(round.outcome === "reviewed" ? round.findings : [], review.findings);
    assert.deepEqual(round.outcome === "reviewed" ? round.verdicts : [], review.verdicts);
    assert.deepEqual(round.cost, { dollars: 0.002, tokens: 100, messages: 1 });
  });
});

/**
 * The kill is the ordinary path rather than the exceptional one. Two runs of an
 * identical command over the same 450-line change took 408 seconds and 2,269,
 * against a default bound of 480.
 */
test("a reviewer that floods and does not stop is killed at the bound", async () => {
  await inATree(async (tree) => {
    const started = Date.now();
    const round = await runRound(reviewer(flooding).adapter, at(tree), BOUND);
    assert.deepEqual(round, {
      outcome: "timed-out",
      cost: spentOnce,
      seconds: BOUND,
      findings: review.findings,
      verdicts: [],
    });
    assert.ok(
      Date.now() - started < 10_000,
      "the bound has to stop a flooding reviewer, which is the reader's own loop rather than an idle one",
    );
  });
});

test("a reviewer that says nothing and does not stop is killed at the bound", async () => {
  await inATree(async (tree) => {
    const started = Date.now();
    const round = await runRound(reviewer(silent).adapter, at(tree), BOUND);
    assert.deepEqual(round, {
      outcome: "timed-out",
      cost: unspent,
      seconds: BOUND,
      findings: [],
      verdicts: [],
    });
    assert.ok(Date.now() - started < 10_000, "a silent reviewer is the hang the bound is for");
  });
});

/**
 * The run closes its own output and the round reads to the end of it. `pi`
 * answers the calls of one message in whatever order they complete, so a report
 * of the message that finished the review can be answered after the call that
 * finished it, and the message the reviewer closes its run with arrives after
 * both.
 */
test("the reports and the message that follow the finish are part of the round", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(finishingThenClosing(batched)).adapter, at(tree), 10);
    assert.equal(round.outcome, "reviewed", accountOf(round));
    assert.deepEqual(
      round.outcome === "reviewed" ? round.findings : [],
      batched,
      "a report accepted after the call that finished the review is a report the round has",
    );
    assert.deepEqual(
      round.cost,
      { dollars: 0.003, tokens: 200, messages: 2 },
      "the message the reviewer closed its run with was read and is paid for",
    );
  });
});

/**
 * A review the reviewer declared and a bound that ended the run are not in
 * conflict. The declaration is what says a review is finished, and a reviewer
 * that finishes a moment before the deadline and writes its closing message past
 * it has reviewed. A round that read the stop instead would keep the findings and
 * throw the review away, which the coding agent reads as a round nothing blocks
 * on.
 */
test("a round holding the declaration is the review it is, whatever ended the run", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(finishingThenHanging(tree)).adapter, at(tree), BOUND);
    assert.equal(round.outcome, "reviewed", accountOf(round));
    assert.deepEqual(round.outcome === "reviewed" ? round.findings : [], review.findings);
  });
});

/** Nothing waits without a bound, and a finished review is not a reviewer left running. */
test("a reviewer that finishes its review and then hangs is stopped at the bound", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(finishingThenHanging(tree)).adapter, at(tree), BOUND);
    assert.equal(round.outcome, "reviewed", accountOf(round));
    assert.ok(
      await gone(reviewerIn(tree)),
      "the reviewer is still running after the round it belongs to reported itself over",
    );
  });
});

/**
 * A reviewer can report a finding and then exhaust its provider's retries before
 * it finishes the review. The finding was confirmed and answered, so the round
 * has it; the round is still the setup problem the run turned into.
 */
test("a reviewer whose provider gave out after reporting keeps what it reported", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(reportingThenFailing).adapter, at(tree), 10);
    assert.equal(round.outcome, "setup", accountOf(round));
    assert.deepEqual(
      round.outcome === "setup" ? round.findings : [],
      review.findings,
      "a finding reported before the provider gave out is a finding the round has",
    );
    assert.match(round.outcome === "setup" ? round.reason : "", /no credential/u);
  });
});

test("the first attempt's findings survive a retry that completed no message", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(halfway, refusing).adapter, at(tree), 10);
    assert.equal(round.outcome, "setup", accountOf(round));
    assert.deepEqual(round.outcome === "setup" ? round.findings : [], review.findings);
  });
});

/**
 * A killed round is a failed round, which is not the same as a round that
 * honestly found nothing. Nothing may read one as the other, and what it keeps
 * is what the reviewer reported rather than a review it finished.
 */
test("a killed round keeps what was reported and is still not a review", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(flooding).adapter, at(tree), BOUND);
    assert.equal(round.outcome, "timed-out");
    assert.deepEqual(
      round.outcome === "timed-out" ? round.findings : [],
      review.findings,
      "a finding confirmed and reported before the kill is a finding the round has",
    );
  });
});

/** The messages that completed carry their cost; the request in flight is spent and never reported. */
test("a killed round records the cost of the messages that completed", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(flooding).adapter, at(tree), BOUND);
    assert.ok(round.cost.dollars > 0, "a kill records a floor rather than nothing");
  });
});

test("a killed round is not tried again", async () => {
  await inATree(async (tree) => {
    const running = reviewer(flooding);
    await runRound(running.adapter, at(tree), BOUND);
    assert.equal(running.starts(), 1, "the bound belongs to the round, not to each attempt");
  });
});

test("output that cannot be read is tried once more, with a fresh process", async () => {
  await inATree(async (tree) => {
    const running = reviewer(prose, reviewing);
    const round = await runRound(running.adapter, at(tree), 10);
    assert.equal(round.outcome, "reviewed");
    assert.equal(running.starts(), 2);
  });
});

test("a second unreadable output reports the reviewer unavailable", async () => {
  await inATree(async (tree) => {
    const running = reviewer(prose, prose);
    const round = await runRound(running.adapter, at(tree), 10);
    assert.equal(round.outcome, "unavailable");
    assert.deepEqual(round.outcome === "unavailable" ? round.findings : [], []);
    assert.equal(running.starts(), 2, "twice, and no more: a third would be the same again");
  });
});

/**
 * A round that failed twice still keeps what the reviewer got through, on the
 * same terms as a round that was killed.
 */
test("a round the reviewer never finished keeps what it reported", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(halfway, halfway).adapter, at(tree), 10);
    assert.equal(round.outcome, "unavailable");
    assert.deepEqual(round.outcome === "unavailable" ? round.findings : [], review.findings);
  });
});

/**
 * Two attempts are two readings of the same change, so the retry's reports are
 * the ones a round keeps. The first attempt's stand only where the retry got to
 * none of its own, which is a round that would otherwise throw away a finding
 * it had.
 */
test("the first attempt's findings stand where the retry reported nothing", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(halfway, prose).adapter, at(tree), 10);
    assert.equal(round.outcome, "unavailable");
    assert.deepEqual(round.outcome === "unavailable" ? round.findings : [], review.findings);
  });
});

test("a review the retry finished is the round's review, not the two together", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(halfway, reviewing).adapter, at(tree), 10);
    assert.equal(round.outcome, "reviewed");
    assert.deepEqual(round.outcome === "reviewed" ? round.findings : [], review.findings);
  });
});

/**
 * A run that completed no message is a setup problem rather than a bad round.
 * `pi` has already retried the request three times itself, so a second process
 * spends a second run watching the same failure.
 */
test("a run that completed no message is not tried again", async () => {
  await inATree(async (tree) => {
    const running = reviewer(refusing);
    const round = await runRound(running.adapter, at(tree), 10);
    assert.deepEqual(round, {
      outcome: "setup",
      cost: { dollars: 0, tokens: 0, messages: 1 },
      reason: "no credential for the provider",
      findings: [],
      verdicts: [],
    });
    assert.equal(running.starts(), 1);
  });
});

/**
 * The two failures reported as a setup problem rather than as a bad round arrive
 * as one outcome, each keeping its own account of itself. A reviewer that would
 * not start and one that ran and said nothing recur identically every firing, and
 * what separates them is the reason rather than the outcome.
 */
test("a process that ran and said nothing and a spawn that failed are both setup", async () => {
  await inATree(async (tree) => {
    const ran = await runRound(reviewer(sayingNothing).adapter, at(tree), 10);
    assert.equal(ran.outcome, "setup");
    assert.deepEqual(ran.cost, unspent);

    const missing: Adapter = {
      argv: (invocation) => ({
        command: join(tree, "no-such-reviewer"),
        args: [],
        directory: invocation.directory,
      }),
      parse,
      grants,
    };
    const never = await runRound(missing, at(tree), 10);
    assert.equal(never.outcome, "setup");
    assert.deepEqual(never.cost, unspent);
    assert.match(
      never.outcome === "setup" ? never.reason : "",
      /could not be started/u,
      "the reason is the only thing that says which of the two failed",
    );
  });
});

/**
 * An errored message among working ones is a retry rather than a failure. One
 * measured round carried twenty-two of them and still did a real review.
 */
test("a round that errored and recovered is a review", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(recovering).adapter, at(tree), 10);
    assert.equal(round.outcome, "reviewed");
  });
});

test("both attempts are paid for, and the round's cost is the two together", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(prose, reviewing).adapter, at(tree), 10);
    assert.deepEqual(round.cost, { dollars: 0.005, tokens: 200, messages: 2 });
  });
});

/**
 * The bound is the round's, so a retry runs on what the first attempt left of
 * it. A bound that started again would let one round run for twice its length,
 * which is the runtime killing the hook with nothing posted.
 */
test("the retry runs on what the first attempt left of the round's bound", async () => {
  await inATree(async (tree) => {
    const slow = `setTimeout(() => { ${prose} }, 700);`;
    const started = Date.now();
    const round = await runRound(reviewer(slow, flooding).adapter, at(tree), 1);
    const elapsed = Date.now() - started;
    assert.equal(round.outcome, "timed-out");
    assert.ok(
      elapsed < 1_800,
      `the round took ${elapsed}ms against a bound of 1000ms, which is the retry starting the bound again`,
    );
  });
});

/**
 * An attempt that ended after the bound without its process being stopped,
 * which is what a reader that starved the loop of its turns leaves behind: the
 * timer never ran, and no chunk arrived to read the clock against. There is no
 * round left to retry on, and the reason is the one the attempt gave.
 */
test("an attempt that ended past the bound is not tried again", async () => {
  await inATree(async (tree) => {
    let starts = 0;
    const starving: Adapter = {
      argv: (invocation) => {
        starts += 1;
        return { command: process.execPath, args: ["-e", ""], directory: invocation.directory };
      },
      parse: async () => {
        // Microtasks only: the loop never reaches the phase a timer runs on.
        const until = Date.now() + 400;
        while (Date.now() < until) await Promise.resolve();
        return { cost: unspent, result: { kind: "unparsed", reason: "nothing there" } };
      },
      grants,
    };
    const round = await runRound(starving, at(tree), 0.1);
    assert.equal(round.outcome, "unavailable");
    assert.match(round.outcome === "unavailable" ? round.reason : "", /no time was left/u);
    assert.equal(starts, 1);
  });
});

test("a reviewer that is not installed is a setup problem, named as one", async () => {
  await inATree(async (tree) => {
    const missing: Adapter = {
      argv: (invocation) => ({
        command: join(tree, "no-such-reviewer"),
        args: [],
        directory: invocation.directory,
      }),
      parse,
      grants,
    };
    const round = await runRound(missing, at(tree), 10);
    assert.equal(round.outcome, "setup");
    assert.match(round.outcome === "setup" ? round.reason : "", /could not be started/u);
  });
});

test("a scratch space that cannot be made is a setup problem, and nothing is run", async () => {
  await inATree(async (tree) => {
    const running = reviewer(reviewing);
    // A file where the directory has to go, which cannot be turned into one.
    writeFileSync(join(tree, "not-a-directory"), "");
    const round = await runRound(running.adapter, { ...at(tree), scratchDirectory: blocked }, 10);
    assert.equal(round.outcome, "setup");
    assert.equal(running.starts(), 0);
  });
});

/** Nothing throws: an adapter that does is a value the caller reads. */
test("an adapter that throws reading the output is output that could not be read", async () => {
  await inATree(async (tree) => {
    let starts = 0;
    const throwing: Adapter = {
      argv: (invocation) => {
        starts += 1;
        return {
          command: process.execPath,
          args: ["-e", reviewing],
          directory: invocation.directory,
        };
      },
      parse: () => Promise.reject(new Error("the adapter fell over")),
      grants,
    };
    const round = await runRound(throwing, at(tree), 10);
    assert.equal(round.outcome, "unavailable");
    assert.match(round.outcome === "unavailable" ? round.reason : "", /the adapter fell over/u);
    assert.equal(starts, 2);
  });
});

/**
 * A startup failure takes a different path from a provider that was reached and
 * failed. It never gets as far as the stream: the process exits non-zero with
 * an empty stdout, and its only account of itself is on stderr. Discarding that
 * leaves a typo in a model name reported as a generic bad round, every round,
 * forever.
 */
test("a reviewer that never started has its complaint carried, not discarded", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(refusingToStart).adapter, at(tree), 10);
    assert.equal(round.outcome, "setup");
    const reason = round.outcome === "setup" ? round.reason : "";
    assert.match(
      reason,
      /Unknown provider "nosuchprovider"/u,
      "the check that failed must be named",
    );
    assert.match(reason, /exited 1/u, "how it ended is what says the stream was never reached");
  });
});

/**
 * stderr is drained as it arrives rather than read at the end. A pipe nobody
 * reads fills at about 64KB and stops the process on the write that fills it,
 * which would turn a diagnostic into a hang, and holding all of it would put
 * back the memory problem the incremental reader exists to avoid.
 */
test("a reviewer that complains at length is drained as it goes, and only the end kept", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(complainingAtLength).adapter, at(tree), 10);
    assert.equal(round.outcome, "setup");
    const reason = round.outcome === "setup" ? round.reason : "";
    assert.match(reason, /the last thing it said/u, "the end of stderr is what is kept");
    assert.ok(
      reason.length < 2_500,
      `the reason ran to ${reason.length} characters, so stderr is being held rather than tailed`,
    );
  });
});

/**
 * A reviewer that ignores the signal is killed, and the tools it started go
 * with it. At depth `read` the grant is the only confinement there is, and a
 * subprocess outliving the round can still write to the tree the coding agent
 * is about to commit.
 */
test("a killed reviewer takes the processes it started with it", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(deaf(tree)).adapter, at(tree), BOUND);
    assert.equal(round.outcome, "timed-out");

    const descendant = toolIn(tree);
    assert.ok(
      await gone(descendant),
      `the process the reviewer started is still running ${descendant} after the round reported itself stopped`,
    );
  });
});

/**
 * An adapter need not be an async function, and one that throws before
 * returning its promise threw past the bound and the cleanup both: the round
 * came back as a setup problem with no cost, and the reviewer went on running.
 *
 * The reviewer here is stopped before it finishes starting, which is why what
 * is checked is that no process is left running it rather than a pid it never
 * got as far as recording.
 */
test("an adapter that throws before it returns still stops the reviewer", async () => {
  await inATree(async (tree) => {
    const marker = `squiz-probe-${process.pid}-${Date.now()}`;
    let starts = 0;
    const throwingSynchronously: Adapter = {
      argv: (invocation) => {
        starts += 1;
        return {
          command: process.execPath,
          args: ["-e", `/* ${marker} */ setInterval(() => {}, 1000);`],
          directory: invocation.directory,
        };
      },
      // Not an async function: the throw happens before any promise exists.
      parse: (_stdout, soFar) => {
        soFar?.({
          cost: { dollars: 0.004, tokens: 100, messages: 1 },
          findings: [],
          verdicts: [],
          finished: false,
        });
        throw new Error("the adapter fell over before it started");
      },
      grants,
    };

    const round = await runRound(throwingSynchronously, at(tree), 10);
    assert.equal(round.outcome, "unavailable", "a throw is output that could not be read");
    assert.deepEqual(round.cost, { dollars: 0.008, tokens: 200, messages: 2 });
    assert.equal(starts, 2);
    assert.ok(await nothingRuns(marker), "the reviewer was left running");
  });
});

/**
 * A tool outlives the reviewer that started it, and stopping the reviewer is
 * not what stops it. `pi` starts ripgrep for `grep` and for `find` without
 * detaching it, so a reviewer that finishes while ripgrep is still running
 * leaves it in the round's own process group.
 *
 * At `read` a tool of that grant cannot write to the tree. The hole is the
 * mechanism rather than that tool, and what the grant allows is not what this
 * is entitled to rely on.
 */
test("a tool still running when the reviewer finishes is stopped with the round", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(leavingEarly(tree)).adapter, at(tree), 10);
    assert.equal(round.outcome, "reviewed", "the reviewer finished, and its round stands");
    assert.ok(
      await gone(toolIn(tree)),
      "the reviewer exited first, so nothing of the round was ever signalled",
    );
  });
});

/**
 * The reviewer taking the signal is not the round being over either. A round
 * that stopped waiting the moment the reviewer answered would never escalate
 * for the tool that did not.
 */
test("a tool that outlives a reviewer which took the signal is stopped too", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(obedient(tree)).adapter, at(tree), BOUND);
    assert.equal(round.outcome, "timed-out");
    assert.ok(await gone(toolIn(tree)), "the tool outlived the round that started it");
  });
});

/** The identifier of the reviewer itself, as the reviewer recorded it. */
function reviewerIn(tree: string): number {
  const reviewer = Number(readFileSync(join(tree, "pids"), "utf8").split(" ")[0]);
  assert.ok(Number.isInteger(reviewer), "the reviewer must have recorded its own identifier");
  return reviewer;
}

/** The identifier of the tool the reviewer started, as the reviewer recorded it. */
function toolIn(tree: string): number {
  const tool = Number(readFileSync(join(tree, "pids"), "utf8").split(" ")[1]);
  assert.ok(Number.isInteger(tool), "the reviewer must have recorded what it started");
  return tool;
}

/** Whether nothing is left running the command the marker names. */
async function nothingRuns(marker: string, milliseconds = 5_000): Promise<boolean> {
  const until = Date.now() + milliseconds;
  for (;;) {
    const listed = execFileSync("ps", ["-A", "-ww", "-o", "args="], { encoding: "utf8" });
    if (!listed.includes(marker)) return true;
    if (Date.now() > until) return false;
    await new Promise((settle) => setTimeout(settle, 25));
  }
}

/** Whether the process is gone, waited for rather than assumed. */
async function gone(pid: number, milliseconds = 5_000): Promise<boolean> {
  const until = Date.now() + milliseconds;
  for (;;) {
    try {
      // Signal 0 asks whether it could be signalled, and sends nothing.
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > until) return false;
    await new Promise((settle) => setTimeout(settle, 25));
  }
}

/**
 * Something that answers no signal, which only the escalation removes.
 *
 * It says it is up only once its handler is installed, so that a test never
 * passes because the signal arrived before the tool was deaf to it.
 */
function deafly(readyFile: string): string {
  return [
    "process.on('SIGTERM', () => {});",
    `require("node:fs").writeFileSync(${JSON.stringify(readyFile)}, "up");`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
}

/**
 * A reviewer that starts a tool answering no signal, waits for it to be up,
 * records both process identifiers, and then does what it is told.
 *
 * The tool is what `pi` leaves behind: its `grep` and its `find` both start
 * ripgrep without detaching it, so a tool of a round sits in the round's own
 * process group.
 */
function withTool(tree: string, andThen: string): string {
  const pidFile = join(tree, "pids");
  const readyFile = join(tree, "ready");
  return [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    `const tool = spawn(process.execPath, ["-e", ${JSON.stringify(deafly(readyFile))}], { stdio: "ignore" });`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, process.pid + " " + tool.pid);`,
    `const until = Date.now() + 10000;`,
    `while (!fs.existsSync(${JSON.stringify(readyFile)}) && Date.now() < until) {}`,
    andThen,
  ].join("\n");
}

/** A reviewer that answers no signal either, so that both need the escalation. */
function deaf(tree: string): string {
  return withTool(tree, "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);");
}

/** A reviewer that reviews and leaves while its tool is still running. */
function leavingEarly(tree: string): string {
  const answer = JSON.stringify(reportingMessage + reported);
  return withTool(tree, `process.stdout.write(${answer}, () => process.exit(0));`);
}

/** A reviewer that answers the signal, while the tool it started does not. */
function obedient(tree: string): string {
  return withTool(tree, "setInterval(() => {}, 1000);");
}

/** A reviewer that never reached the model, which says so on stderr and exits. */
const refusingToStart = [
  "process.stderr.write('Error: Unknown provider \"nosuchprovider\". Use --list-models to see available providers/models.\\n');",
  "process.exit(1);",
].join("\n");

/**
 * A reviewer that writes far more to stderr than a pipe holds before it exits,
 * and whose last line is the one worth keeping.
 */
const complainingAtLength = [
  'const noise = "a reviewer complaining\\n".repeat(50000);',
  "process.stderr.write(noise);",
  'process.stderr.write("the last thing it said\\n", () => process.exit(1));',
].join("\n");

/** What one attempt spent in the scripts that report one message. */
const spentOnce = { dollars: 0.002, tokens: 100, messages: 1 };

/** A path under the work tree that a directory cannot be made at. */
const blocked = "not-a-directory/scratch";

const finding = {
  scope: "line",
  file: "src/github/gh.ts",
  line: 42,
  severity: "high",
  headline: "The exit status is read before the process has exited",
  reasoning: ["`exitCode` is null until the process ends."],
  suggestedFix: "Await the exit event.",
};

const review = {
  findings: [finding],
  verdicts: [{ thread: "PRRT_kwDO", verdict: "fixed" }],
};

/** Three findings of one message, told apart by the line each is anchored to. */
const batched = [11, 22, 33].map((line) => ({ ...finding, line }));

type Running = {
  readonly adapter: Adapter;
  /** How many processes the round started. */
  readonly starts: () => number;
};

/**
 * An adapter whose command line is one of the scripts below, a fresh one per
 * attempt, and whose output is read by the adapter that ships.
 */
function reviewer(...scripts: readonly string[]): Running {
  let starts = 0;
  const adapter: Adapter = {
    argv: (invocation) => {
      const script = scripts[Math.min(starts, scripts.length - 1)] ?? "";
      starts += 1;
      return { command: process.execPath, args: ["-e", script], directory: invocation.directory };
    },
    parse,
    grants,
  };
  return { adapter, starts: () => starts };
}

function at(tree: string): Invocation {
  return {
    directory: tree,
    charterFile: join(tree, "charter.md"),
    prompt: "Review pull request 142.",
    sessionDirectory: ".squiz/agent-1/session",
    scratchDirectory,
    depth: "read",
    thinking: "medium",
  };
}

/** A fresh work tree, removed however the test ends. */
async function inATree(run: (tree: string) => Promise<void>): Promise<void> {
  const tree = mkdtempSync(join(tmpdir(), "squiz-round-"));
  try {
    await run(tree);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

/** What a round said for itself, so a refusal is read rather than guessed. */
function accountOf(round: Round): string {
  return `the round came back as ${JSON.stringify(round)}`;
}

function headlineOf(round: Round): string {
  assert.equal(round.outcome, "reviewed");
  const finding = round.outcome === "reviewed" ? round.findings[0] : undefined;
  assert.ok(finding !== undefined, "the reviewer reported nothing to read");
  return finding.headline;
}

/** One `message_end` line, as `pi` writes it. */
function said(text: string, stopReason: string, spend: number, errorMessage?: string): string {
  return `${JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason,
      ...(errorMessage === undefined ? {} : { errorMessage }),
      usage: {
        input: spend === 0 ? 0 : 100,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: spend === 0 ? 0 : 100,
        cost: { input: spend, output: 0, cacheRead: 0, cacheWrite: 0, total: spend },
      },
    },
  })}\n`;
}

/** A script writing the text given to stdout and exiting. */
function writing(text: string): string {
  return `process.stdout.write(${JSON.stringify(text)});`;
}

/** One reporting call answered, as `pi` writes the line it arrives on. */
function called(toolName: string, details: unknown, id = "call_1"): string {
  return `${JSON.stringify({
    type: "tool_execution_end",
    toolCallId: id,
    toolName,
    isError: false,
    result: { content: [{ type: "text", text: "Reported" }], details },
  })}\n`;
}

/** The assistant message the reporting calls hang off, priced at a round. */
const reportingMessage = said("reporting", "toolUse", 0.002);

/** The whole review reported, as the calls it arrives in. */
const reported =
  review.findings.map((finding) => called(REPORT_FINDING, finding)).join("") +
  review.verdicts.map((verdict) => called(REPORT_VERDICT, verdict)).join("") +
  called(FINISH_REVIEW, {});

/** A reviewer whose one finding is what it can see of its own process. */
function reporting(expression: string): string {
  const finding =
    '{ scope: "change", severity: "low", headline, reasoning: ["what it could see"], suggestedFix: "none" }';
  return [
    'const fs = require("node:fs");',
    `const headline = String(${expression});`,
    `process.stdout.write(${JSON.stringify(reportingMessage)});`,
    `const call = { type: "tool_execution_end", toolCallId: "call_1", toolName: ${JSON.stringify(REPORT_FINDING)}, isError: false, result: { content: [], details: ${finding} } };`,
    'process.stdout.write(JSON.stringify(call) + "\\n");',
    `process.stdout.write(${JSON.stringify(called(FINISH_REVIEW, {}))});`,
  ].join("\n");
}

/** A reviewer that reports its review through the calls, and finishes it. */
const reviewing = writing(reportingMessage + reported);

/** A reviewer whose request failed every time, and that completed no message. */
const refusing = writing(said("", "error", 0, "no credential for the provider"));

/** A reviewer that starts, writes nothing at all and exits cleanly. */
const sayingNothing = "process.exit(0);";

/** A reviewer whose request failed and was retried, and which then reviewed. */
const recovering = writing(
  said("", "error", 0, "503 from the provider").repeat(22) + reportingMessage + reported,
);

/** A reviewer that stopped without finishing its review, having reported nothing. */
const prose = writing(said("I had a look and it seems fine.", "stop", 0.003));

/** A reviewer that reports its one finding and then stops without finishing. */
const halfway = writing(
  reportingMessage +
    called(REPORT_FINDING, review.findings[0]) +
    said("that is what I have so far", "stop", 0),
);

/**
 * A reviewer that answers the call finishing its review first, writes the reports
 * of the same message a moment later, and closes its output on a message of its
 * own.
 *
 * It is what a run left to end itself writes after the declaration: the calls of
 * one message are answered in whatever order they complete, and the closing
 * message is one the model had already composed.
 */
function finishingThenClosing(reports: readonly unknown[]): string {
  const rest = reports.map((report, at) => called(REPORT_FINDING, report, `r${at}`)).join("");
  const closing = said("that is everything", "stop", 0.001);
  return [
    writing(reportingMessage + called(FINISH_REVIEW, {}, "f")),
    `setTimeout(() => { ${writing(rest + closing)} }, 300);`,
  ].join("\n");
}

/**
 * A reviewer that reports a finding, finishes its review, and then answers no
 * signal and never closes its output.
 *
 * It goes deaf before it writes anything, so that a round can never end it by
 * signalling a reviewer that had not installed its handler yet. It records its
 * own identifier, so that what the bound did to it is read rather than assumed.
 */
function finishingThenHanging(tree: string): string {
  const pidFile = join(tree, "pids");
  return [
    "process.on('SIGTERM', () => {});",
    "setInterval(() => {}, 1000);",
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    writing(
      reportingMessage + called(REPORT_FINDING, review.findings[0]) + called(FINISH_REVIEW, {}),
    ),
  ].join("\n");
}

/** A reviewer that reports a finding and whose provider then gives out. */
const reportingThenFailing = writing(
  reportingMessage +
    called(REPORT_FINDING, review.findings[0]) +
    said("", "error", 0, "no credential for the provider"),
);

/** A reviewer that reports one finding, then floods and never stops. */
const flooding = `${writing(reportingMessage + called(REPORT_FINDING, review.findings[0]))}
const padding = ${JSON.stringify(`${JSON.stringify({ type: "message_update", delta: "x".repeat(400) })}\n`)};
setInterval(() => { for (let at = 0; at < 200; at += 1) process.stdout.write(padding); }, 1);`;

/** A reviewer that writes nothing and never stops, which is the silent hang. */
const silent = "setInterval(() => {}, 1000);";
