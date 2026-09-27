/**
 * What the episode's summary comment is composed from, and what reaches `gh`.
 *
 * The body is asserted against what the composer produced for the same episode,
 * because a test that asserted a call had been made would pass on an empty body
 * and the comment is posted once and never edited.
 *
 * A real `gh` on `PATH` rather than an injected runner: the body goes to the
 * subprocess on stdin, and an injected runner would stand exactly where the
 * evidence is.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { renderComment } from "../findings/comment.ts";
import type { Finding } from "../findings/finding.ts";
import type { GhCall } from "../github/gh.ts";
import { renderSummary } from "../github/summary-body.ts";
import type { ReviewThread } from "../github/threads.ts";
import { unspent, type RoundCost } from "../reviewers/adapter.ts";
import { deadlineIn } from "../reviewers/deadline.ts";
import type { PostedFindings } from "./post-findings.ts";
import { postEpisodeSummary, summaryNotComposed, type ClosingRound } from "./post-summary.ts";

const PULL_REQUEST = 142;

const COST: RoundCost = { dollars: 0.04, tokens: 1200, messages: 3 };

/** A response as `gh api --include` writes one: status line, headers, body. */
function included(status: string, body: string): string {
  return `HTTP/2.0 ${status}\nContent-Type: application/json; charset=utf-8\r\n\r\n${body}`;
}

const CREATED = included("201 Created", '{"id":2140876531,"node_id":"IC_kwDOUEd2qM7q-4A7"}');

type FakeGh = {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly status?: number;
};

/** One call to `gh`: its arguments, and the body it was handed on stdin. */
type Fake = {
  readonly arguments: () => readonly string[];
  readonly stdin: () => string;
  /** How many times `gh` ran, which is how many comments were posted. */
  readonly runs: () => number;
};

