import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { startChild, type ChildProcessHandle } from "../sessions/child.ts";
import type { Backends } from "../sessions/session.ts";

import { type Adapter, type Confinement, type Invocation, type ParsedRun, unspent } from "./adapter.ts";
import { copilot } from "./copilot/adapter.ts";
import { pi } from "./pi/adapter.ts";
import { grants } from "./pi/argv.ts";
import { readReports as parse } from "./pi/reports.ts";
import { REPORTS_VARIABLE } from "./report-file.ts";
import { FINISH_REVIEW, REPORT_FINDING, REPORT_VERDICT } from "./reporting.ts";
import { type Round, runRound } from "./round.ts";

/** The round's own `gh` configuration, named relative to the work tree as the harness names it. */
const githubConfigDirectory = ".squiz/1/rounds/1/gh";

/** The report file, named relative to the work tree as the harness names it. */
const reportsFile = ".squiz/1/rounds/1/reports.jsonl";

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

// Copilot's --disallow-temp-dir closes the system's temporary directory, so the
// reviewer's TMPDIR must be the one every snapshot is made in.
test("the reviewer's TMPDIR is the harness's own", async () => {
  await inATree(async (tree) => {
    const seen = reporting("String(process.env.TMPDIR)");
    const round = await runRound(reviewer(seen).adapter, at(tree), 10);
    assert.equal(headlineOf(round), tmpdir());
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
    assert.deepEqual(round.cost, { dollars: 0.003, tokens: 200, messages: 2 });
  });
});

/**
 * The kill is the ordinary path rather than the exceptional one. Two runs of an
 * identical command over the same 450-line change took 408 seconds and 2,269,
 * against the 480-second bound they ran under.
 */
test("a reviewer that floods and does not stop is killed at the bound", async () => {
  await inATree(async (tree) => {
    const started = Date.now();
    const round = await runRound(reviewer(flooding).adapter, at(tree), BOUND);
    assert.deepEqual(round, {
      outcome: "timed-out",
      cost: { ...spentOnce, floor: true },
      seconds: BOUND,
      refusals: 0,
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
      cost: { ...unspent, floor: true },
      seconds: BOUND,
      refusals: 0,
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

/**
 * A report the run accepted and the round could not read back is the two ends of
 * one report disagreeing, and no declaration settles it. A round that read the
 * declaration alone would come back as a review with that finding silently gone,
 * and where it was the only one the episode closes as though the reviewer had
 * found nothing.
 */
test("a declared review carrying a report that could not be read back fails at the bound", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(brokenThenHanging(tree)).adapter, at(tree), BOUND);
    assert.equal(round.outcome, "unavailable", accountOf(round));
    assert.match(
      round.outcome === "unavailable" ? round.reason : "",
      /a finding the reviewer reported names no severity/u,
      "the report the round could not read back is what the reason has to name",
    );
    assert.deepEqual(
      round.outcome === "unavailable" ? round.findings : [],
      review.findings,
      "a report the round did read is a report it keeps, whatever the round became",
    );
  });
});

/** The round's conclusion is its output's, and not whether the process stopped. */
test("the output that fails a round at the bound fails it the same way at its end", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(brokenThenClosing).adapter, at(tree), 10);
    assert.equal(round.outcome, "unavailable", accountOf(round));
    assert.match(
      round.outcome === "unavailable" ? round.reason : "",
      /a finding the reviewer reported names no severity/u,
    );
    assert.deepEqual(round.outcome === "unavailable" ? round.findings : [], review.findings);
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
    assert.ok((round.cost?.dollars ?? 0) > 0, "a kill records a floor rather than nothing");
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
      refusals: 0,
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
        stdin: "/dev/null",
        environment: {},
      }),
      parse,
      confine: handsNothingOver,
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

// Copilot refuses a model it does not offer by exiting before any request, and
// in a pane nothing of what it said reaches the round.
test("a run that completed no message on a configured model names the setting and the model", async () => {
  await inATree(async (tree) => {
    const configured = await runRound(reviewer(sayingNothing).adapter, { ...at(tree), model: "gpt-5-mini" }, 10);
    assert.equal(configured.outcome, "setup");
    assert.match(configured.outcome === "setup" ? configured.reason : "", /"model" in \.squiz\.json is "gpt-5-mini"/u);

    const unset = await runRound(reviewer(sayingNothing).adapter, at(tree), 10);
    assert.doesNotMatch(unset.outcome === "setup" ? unset.reason : "", /"model"/u);

    // A run that completed a message reached its model, whatever it then said.
    const reached = await runRound(reviewer(refusing).adapter, { ...at(tree), model: "gpt-5-mini" }, 10);
    assert.equal(reached.outcome === "setup" ? reached.reason : "", "no credential for the provider");
  });
});

