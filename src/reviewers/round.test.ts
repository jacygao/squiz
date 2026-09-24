import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type Adapter, type Invocation, unspent } from "./adapter.ts";
import { grants } from "./pi/argv.ts";
import { parse } from "./pi/parse.ts";
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
 * against a default bound of 420.
 */
test("a reviewer that floods and does not stop is killed at the bound", async () => {
  await inATree(async (tree) => {
    const started = Date.now();
    const round = await runRound(reviewer(flooding).adapter, at(tree), BOUND);
    assert.deepEqual(round, { outcome: "timed-out", cost: spentOnce, seconds: BOUND });
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
    assert.deepEqual(round, { outcome: "timed-out", cost: unspent, seconds: BOUND });
    assert.ok(Date.now() - started < 10_000, "a silent reviewer is the hang the bound is for");
  });
});

/**
 * A killed round is a failed round, which is not the same as a round that
 * honestly found nothing. Nothing may read one as the other.
 */
test("a killed round reports no findings and is not a review", async () => {
  await inATree(async (tree) => {
    const round = await runRound(reviewer(flooding).adapter, at(tree), BOUND);
    assert.notEqual(round.outcome, "reviewed");
    assert.ok(!("findings" in round));
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
    assert.equal(running.starts(), 2, "twice, and no more: a third would be the same again");
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
    });
    assert.equal(running.starts(), 1);
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

/** What one attempt spent in the scripts that report one message. */
const spentOnce = { dollars: 0.002, tokens: 100, messages: 1 };

/** A path under the work tree that a directory cannot be made at. */
const blocked = "not-a-directory/scratch";

const review = {
  findings: [
    {
      scope: "line",
      file: "src/github/gh.ts",
      line: 42,
      severity: "high",
      headline: "The exit status is read before the process has exited",
      reasoning: ["`exitCode` is null until the process ends."],
      suggestedFix: "Await the exit event.",
    },
  ],
  verdicts: [{ thread: "PRRT_kwDO", verdict: "fixed" }],
};

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

/** A reviewer whose one finding is what it can see of its own process. */
function reporting(expression: string): string {
  return [
    'const fs = require("node:fs");',
    `const headline = String(${expression});`,
    'const answer = JSON.stringify({ findings: [{ scope: "change", severity: "low", headline, reasoning: ["what it could see"], suggestedFix: "none" }], verdicts: [] });',
    'const line = { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: answer }], usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100, cost: { input: 0.002, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 } } } };',
    'process.stdout.write(JSON.stringify(line) + "\\n");',
  ].join("\n");
}

/** A reviewer that reviews and stops. */
const reviewing = writing(said(JSON.stringify(review), "stop", 0.002));

/** A reviewer whose request failed every time, and that completed no message. */
const refusing = writing(said("", "error", 0, "no credential for the provider"));

/** A reviewer whose request failed and was retried, and which then reviewed. */
const recovering = writing(
  said("", "error", 0, "503 from the provider").repeat(22) +
    said(JSON.stringify(review), "stop", 0.002),
);

/** A reviewer that answered in prose, which is not a review. */
const prose = writing(said("I had a look and it seems fine.", "stop", 0.003));

/** A reviewer that reports a message, then floods and never stops. */
const flooding = `${writing(said(JSON.stringify(review), "toolUse", 0.002))}
const padding = ${JSON.stringify(`${JSON.stringify({ type: "message_update", delta: "x".repeat(400) })}\n`)};
setInterval(() => { for (let at = 0; at < 200; at += 1) process.stdout.write(padding); }, 1);`;

/** A reviewer that writes nothing and never stops, which is the silent hang. */
const silent = "setInterval(() => {}, 1000);";