async function withFakeGh<T>(fake: FakeGh, body: (gh: Fake) => Promise<T> | T): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-post-summary-"));
  const argumentLog = join(directory, "arguments");
  const stdinLog = join(directory, "stdin");
  const runLog = join(directory, "runs");
  const script = [
    "#!/bin/sh",
    `printf 'x' >> ${quote(runLog)}`,
    'for argument in "$@"; do',
    `  printf '%s\\n' "$argument" >> ${quote(argumentLog)}`,
    "done",
    `cat > ${quote(stdinLog)}`,
    `printf '%s' ${quote(fake.stdout ?? "")}`,
    `printf '%s' ${quote(fake.stderr ?? "")} >&2`,
    `exit ${fake.status ?? 0}`,
    "",
  ].join("\n");

  const previous = process.env["PATH"];
  try {
    await writeFile(join(directory, "gh"), script, "utf8");
    await chmod(join(directory, "gh"), 0o755);
    process.env["PATH"] = `${directory}:${previous ?? ""}`;
    return await body({
      arguments: () => lines(argumentLog),
      stdin: () => contents(stdinLog),
      runs: () => contents(runLog).length,
    });
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function lines(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

function contents(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** `text` as one shell word, so a fixture can hold whatever it needs to. */
function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** The comment body `gh` was handed, or a failure naming what arrived instead. */
function sent(stdin: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch {
    return assert.fail(`gh was handed what is not JSON: ${stdin}`);
  }
  assert.ok(
    typeof parsed === "object" && parsed !== null && "body" in parsed,
    `gh was handed no body: ${stdin}`,
  );
  return String(parsed.body);
}

function finding(headline: string): Finding {
  return {
    scope: "line",
    file: "src/ui/card.ts",
    line: 88,
    severity: "high",
    headline,
    reasoning: ["The caller reads the old value."],
    suggestedFix: "Rename it.",
  };
}

/** A finding about the change as a whole, which no thread on the diff can hold. */
function generalFinding(headline: string): Finding {
  return {
    scope: "change",
    severity: "medium",
    headline,
    reasoning: ["The scheduler already does this."],
    suggestedFix: "Delete one of them.",
  };
}

/** A thread of an earlier round, as the closing round's own listing read it back. */
function handedOver(id: string, headline: string): ReviewThread {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path: "src/ui/card.ts",
    anchor: { at: "line", line: 88 },
    comments: [{ databaseId: 51, author: "squiz", body: renderComment(finding(headline)) }],
  };
}

/** What the closing round raised: one finding no thread holds, so Notes carries it. */
const findings: PostedFindings = {
  outcomes: [
    {
      outcome: "noted",
      finding: generalFinding("The queue duplicates the scheduler"),
      location: undefined,
    },
  ],
};

/** An episode of two rounds, closing at its cap with one thread still open. */
const closing: ClosingRound = {
  pullRequest: PULL_REQUEST,
  rounds: [COST, COST],
  handedOver: [handedOver("PRRT_one", "The name says nothing")],
  verdicts: {
    threads: [{ thread: "PRRT_one", ruled: "open", outcome: "left-open" }],
    unapplied: [],
  },
  findings,
  because: "round-cap",
};

/** A margin with time left on it, which is what a round hands over. */
function margin(): GhCall {
  return { directory: tmpdir(), until: deadlineIn(30_000) };
}

test("the body posted is the body the composer wrote for the episode", async () => {
  await withFakeGh({ stdout: CREATED }, (gh) => {
    const posting = postEpisodeSummary(closing, margin());

    assert.deepEqual(posting, { outcome: "posted" });
    assert.equal(
      sent(gh.stdin()),
      renderSummary({
        rounds: closing.rounds,
        threads: [
          {
            status: "open",
            headline: "The name says nothing",
            location: "src/ui/card.ts:88",
          },
        ],
        findings,
        because: "round-cap",
      }),
      "the comment is never edited, so a body composed from anything but the episode is permanent",
    );
  });
});

test("the composed body carries the counts, the spend, what needs a person and the notes", async () => {
  // The whole comment, so that a block dropped on the way to `gh` is a failure
  // here rather than a summary that reads as a review with nothing to report.
  await withFakeGh({ stdout: CREATED }, (gh) => {
    postEpisodeSummary(closing, margin());

    assert.equal(
      sent(gh.stdin()),
      [
        "**Squiz review — 2 rounds, 2 findings**",
        "",
        "Fixed 0 · Withdrawn 0 · Open 1 · Disputed 0",
        "2,400 tokens over 2 rounds: 1,200, 1,200 · $0.0800",
        "",
        "**Needs a person**",
        "",
        "- `src/ui/card.ts:88` — The name says nothing (open)",
        "",
        "**Notes**",
        "",
        "- About the change as a whole: The queue duplicates the scheduler",
        "- The episode ended at its round cap rather than with nothing left open",
      ].join("\n"),
    );
  });
});

test("the comment is created on the pull request, once", async () => {
  await withFakeGh({ stdout: CREATED }, (gh) => {
    postEpisodeSummary(closing, margin());

    assert.equal(gh.runs(), 1, "a second call would post a second comment for one episode");
    assert.deepEqual(gh.arguments(), [
      "api",
      "--include",
      "--method",
      "POST",
      `repos/{owner}/{repo}/issues/${PULL_REQUEST}/comments`,
      "--input",
      "-",
    ]);
  });
});

test("a summary GitHub would not take comes back as a failure with its reason", async () => {
  await withFakeGh(
    { status: 1, stdout: included("403 Forbidden", '{"message":"Forbidden"}'), stderr: "gh: Forbidden (HTTP 403)\n" },
    () => {
      const posting = postEpisodeSummary(closing, margin());

      assert.equal(posting.outcome, "failed");
      assert.match(
        posting.outcome === "failed" ? posting.reason : "",
        /HTTP 403/u,
        "the pointer on the hook's stderr is the only place this failure is ever reported",
      );
    },
  );
});

/**
 * A window already spent makes no call at all.
 *
 * A call made past the end of the window is one the runtime kills the hook
 * during, and the round would then end having said nothing at all.
 */
/**
 * A close reached before the review composes nothing, and says what the episode
 * loses by it. The rounds it ran are the whole of what decides that.
 */
test("a close before the review names the rounds whose findings nothing reports", () => {
  const never = summaryNotComposed({
    pullRequest: PULL_REQUEST,
    rounds: [COST, COST],
    spentOutsideRounds: unspent,
  });

  assert.equal(never.outcome, "never-composed");
  assert.match(
    never.outcome === "never-composed" ? never.reason : "",
    /nothing reports the 2 rounds it ran/u,
    "a person told only that a bound was spent has no reason to go and read the threads",
  );
});

test("an episode that ran no round at all is named as one that never ran", () => {
  // Nothing reviewed it, so there is nothing for a comment to carry. It is still
  // a close at exit 0, and silence there reads as a review that went fine.
  const never = summaryNotComposed({
    pullRequest: PULL_REQUEST,
    rounds: [],
    spentOutsideRounds: unspent,
  });

  assert.deepEqual(never, {
    outcome: "never-composed",
    reason: "no round of the episode ever ran",
  });
});

test("a margin with nothing left on it posts nothing and says so", async () => {
  await withFakeGh({ stdout: CREATED }, (gh) => {
    const posting = postEpisodeSummary(closing, { directory: tmpdir(), until: deadlineIn(0) });

    assert.equal(gh.runs(), 0, "gh was run with no time to answer in");
    assert.equal(posting.outcome, "failed");
    assert.match(posting.outcome === "failed" ? posting.reason : "", /ran out before this call was made/u);
  });
});