// The round has no terminal to give. A line built for a pane would get
// `/dev/null` instead, and an interactive CLI there is a run nobody can see.
test("a command line that needs a terminal is not started without one", async () => {
  await inATree(async (tree) => {
    const marker = join(tree, "started");
    const panes: Adapter = {
      argv: (invocation) => ({
        command: process.execPath,
        args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`],
        directory: invocation.directory,
        stdin: "terminal",
        environment: {},
      }),
      parse,
      confine: handsNothingOver,
      grants,
    };
    const round = await runRound(panes, at(tree), 10);
    assert.equal(round.outcome, "setup");
    assert.match(round.outcome === "setup" ? round.reason : "", /terminal/u);
    assert.ok(!existsSync(marker), "the round started a line built for a pane");
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
    assert.deepEqual(round.cost, { dollars: 0.006, tokens: 300, messages: 3 });
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
        return {
          command: process.execPath,
          args: ["-e", ""],
          directory: invocation.directory,
          stdin: "/dev/null",
          environment: {},
        };
      },
      parse: async () => {
        // Microtasks only: the loop never reaches the phase a timer runs on.
        const until = Date.now() + 400;
        while (Date.now() < until) await Promise.resolve();
        return { cost: unspent, result: { kind: "unparsed", reason: "nothing there" } };
      },
      confine: handsNothingOver,
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
        stdin: "/dev/null",
        environment: {},
      }),
      parse,
      confine: handsNothingOver,
      grants,
    };
    const round = await runRound(missing, at(tree), 10);
    assert.equal(round.outcome, "setup");
    assert.match(round.outcome === "setup" ? round.reason : "", /could not be started/u);
  });
});

test("the prompt is in its file, whole, before the reviewer starts", async () => {
  await inATree(async (tree) => {
    const prompt = "# Review pull request #1\n\n\tA tab, then the diff.\n";
    const seen = reporting(`fs.readFileSync(${JSON.stringify(join(tree, ".squiz/1/rounds/1/prompt.md"))}, "utf8")`);
    const round = await runRound(reviewer(seen).adapter, { ...at(tree), prompt }, 10);
    assert.equal(headlineOf(round), prompt);
  });
});

test("a prompt that cannot be written is a setup problem, and nothing is run", async () => {
  await inATree(async (tree) => {
    const running = reviewer(reviewing);
    writeFileSync(join(tree, "not-a-directory"), "");
    const round = await runRound(running.adapter, { ...at(tree), promptFile: "not-a-directory/prompt.md" }, 10);
    assert.equal(round.outcome, "setup");
    assert.match(round.outcome === "setup" ? round.reason : "", /prompt could not be written/u);
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
          stdin: "/dev/null",
          environment: {},
        };
      },
      parse: () => Promise.reject(new Error("the adapter fell over")),
      confine: handsNothingOver,
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
 * failed. It never gets as far as the report file: the process exits non-zero
 * having written nothing, and its only account of itself is on stderr. Discarding that
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
 * with it. The grant is the only confinement there is, and a subprocess
 * outliving the round can still write to the tree the coding agent is about to
 * commit.
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
          stdin: "/dev/null",
          environment: {},
        };
      },
      // Not an async function: the throw happens before any promise exists.
      parse: (_reports, soFar) => {
        soFar?.({
          cost: { dollars: 0.004, tokens: 100, messages: 1 },
          findings: [],
          verdicts: [],
          refusals: 0,
          finished: false,
          broken: undefined,
        });
        throw new Error("the adapter fell over before it started");
      },
      confine: handsNothingOver,
      grants,
    };

    const round = await runRound(throwingSynchronously, at(tree), 10);
    assert.equal(round.outcome, "unavailable", "a throw is output that could not be read");
    assert.deepEqual(round.cost, { dollars: 0.008, tokens: 200, messages: 2, floor: true });
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

test("what the adapter puts on the environment reaches the reviewer", async () => {
  await inATree(async (tree) => {
    const running = reviewer(reporting("process.env.AN_ADAPTER_SETTING"));
    const adapter: Adapter = {
      ...running.adapter,
      confine: () => ({ outcome: "prepared", environment: { AN_ADAPTER_SETTING: "/somewhere" } }),
    };
    assert.equal(headlineOf(await runRound(adapter, at(tree), 10)), "/somewhere");
  });
});

// The Copilot adapter turns trust off by setting a variable empty, over a host
// whose own value would turn it on.
test("a variable the adapter sets empty reaches a reviewer with no terminal as set and empty", async () => {
  await inATree(async (tree) => {
    const running = reviewer(reporting("JSON.stringify(process.env.COPILOT_ALLOW_ALL)"));
    const adapter: Adapter = {
      ...running.adapter,
      confine: () => ({ outcome: "prepared", environment: { COPILOT_ALLOW_ALL: "" } }),
    };
    const { TMUX: _tmux, HERDR_SOCKET_PATH: _herdr, ...host } = process.env;
    const round = await runRound(adapter, at(tree), 10, {
      name: "squiz-reviewer",
      environment: { ...host, COPILOT_ALLOW_ALL: "true" },
    });
    assert.equal(headlineOf(round), '""');
  });
});

/** The four variables `gh` and most GitHub clients read a token from. */
const githubTokens = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const;

/**
 * A round host carrying every GitHub credential a variable or `gh`'s
 * configuration can, and no pane server.
 */
function hostWithGitHub(tree: string): Record<string, string | undefined> {
  const theirs = join(tree, "their-gh");
  mkdirSync(theirs, { recursive: true });
  writeFileSync(join(theirs, "hosts.yml"), "github.com:\n    oauth_token: gho_fromtheirconfig\n    user: someone\n");
  const { TMUX: _tmux, HERDR_SOCKET_PATH: _herdr, ...host } = process.env;
  return {
    ...host,
    ...Object.fromEntries(githubTokens.map((name) => [name, `gho_${name.toLowerCase()}`])),
    GH_CONFIG_DIR: theirs,
  };
}

/** What a reviewer reports of the GitHub credentials in its environment. */
const githubSeen = (): string =>
  reporting(
  `JSON.stringify([${githubTokens.map((name) => `process.env.${name}`).join(", ")}, ` +
    "process.env.GH_CONFIG_DIR, fs.readdirSync(process.env.GH_CONFIG_DIR)])",
);

for (const [name, shipped] of [
  ["pi", pi],
  ["Copilot", copilot],
] as const) {
  test(`the ${name} reviewer's environment carries no GitHub token and an empty gh configuration`, async () => {
    await inATree(async (tree) => {
      writeFileSync(join(tree, "charter.md"), "Review the change.\n");
      const running = reviewer(githubSeen());
      // The adapter's own confinement runs, so whatever it adds is in the environment read.
      const adapter: Adapter = { ...shipped, argv: running.adapter.argv, parse };
      const round = await runRound(adapter, at(tree), 10, { name: "squiz-reviewer", environment: hostWithGitHub(tree) });
      assert.equal(round.outcome, "reviewed", accountOf(round));
      assert.deepEqual(JSON.parse(headlineOf(round)), ["", "", "", "", join(tree, githubConfigDirectory), []]);
    });
  });
}

// A token an adapter or its command line put back would reach the reviewer, so
// the round's own variables are applied last.
test("neither the adapter nor its command line can hand the reviewer a GitHub token", async () => {
  await inATree(async (tree) => {
    const running = reviewer(githubSeen());
    const adapter: Adapter = {
      ...running.adapter,
      confine: () => ({ outcome: "prepared", environment: { GH_TOKEN: "gho_fromconfine" } }),
      argv: (invocation) => {
        const line = running.adapter.argv(invocation);
        return { ...line, environment: { ...line.environment, GITHUB_TOKEN: "gho_fromtheline" } };
      },
    };
    const round = await runRound(adapter, at(tree), 10, { name: "squiz-reviewer", environment: hostWithGitHub(tree) });
    assert.deepEqual(JSON.parse(headlineOf(round)).slice(0, 2), ["", ""]);
  });
});

test("a gh configuration an earlier attempt left is emptied before the round", async () => {
  await inATree(async (tree) => {
    const left = join(tree, githubConfigDirectory);
    mkdirSync(left, { recursive: true });
    writeFileSync(join(left, "hosts.yml"), "github.com:\n    oauth_token: gho_leftbehind\n");
    const round = await runRound(reviewer(githubSeen()).adapter, at(tree), 10);
    assert.deepEqual(JSON.parse(headlineOf(round)).at(-1), []);
  });
});

const ghInstalled = spawnSync("gh", ["--version"], { stdio: "ignore" }).status === 0;

// `gh auth status` reads the variables and the configuration directory. On
// macOS `gh auth token` can still read the system keychain, which no variable
// closes, so it is not what this asks.
test("a gh the reviewer starts finds no login", { skip: ghInstalled ? false : "gh is not installed" }, async () => {
  await inATree(async (tree) => {
    const asking = [
      'const asked = require("node:child_process").spawnSync("gh", ["auth", "status"], { encoding: "utf8" });',
      "const answer = (asked.stdout + asked.stderr).trim();",
    ].join("\n");
    const round = await runRound(reviewer(asking + "\n" + reporting("answer")).adapter, at(tree), 10, {
      name: "squiz-reviewer",
      environment: hostWithGitHub(tree),
    });
    assert.match(headlineOf(round), /not logged into any GitHub hosts/u);
  });
});

test("a confinement that could not be put in place is a setup problem, and nothing is run", async () => {
  await inATree(async (tree) => {
    const running = reviewer(reviewing);
    const adapter: Adapter = {
      ...running.adapter,
      confine: () => ({ outcome: "failed", reason: "the settings could not be written" }),
    };
    const round = await runRound(adapter, at(tree), 10);
    assert.equal(round.outcome, "setup");
    assert.equal(round.outcome === "setup" ? round.reason : "", "the settings could not be written");
    assert.equal(running.starts(), 0);
  });
});

/** A missing report file is a reviewer that reported nothing, never a clean review. */
test("a reviewer that exits cleanly leaving no report file is not a review", async () => {
  await inATree(async (tree) => {
    const removing = `require("node:fs").rmSync(process.env.${REPORTS_VARIABLE}); process.exit(0);`;
    const round = await runRound(reviewer(removing).adapter, at(tree), 10);
    assert.equal(round.outcome, "setup", accountOf(round));
    assert.match(round.outcome === "setup" ? round.reason : "", /completed no message/u);
  });
});

test("a report file an earlier run left is not read as this run's", async () => {
  await inATree(async (tree) => {
    const left = join(tree, reportsFile);
    mkdirSync(dirname(left), { recursive: true });
    writeFileSync(left, reportingMessage + reported + closing);
    const round = await runRound(reviewer(sayingNothing).adapter, at(tree), 10);
    assert.equal(round.outcome, "setup", accountOf(round));
  });
});

test("what the command line puts on the environment reaches the reviewer", async () => {
  await inATree(async (tree) => {
    const running = reviewer(reporting("process.env.SQUIZ_PROBE"));
    const adapter: Adapter = {
      ...running.adapter,
      argv: (invocation) => {
        const line = running.adapter.argv(invocation);
        return { ...line, environment: { ...line.environment, SQUIZ_PROBE: "from the line" } };
      },
    };
    assert.equal(headlineOf(await runRound(adapter, at(tree), 10)), "from the line");
  });
});

/** The file is read while it grows, so a read can land partway through a line. */
test("a line still being written when the file is read is read once it is whole", async () => {
  await inATree(async (tree) => {
    const line = called(REPORT_FINDING, review.findings[0]);
    const half = Math.floor(line.length / 2);
    const script = [
      writing(reportingMessage + line.slice(0, half)),
      `setTimeout(() => { ${writing(line.slice(half) + called(FINISH_REVIEW, {}) + closing)} }, 300);`,
    ].join("\n");
    const round = await runRound(reviewer(script).adapter, at(tree), 10);
    assert.equal(round.outcome, "reviewed", accountOf(round));
    assert.deepEqual(round.outcome === "reviewed" ? round.findings : [], review.findings);
  });
});

/** Once the process is gone nothing more of the line is coming. */
test("a last line with no newline when the reviewer exits fails the round", async () => {
  await inATree(async (tree) => {
    const cut = writing(reportingMessage + called(REPORT_FINDING, review.findings[0]) + '{"type":"finish"}');
    const round = await runRound(reviewer(cut).adapter, at(tree), 10);
    assert.equal(round.outcome, "unavailable", accountOf(round));
    assert.match(round.outcome === "unavailable" ? round.reason : "", /partway through a line/u);
    assert.deepEqual(round.outcome === "unavailable" ? round.findings : [], review.findings);
  });
});

/** The same file comes to the same thing whether the run stopped or hung. */
test("a line that cannot be read fails a round the bound ended with no finish", async () => {
  await inATree(async (tree) => {
    const output = reportingMessage + called(REPORT_FINDING, review.findings[0]) + "{not json\n";
    const round = await runRound(reviewer(hanging(tree, output)).adapter, at(tree), BOUND);
    assert.equal(round.outcome, "unavailable", accountOf(round));
    assert.match(round.outcome === "unavailable" ? round.reason : "", /could not be read/u);
    assert.deepEqual(round.outcome === "unavailable" ? round.findings : [], review.findings);
  });
});

test("a killed round's findings and its cost come from the same point in the file", async () => {
  await inATree(async (tree) => {
    const second = { ...finding, line: 43 };
    const output =
      reportingMessage +
      called(REPORT_FINDING, review.findings[0]) +
      reportingMessage +
      called(REPORT_FINDING, second);
    const round = await runRound(reviewer(hanging(tree, output)).adapter, at(tree), BOUND);
    assert.equal(round.outcome, "timed-out", accountOf(round));
    assert.deepEqual(round.outcome === "timed-out" ? round.findings : [], [finding, second]);
    assert.deepEqual(round.cost, { dollars: 0.004, tokens: 200, messages: 2, floor: true });
  });
});

/**
 * What the reviewer wrote after the last read and before it was stopped is part
 * of the round. This reviewer writes its finish only once it is told to stop,
 * behind more lines than one read takes, and exits straight after, so only a
 * read that goes on after the stop reaches it.
 */
test("what the reviewer wrote after the last read of its file is read once it is stopped", async () => {
  await inATree(async (tree) => {
    const line = JSON.stringify(`${JSON.stringify({ type: "usage", stopReason: "toolUse" })}\n`);
    const finish = JSON.stringify(called(FINISH_REVIEW, {}));
    const late = [
      `const tail = ${line}.repeat(100000) + ${finish};`,
      `process.on("SIGTERM", () => { require("node:fs").appendFileSync(process.env.${REPORTS_VARIABLE}, tail); process.exit(0); });`,
      "setInterval(() => {}, 1000);",
      writing(reportingMessage + called(REPORT_FINDING, review.findings[0])),
    ].join("\n");
    const round = await runRound(reviewer(late).adapter, at(tree), BOUND);
    assert.equal(round.outcome, "reviewed", accountOf(round));
  });
});

/**
 * The closing message comes after the finish, and the file can refuse its usage
 * with nothing written to say so. A finish is no proof that the cost is whole.
 */
test("a review whose closing message left no usage in the file has a cost that is a floor", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(writing(reportingMessage + reported)).adapter, at(tree), 10);
    assert.equal(round.outcome, "reviewed", accountOf(round));
    assert.deepEqual(round.cost, { dollars: 0.002, tokens: 100, messages: 1, floor: true });
  });
});

/**
 * A request in flight when the reviewer was stopped was spent and is never
 * reported, so a file ending on a message's usage proves nothing at the bound.
 */
test("a review the bound ended after its finish has a cost that is a floor", async () => {
  await inATree(async (tree) => {
    const output = reportingMessage + reported + closing;
    const round = await runRound(reviewer(hanging(tree, output)).adapter, at(tree), BOUND);
    assert.equal(round.outcome, "reviewed", accountOf(round));
    assert.equal(round.cost?.floor, true);
  });
});

test("a round whose retry's cost is a floor has a cost that is a floor", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(prose, writing(reportingMessage + reported)).adapter, at(tree), 10);
    assert.equal(round.outcome, "reviewed", accountOf(round));
    assert.deepEqual(round.cost, { dollars: 0.005, tokens: 200, messages: 2, floor: true });
  });
});

/**
 * Usage the reader could not count is spend the round knows it is missing,
 * however the file ends and whatever a retry then reports.
 */
test("usage that could not be read keeps the cost a floor through a retry that reviewed", async () => {
  await inATree(async (tree) => {
    const unreadable = `${JSON.stringify({
      type: "usage",
      stopReason: "toolUse",
      usage: { totalTokens: "many", cost: { total: 0.02 } },
    })}\n`;
    const first = writing(unreadable + called(FINISH_REVIEW, {}) + closing);
    const second = writing(called(FINISH_REVIEW, {}) + closing);
    const round = await runRound(reviewer(first, second).adapter, at(tree), 10);
    assert.equal(round.outcome, "reviewed", accountOf(round));
    assert.equal(round.cost?.floor, true, `the cost read as a total: ${JSON.stringify(round.cost)}`);
  });
});

/** A last line cut short at exit may have been a message's usage, like any line that cannot be read. */
test("a last line cut short keeps the cost a floor through a retry that reviewed", async () => {
  await inATree(async (tree) => {
    const first = writing(reportingMessage + said("cut", "stop", 0.01).slice(0, 40));
    const second = writing(called(FINISH_REVIEW, {}) + closing);
    const round = await runRound(reviewer(first, second).adapter, at(tree), 10);
    assert.equal(round.outcome, "reviewed", accountOf(round));
    assert.equal(round.cost?.floor, true, `the cost read as a total: ${JSON.stringify(round.cost)}`);
  });
});

test("the AI credits of two attempts are added up with the rest of their cost", async () => {
  await inATree(async (tree) => {
    let reads = 0;
    const crediting: Adapter = {
      ...reviewer(sayingNothing).adapter,
      parse: async () => {
        reads += 1;
        const cost = { dollars: 0, tokens: 100, messages: 1, credits: reads === 1 ? 0.5 : 0.25 };
        return reads === 1
          ? { cost, result: { kind: "unparsed", reason: "the reviewer did not finish its review" } }
          : { cost, result: { kind: "reviewed", findings: [], verdicts: [] } };
      },
    };
    const round = await runRound(crediting, at(tree), 10);
    assert.equal(round.outcome, "reviewed", accountOf(round));
    assert.deepEqual(round.cost, { dollars: 0, tokens: 200, messages: 2, credits: 0.75 });
  });
});

/**
 * Copilot reports its cost once, as it exits by itself, so one stopped at the
 * bound reported none. A zero marked a floor would read as "unknown" in the
 * summary and as a round that spent nothing against the token bound.
 */
test("a Copilot round stopped at its bound has no cost, rather than a floor", async () => {
  await inATree(async (tree) => {
    const reportingThenHanging = `${writing(`${JSON.stringify({ type: "report", call: REPORT_FINDING, value: review.findings[0] })}\n`)}
setInterval(() => {}, 1000);`;
    const stopped = asCopilot(reviewer(reportingThenHanging).adapter);
    const round = await runRound(stopped, at(tree), BOUND);
    assert.deepEqual(round, {
      outcome: "timed-out",
      cost: undefined,
      seconds: BOUND,
      refusals: 0,
      findings: review.findings,
      verdicts: [],
    });
  });
});

/**
 * Copilot writes its usage line only once it has exited by itself, so a usage
 * line read before the stop is the run's whole cost and not a floor.
 */
test("a Copilot round whose usage line was read before the stop keeps that cost", async () => {
  await inATree(async (tree) => {
    const usage = {
      type: "usage",
      usage: {
        totalNanoAiu: 360_000_000,
        modelMetrics: { "gpt-5-mini": { requests: { count: 5 }, usage: { inputTokens: 18_000, outputTokens: 200 } } },
      },
    };
    const finishedThenHanging = `${writing(`${JSON.stringify({ type: "finish" })}\n${JSON.stringify(usage)}\n`)}
setInterval(() => {}, 1000);`;
    const round = await runRound(asCopilot(reviewer(finishedThenHanging).adapter), at(tree), BOUND);
    assert.equal(round.outcome, "reviewed", accountOf(round));
    assert.deepEqual(round.cost, { dollars: 0, tokens: 18_200, messages: 5, credits: 0.36, models: ["gpt-5-mini"] });
  });
});

test("a Copilot round stopped before it reported anything has no cost either", async () => {
  await inATree(async (tree) => {
    const stopped = asCopilot(reviewer(silent).adapter);
    const round = await runRound(stopped, at(tree), BOUND);
    assert.equal(round.outcome, "timed-out", accountOf(round));
    assert.equal(round.cost, undefined, `a stopped Copilot round recorded ${JSON.stringify(round.cost)}`);
  });
});

/**
 * An attempt with no cost adds nothing to one that has a cost. The round keeps
 * the figure it has rather than losing it, and has no cost only where no attempt
 * had one.
 */
test("an attempt with no cost leaves the round the cost of the attempt that had one", async () => {
  await inATree(async (tree) => {
    const runs: readonly ParsedRun[] = [
      { cost: { dollars: 0, tokens: 100, messages: 1, credits: 0.5 }, result: { kind: "unparsed", reason: "the reviewer did not finish its review" } },
      { cost: undefined, result: { kind: "reviewed", findings: [], verdicts: [] } },
    ];
    let reads = 0;
    const answering: Adapter = {
      ...reviewer(sayingNothing).adapter,
      parse: async () => {
        const run = runs[Math.min(reads, runs.length - 1)];
        reads += 1;
        if (run === undefined) throw new Error("the fixture ran out of attempts to answer with");
        return run;
      },
    };
    const round = await runRound(answering, at(tree), 10);
    assert.equal(round.outcome, "reviewed", accountOf(round));
    assert.deepEqual(round.cost, { dollars: 0, tokens: 100, messages: 1, credits: 0.5 });
  });
});

test("a round no attempt of which had a cost has none", async () => {
  await inATree(async (tree) => {
    const costless: Adapter = {
      ...reviewer(sayingNothing).adapter,
      parse: async () => ({ cost: undefined, result: { kind: "unparsed", reason: "the reviewer did not finish its review" } }),
    };
    const round = await runRound(costless, at(tree), 10);
    assert.equal(round.outcome, "unavailable", accountOf(round));
    assert.equal(round.cost, undefined);
  });
});

/**
 * A report file that could not be read to its end leaves spend uncounted, so
 * the cost of an attempt whose read failed is a floor.
 */
test("an attempt whose report file could not be read has a cost that is a floor", async () => {
  await inATree(async (tree) => {
    const throwing: Adapter = {
      ...reviewer(reviewing).adapter,
      parse: async (_reports, soFar) => {
        soFar?.({
          cost: spentOnce,
          findings: [],
          verdicts: [],
          refusals: 0,
          finished: false,
          broken: undefined,
        });
        throw new Error("the file went away");
      },
    };
    const round = await runRound(throwing, at(tree), 10);
    assert.equal(round.outcome, "unavailable", accountOf(round));
    assert.equal(round.cost?.floor, true, `the cost read as a total: ${JSON.stringify(round.cost)}`);
  });
});

// The reviewer runs to its end before the start reports itself failed, as one
// does whose identity `ps` could not read in time.
test("a reviewer that ran before its start failed is charged what it reported spending", async () => {
  await inATree(async (tree) => {
    const ran = writing(reportingMessage + called(REPORT_FINDING, review.findings[0]));
    const round = await runRound(reviewer(ran).adapter, at(tree), 10, {
      name: "squiz-reviewer",
      backends: failingAfterItRan(),
    });
    assert.equal(round.outcome, "setup", accountOf(round));
    assert.deepEqual(round.cost, { ...spentOnce, floor: true }, "the start failed, and the message it completed was paid for");
  });
});

// Copilot writes its usage line only once it has exited by itself, so the line is its whole cost.
test("a Copilot reviewer that ran to its end before its start failed is charged its own total", async () => {
  await inATree(async (tree) => {
    const usage = {
      type: "usage",
      usage: {
        totalNanoAiu: 360_000_000,
        modelMetrics: { "gpt-5-mini": { requests: { count: 5 }, usage: { inputTokens: 18_000, outputTokens: 200 } } },
      },
    };
    const ran = writing(`${JSON.stringify(usage)}\n`);
    const round = await runRound(asCopilot(reviewer(ran).adapter), at(tree), 10, {
      name: "squiz-reviewer",
      backends: failingAfterItRan(),
    });
    assert.equal(round.outcome, "setup", accountOf(round));
    assert.deepEqual(round.cost, { dollars: 0, tokens: 18_200, messages: 5, credits: 0.36, models: ["gpt-5-mini"] });
  });
});

test("a Copilot reviewer that ran before its start failed and left no usage has a cost not known, not a zero", async () => {
  await inATree(async (tree) => {
    const round = await runRound(asCopilot(reviewer(sayingNothing).adapter), at(tree), 10, {
      name: "squiz-reviewer",
      backends: failingAfterItRan(),
    });
    assert.equal(round.outcome, "setup", accountOf(round));
    assert.deepEqual(round.cost, { ...unspent, floor: true }, "a reviewer that ran may have spent what it never reported");
  });
});

test("a start that failed before the reviewer ran spends nothing", async () => {
  await inATree(async (tree) => {
    const backends: Backends = {
      herdr: () => ({ outcome: "refused", reason: "not asked" }),
      tmux: () => ({ outcome: "refused", reason: "not asked" }),
      child: async () => ({ outcome: "failed", reason: "the reviewer could not be spawned" }),
    };
    const round = await runRound(reviewer(reviewing).adapter, at(tree), 10, { name: "squiz-reviewer", backends });
    assert.equal(round.outcome, "setup", accountOf(round));
    assert.deepEqual(round.cost, unspent);
  });
});

test("an attempt the harness threw out of is charged what its reviewer reported spending", async () => {
  await inATree(async (tree) => {
    const ran = writing(reportingMessage + called(REPORT_FINDING, review.findings[0]));
    const round = await runRound(reviewer(ran).adapter, at(tree), 10, {
      name: "squiz-reviewer",
      backends: breakingAfterItRan(1),
    });
    assert.equal(round.outcome, "setup", accountOf(round));
    assert.match(round.outcome === "setup" ? round.reason : "", /could not be run/u);
    assert.deepEqual(round.cost, { ...spentOnce, floor: true }, "the attempt's reviewer completed a paid message");
  });
});

test("an attempt the harness threw out of is charged beside the attempt before it", async () => {
  await inATree(async (tree) => {
    const second = writing(reportingMessage);
    const round = await runRound(reviewer(prose, second).adapter, at(tree), 10, {
      name: "squiz-reviewer",
      backends: breakingAfterItRan(2),
    });
    assert.equal(round.outcome, "setup", accountOf(round));
    assert.deepEqual(round.cost, { dollars: 0.005, tokens: 200, messages: 2, floor: true });
  });
});

/**
 * The reviewer is still running when the harness throws, as one is that is
 * mid-review. Its process group is stopped before the attempt returns, and its
 * spend is read after the stop: the message it completes after the signal is
 * part of what it cost.
 */
test("an attempt the harness threw out of stops its reviewer, then reads what it spent", async () => {
  await inATree(async (tree) => {
    const running = join(tree, "running");
    const script = withTool(
      tree,
      [
        // It takes its time over the last message, so a read that does not wait for the stop misses it.
        `process.on("SIGTERM", () => setTimeout(() => { ${appending(reportingMessage)} process.exit(0); }, 300));`,
        appending(reportingMessage),
        `fs.writeFileSync(${JSON.stringify(running)}, "up");`,
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const round = await runRound(reviewer(script).adapter, at(tree), 10, {
      name: "squiz-reviewer",
      backends: breakingWhileItRuns(running),
    });
    assert.equal(round.outcome, "setup", accountOf(round));
    assert.deepEqual(
      round.cost,
      { dollars: 0.004, tokens: 200, messages: 2, floor: true },
      "the spend was read before the reviewer was stopped",
    );
    assert.ok(await gone(reviewerIn(tree), 1_000), "the reviewer was left running after the attempt returned");
    assert.ok(await gone(toolIn(tree), 1_000), "the tool the reviewer started was left running after the attempt returned");
  });
});

/** Resolves once the child has exited. */
function exited(child: ChildProcessHandle): Promise<void> {
  return new Promise((settle) => {
    if (child.exitCode !== null || child.signalCode !== null) settle();
    child.once("exit", () => settle());
  });
}

/**
 * Backends that start the reviewer with no terminal, let it run to its end, and
 * then report the start failed, as one does whose reading of the reviewer's
 * identity failed after the reviewer ran.
 */
function failingAfterItRan(): Backends {
  return {
    herdr: () => ({ outcome: "refused", reason: "not asked" }),
    tmux: () => ({ outcome: "refused", reason: "not asked" }),
    child: async (command, environment, boundMs) => {
      const started = await startChild(command, environment, boundMs);
      if (started.outcome !== "started") return started;
      await exited(started.child);
      return { outcome: "failed", reason: "ps could not be run: a stand-in for ps failing", ran: true };
    },
  };
}

/**
 * Backends whose `attempt`th start lets the reviewer run to its end and then
 * hands the round a process with no stderr, which the round throws reading.
 */
function breakingAfterItRan(attempt: number): Backends {
  let starts = 0;
  return {
    herdr: () => ({ outcome: "refused", reason: "not asked" }),
    tmux: () => ({ outcome: "refused", reason: "not asked" }),
    child: async (command, environment, boundMs) => {
      starts += 1;
      const started = await startChild(command, environment, boundMs);
      if (started.outcome !== "started" || starts !== attempt) return started;
      await exited(started.child);
      const broken = new Proxy(started.child, {
        get: (target, property) => (property === "stderr" ? undefined : Reflect.get(target, property)),
      });
      return { ...started, child: broken };
    },
  };
}

/**
 * Backends that start the reviewer with no terminal, wait until it says it is
 * running, and hand the round a process with no stderr, which the round throws
 * reading while the reviewer runs on.
 */
function breakingWhileItRuns(runningFile: string): Backends {
  return {
    herdr: () => ({ outcome: "refused", reason: "not asked" }),
    tmux: () => ({ outcome: "refused", reason: "not asked" }),
    child: async (command, environment, boundMs) => {
      const started = await startChild(command, environment, boundMs);
      if (started.outcome !== "started") return started;
      const until = Date.now() + 10_000;
      while (!existsSync(runningFile) && Date.now() < until) await new Promise((settle) => setTimeout(settle, 25));
      const broken = new Proxy(started.child, {
        get: (target, property) => (property === "stderr" ? undefined : Reflect.get(target, property)),
      });
      return { ...started, child: broken };
    },
  };
}

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
  const answer = reportingMessage + reported + closing;
  return withTool(tree, `${appending(answer)}\nprocess.exit(0);`);
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
      return {
        command: process.execPath,
        args: ["-e", script],
        directory: invocation.directory,
        stdin: "/dev/null",
        environment: { [REPORTS_VARIABLE]: invocation.reportsFile },
      };
    },
    confine: handsNothingOver,
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
    promptFile: ".squiz/1/rounds/1/prompt.md",
    reportsFile,
    githubConfigDirectory,
    thinking: "medium",
    model: null,
    terminal: "none",
  };
}

/** The Copilot adapter, running the test's command line in place of Copilot's. */
function asCopilot(running: Adapter): Adapter {
  return { ...copilot, argv: running.argv, confine: handsNothingOver };
}

/** An adapter whose CLI is handed nothing outside its command line. */
function handsNothingOver(): Confinement {
  return { outcome: "prepared", environment: {} };
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

/** One assistant message's line of the report file, priced at `spend` against 100 tokens. */
function said(text: string, stopReason: string, spend: number, errorMessage?: string): string {
  void text;
  return `${JSON.stringify({
    type: "usage",
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
  })}\n`;
}

/** A statement appending the text given to the report file the round named. */
function appending(text: string): string {
  return `require("node:fs").appendFileSync(process.env.${REPORTS_VARIABLE}, ${JSON.stringify(text)});`;
}

/** A script appending the text given to the report file and exiting. */
function writing(text: string): string {
  return appending(text);
}

/** One reporting call's line, as the extension writes it once the call accepted it. */
function called(toolName: string, details: unknown, id = "call_1"): string {
  void id;
  if (toolName === FINISH_REVIEW) return `${JSON.stringify({ type: "finish" })}\n`;
  return `${JSON.stringify({ type: "report", call: toolName, value: details })}\n`;
}

/** The assistant message the reporting calls hang off, priced at a round. */
const reportingMessage = said("reporting", "toolUse", 0.002);

/** The message a reviewer closes its run with, after the finish. */
const closing = said("that is everything", "stop", 0.001);

/** The whole review reported, as the lines it arrives in. */
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
    appending(reportingMessage),
    `const line = { type: "report", call: ${JSON.stringify(REPORT_FINDING)}, value: ${finding} };`,
    `fs.appendFileSync(process.env.${REPORTS_VARIABLE}, JSON.stringify(line) + "\\n");`,
    appending(called(FINISH_REVIEW, {}) + closing),
  ].join("\n");
}

/** A reviewer that reports its review through the calls, finishes it, and closes. */
const reviewing = writing(reportingMessage + reported + closing);

/** A reviewer whose request failed every time, and that completed no message. */
const refusing = writing(said("", "error", 0, "no credential for the provider"));

/** A reviewer that starts, writes nothing at all and exits cleanly. */
const sayingNothing = "process.exit(0);";

/** A reviewer whose request failed and was retried, and which then reviewed. */
const recovering = writing(
  said("", "error", 0, "503 from the provider").repeat(22) + reportingMessage + reported + closing,
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
 * of the same message a moment later, and closes its run on a message of its
 * own.
 *
 * It is what a run left to end itself writes after the declaration: the calls of
 * one message are answered in whatever order they complete, and the closing
 * message is one the model had already composed.
 */
function finishingThenClosing(reports: readonly unknown[]): string {
  const rest = reports.map((report, at) => called(REPORT_FINDING, report, `r${at}`)).join("");
  return [
    writing(reportingMessage + called(FINISH_REVIEW, {}, "f")),
    `setTimeout(() => { ${writing(rest + closing)} }, 300);`,
  ].join("\n");
}

/**
 * A reviewer that writes what it is given, answers no signal and never exits.
 *
 * It goes deaf before it writes anything, so that a round can never end it by
 * signalling a reviewer that had not installed its handler yet. It records its
 * own identifier, so that what the bound did to it is read rather than assumed.
 */
function hanging(tree: string, output: string): string {
  const pidFile = join(tree, "pids");
  return [
    "process.on('SIGTERM', () => {});",
    "setInterval(() => {}, 1000);",
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    writing(output),
  ].join("\n");
}

/** A reviewer that reports a finding, finishes its review, and then hangs. */
function finishingThenHanging(tree: string): string {
  return hanging(
    tree,
    reportingMessage + called(REPORT_FINDING, review.findings[0]) + called(FINISH_REVIEW, {}),
  );
}

/** A finding a call accepted and the round cannot read back, its severity unknown. */
const unreadableFinding = { ...finding, severity: "critical" };

/**
 * A finished review carrying one report the round can read and one it cannot.
 *
 * The unreadable one was accepted where it was made, so the reviewer was told its
 * finding had landed.
 */
const brokenReview =
  reportingMessage +
  called(REPORT_FINDING, review.findings[0]) +
  called(REPORT_FINDING, unreadableFinding, "call_2") +
  called(FINISH_REVIEW, {});

/** A reviewer whose review is that one, and which then hangs. */
function brokenThenHanging(tree: string): string {
  return hanging(tree, brokenReview);
}

/** A reviewer whose review is that one, and which then exits. */
const brokenThenClosing = writing(brokenReview + closing);

/** A reviewer that reports a finding and whose provider then gives out. */
const reportingThenFailing = writing(
  reportingMessage +
    called(REPORT_FINDING, review.findings[0]) +
    said("", "error", 0, "no credential for the provider"),
);

/**
 * A reviewer that reports one finding, then writes to its report file as fast
 * as it can and never stops. The lines it floods with carry no usage, so the
 * cost is still the one message's.
 */
const flooding = `${writing(reportingMessage + called(REPORT_FINDING, review.findings[0]))}
const fs = require("node:fs");
const padding = ${JSON.stringify(`${JSON.stringify({ type: "usage", stopReason: "toolUse" })}\n`.repeat(200))};
setInterval(() => { fs.appendFileSync(process.env.${REPORTS_VARIABLE}, padding); }, 1);`;

/** A reviewer that writes nothing and never stops, which is the silent hang. */
const silent = "setInterval(() => {}, 1000);";
