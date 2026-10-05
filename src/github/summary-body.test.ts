/**
 * The whole comment is asserted, and not its parts. The failure worth catching
 * is a comment that is perfectly well formed and reports the episode wrongly,
 * which every assertion on one line of it at a time passes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChangeFinding, FileFinding, Finding, LineFinding } from "../findings/finding.ts";
import type { ThreadStatus } from "../findings/status.ts";
import type { ClassifiedThread } from "../loop/classify.ts";
import { nothingEstablished, type ConfinementEvidence } from "../loop/confinement.ts";
import type { FindingOutcome, PostedFindings } from "../loop/post-findings.ts";
import type { RoundCost } from "../reviewers/adapter.ts";
import { renderSummary, type ClosedEpisode } from "./summary-body.ts";

function round(dollars: number, tokens: number): RoundCost {
  return { dollars, tokens, messages: 4 };
}

function thread(
  status: ThreadStatus,
  location: string,
  headline: string | null = "Something is wrong here",
): ClassifiedThread {
  return { status, headline, location };
}

/** The body fields a summary prints none of, filled so a test names only its subject. */
const body = {
  severity: "high",
  reasoning: ["The defect, in one bullet."],
  suggestedFix: "Do the other thing.",
} as const;

function onTheChange(headline: string): ChangeFinding {
  return { scope: "change", headline, ...body };
}

function onLine(file: string, line: number, headline: string): LineFinding {
  return { scope: "line", file, line, headline, ...body };
}

function onFile(file: string, headline: string): FileFinding {
  return { scope: "file", file, headline, ...body };
}

/** A finding the summary carries, because no thread on the pull request holds it. */
function noted(finding: Finding, location?: string): FindingOutcome {
  return { outcome: "noted", finding, location };
}

function posted(...outcomes: readonly FindingOutcome[]): PostedFindings {
  return { outcomes };
}

/** A worktree every round had to itself and left alone. Nothing here is a note. */
const undisturbed: ConfinementEvidence = nothingEstablished;

/** An episode that raised nothing and closed with nothing open. */
const quiet: ClosedEpisode = {
  rounds: [round(0.0061, 20_100)],
  threads: [],
  findings: posted(),
  because: "nothing-open",
  confinement: undisturbed,
  leftNotReviewed: null,
};

/**
 * Everything an episode that raised nothing carries above its first note.
 *
 * The Notes heading is in here, so a test built on it fails as loudly for a
 * composer that dropped the block whole as for one that wrote the wrong line
 * under it.
 */
const quietOpens = [
  "**Squiz review — 1 round, 0 findings**",
  "",
  "Fixed 0 · Withdrawn 0 · Open 0 · Disputed 0",
  "20,100 tokens over 1 round: 20,100 · $0.0061",
  "",
  "**Needs a person**",
  "",
  "Nothing needs a person.",
  "",
  "**Notes**",
  "",
];

/** The comment for an episode that raised nothing and whose round found `found`. */
function aboutTheWorktree(found: Partial<ConfinementEvidence>): string {
  return renderSummary({ ...quiet, confinement: { ...undisturbed, ...found } });
}

/**
 * An episode with a thread in every status.
 *
 * Its Notes carries a finding about the change as a whole, and a file that
 * changed while the reviewer ran. Each is one line rather than wrapped, because
 * the comment a person reads is markdown and the wrap is not in it.
 */
test("the episode renders as the specification shows", () => {
  const episode: ClosedEpisode = {
    rounds: [round(0.0061, 20_100), round(0.0044, 16_400), round(0.0029, 11_700)],
    threads: [
      thread("open", "packages/sync/src/queue.ts:134", "Retry backoff resets on every enqueue"),
      thread("fixed", "packages/sync/src/queue.ts:88"),
      thread("disputed", "packages/sync/src/session.ts:57", "Clock skew is read as token expiry"),
      thread("withdrawn", "packages/sync/src/session.ts:12"),
      thread("open", "packages/sync/src/retry.ts", "Every path here is dead once the queue lands"),
      thread("fixed", "packages/sync/src/retry.ts:4"),
    ],
    findings: posted(
      noted(
        onTheChange(
          "the retry queue duplicates the scheduler already in" +
            " `packages/sync/src/scheduler.ts`, which nothing calls",
        ),
      ),
    ),
    because: "nothing-open",
    confinement: { ...undisturbed, changed: ["packages/sync/src/queue.test.ts"] },
    leftNotReviewed: null,
  };

  assert.equal(
    renderSummary(episode),
    [
      "**Squiz review — 3 rounds, 7 findings**",
      "",
      "Fixed 2 · Withdrawn 1 · Open 2 · Disputed 1",
      "48,200 tokens over 3 rounds: 20,100, 16,400, 11,700 · $0.0134",
      "",
      "**Needs a person**",
      "",
      "- `packages/sync/src/queue.ts:134` — Retry backoff resets on every enqueue (open)",
      "- `packages/sync/src/session.ts:57` — Clock skew is read as token expiry (disputed)",
      "- `packages/sync/src/retry.ts` — Every path here is dead once the queue lands (open)",
      "",
      "**Notes**",
      "",
      "- About the change as a whole: the retry queue duplicates the scheduler already in" +
        " `packages/sync/src/scheduler.ts`, which nothing calls",
      "- A file changed in the worktree while the reviewer ran:" +
        " `packages/sync/src/queue.test.ts`",
    ].join("\n"),
  );
});

/**
 * A heading with nothing under it reads as a report that failed to render, and
 * the comment is never edited, so the word must not be in a quiet episode's
 * comment at all.
 */
test("an episode with nothing to report carries no Notes heading", () => {
  const comment = renderSummary(quiet);
  assert.equal(
    comment,
    [
      "**Squiz review — 1 round, 0 findings**",
      "",
      "Fixed 0 · Withdrawn 0 · Open 0 · Disputed 0",
      "20,100 tokens over 1 round: 20,100 · $0.0061",
      "",
      "**Needs a person**",
      "",
      "Nothing needs a person.",
    ].join("\n"),
  );
  assert.ok(!comment.includes("Notes"), `a quiet episode carried a Notes heading: ${comment}`);
});

/**
 * The marker is what separates the summary from every comment the reviewer
 * posted, and `**Squiz review` is a prefix of `**Squiz reviewer`, so the
 * character after the name is the whole of the difference.
 */
test("the first line opens with the summary's marker and not the reviewer's", () => {
  const comment = renderSummary(quiet);
  assert.ok(comment.startsWith("**Squiz review — "), `the marker is missing: ${comment}`);
  assert.ok(
    !comment.startsWith("**Squiz reviewer"),
    `the summary opened with the reviewer's marker: ${comment}`,
  );
});

// Raised, in Notes, and carrying none of the four statuses.
test("a finding about the change as a whole counts and carries no status", () => {
  const comment = renderSummary({
    ...quiet,
    findings: posted(noted(onTheChange("the feature is already in `src/scheduler.ts`"))),
  });
  assert.equal(
    comment,
    [
      "**Squiz review — 1 round, 1 finding**",
      "",
      "Fixed 0 · Withdrawn 0 · Open 0 · Disputed 0",
      "20,100 tokens over 1 round: 20,100 · $0.0061",
      "",
      "**Needs a person**",
      "",
      "Nothing needs a person.",
      "",
      "**Notes**",
      "",
      "- About the change as a whole: the feature is already in `src/scheduler.ts`",
    ].join("\n"),
  );
});

/**
 * The location is carried as text precisely so that Notes can print it: no
 * thread was opened, so it is the whole of what a person has to go on.
 */
test("a finding no thread could hold is given the location the reviewer gave it", () => {
  const comment = renderSummary({
    ...quiet,
    findings: posted(
      noted(onLine("src/queue.ts", 134, "Retry backoff resets"), "src/queue.ts:134"),
      noted(onFile("src/retry.ts", "Nothing in this file is reached"), "src/retry.ts"),
    ),
  });
  assert.ok(
    comment.endsWith(
      [
        "**Notes**",
        "",
        "- `src/queue.ts:134` — Retry backoff resets (no thread could be opened for it)",
        "- `src/retry.ts` — Nothing in this file is reached (no thread could be opened for it)",
      ].join("\n"),
    ),
    `the unanchored findings were not given their locations: ${comment}`,
  );
  assert.ok(comment.includes("2 findings"), `the unanchored findings were not counted: ${comment}`);
});

/**
 * `headline` is null where the reviewer left it blank, so a summary that
 * interpolated it would print a line that stops after the location and reads as
 * a rendering that broke.
 */
test("a finding whose headline the reviewer left blank still reads as a sentence", () => {
  const comment = renderSummary({
    ...quiet,
    threads: [thread("open", "src/queue.ts:134", null)],
  });
  assert.ok(
    comment.includes(
      "- `src/queue.ts:134` — The reviewer left this finding's headline blank (open)",
    ),
    `a blank headline rendered as a line with a hole in it: ${comment}`,
  );
  assert.ok(!comment.includes("— null"), `the null headline was interpolated: ${comment}`);
});

// The threads keep the order they were classified in, which is the pull
// request's own order and not a grouping by status.
/**
 * A headline is the reviewer's own text and reaches the summary unchanged.
 * `readFinding` accepts a newline in one, and only the comment renderer collapsed
 * it, so a thread this round opened carries the newline into the summary while a
 * thread handed over does not. One finding then renders as two bullets under a
 * count that says one.
 */
test("a headline carrying newlines is one line of the summary, not two", () => {
  const broken = "Cache key misses the tenant\n\n- Reproduction detail";
  const summary = renderSummary({
    ...quiet,
    rounds: [round(0.0061, 20_100)],
    threads: [thread("open", "src/cache.ts:12", broken)],
    findings: posted(noted(onTheChange(broken)), noted(onLine("src/a.ts", 4, broken), "src/a.ts:4")),
  });

  assert.match(
    summary,
    /^- `src\/cache\.ts:12` — Cache key misses the tenant - Reproduction detail \(open\)$/mu,
    summary,
  );
  assert.equal(
    summary.split("\n").filter((each) => each.startsWith("- ")).length,
    3,
    `three findings rendered as more than three bullets:\n${summary}`,
  );
  assert.ok(!summary.includes("\n\n- Reproduction"), `a headline opened a block:\n${summary}`);
});

// Whitespace is all a headline has to be for the collapse to leave nothing, and a
// line naming neither a headline nor its absence reads as a rendering that broke.
test("a headline that is nothing but whitespace is named as missing", () => {
  const summary = renderSummary({
    ...quiet,
    rounds: [round(0.0061, 20_100)],
    threads: [thread("open", "src/cache.ts:12", "  \n ")],
  });

  assert.match(summary, /— The reviewer left this finding's headline blank \(open\)$/mu, summary);
});

test("the unsettled findings keep the order they were classified in", () => {
  const comment = renderSummary({
    ...quiet,
    threads: [
      thread("disputed", "src/a.ts:1", "First"),
      thread("fixed", "src/b.ts:2", "Second"),
      thread("open", "src/c.ts:3", "Third"),
    ],
  });
  assert.ok(
    comment.includes(
      ["- `src/a.ts:1` — First (disputed)", "- `src/c.ts:3` — Third (open)"].join("\n"),
    ),
    `the unsettled findings were reordered: ${comment}`,
  );
});

test("the round cap is a note, because nothing reviewed what is still open again", () => {
  const comment = renderSummary({
    ...quiet,
    threads: [thread("open", "src/queue.ts:134", "Retry backoff resets")],
    because: "round-cap",
  });
  assert.ok(
    comment.endsWith(
      [
        "**Notes**",
        "",
        "- The episode ended at its round cap rather than with nothing left open",
      ].join("\n"),
    ),
    `the round cap was not noted: ${comment}`,
  );
});

/**
 * A killed reviewer and a finished one both leave findings on the pull request,
 * so this line is the whole of what tells a person the review stopped early.
 */
test("a round the time bound cut short is a note naming the round and the bound", () => {
  const comment = renderSummary({
    ...quiet,
    rounds: [
      round(0.0061, 20_100),
      { ...round(0.0042, 9_800), elapsedSeconds: 481.7, cutShortAtSeconds: 480 },
      { ...round(0.0013, 3_100), elapsedSeconds: 40.2 },
    ],
    because: "round-cap",
  });
  assert.ok(
    comment.endsWith(
      [
        "**Notes**",
        "",
        "- The review was cut short by the 480-second time bound in round 2, and the round kept only the findings it had reported by then",
        "- The episode ended at its round cap rather than with nothing left open",
      ].join("\n"),
    ),
    `the cut was not noted: ${comment}`,
  );
});

test("the token bound is a note", () => {
  const comment = renderSummary({ ...quiet, because: "token-bound" });
  assert.ok(
    comment.endsWith("- The episode ended at the token bound rather than with nothing left open"),
    `the token bound was not noted: ${comment}`,
  );
});

/** The state the closing round reviewed, and states queued behind it, each a different head commit. */
const reviewed = { head: "3f9c2e07b1d4a8c6e5f0923b7a1d6c4e8b2f5a90", activity: null };
const later = { head: "8d21a4f0c3b2e1d4a5f6b7c8d9e0f1a2b3c4d5e6", activity: null };
const laterStill = { head: "c47e19b2a0d3f5e6c7b8a9d0e1f2a3b4c5d6e7f8", activity: "PRRC_kwDOL7tYbc6OmQx7a" };

/** A state the close recorded not reviewed, with the reason its record carries. */
function stopped(state: { readonly head: string; readonly activity: string | null }, at: string) {
  const reason = `the episode closed at ${at}, after reviewing 3f9c2e0`;
  return { ...state, status: "not reviewed", reason } as const;
}

test("the round cap names each state it left not reviewed, after threads were left open", () => {
  const comment = renderSummary({
    ...quiet,
    threads: [thread("open", "src/queue.ts:134")],
    because: "round-cap",
    leftNotReviewed: {
      bound: "round-cap",
      after: reviewed,
      states: [stopped(later, "the round cap"), stopped(laterStill, "the round cap")],
    },
  });
  assert.ok(
    comment.endsWith(
      "**Notes**\n\n" +
        "- The episode ended at its round cap rather than with nothing left open," +
        " and did not review 8d21a4f or c47e19b",
    ),
    `the states the cap left were not named: ${comment}`,
  );
});

test("the token bound names the state it left not reviewed, after threads were left open", () => {
  const comment = renderSummary({
    ...quiet,
    threads: [thread("open", "src/queue.ts:134")],
    because: "token-bound",
    leftNotReviewed: { bound: "token-bound", after: reviewed, states: [stopped(later, "the token bound")] },
  });
  assert.ok(
    comment.endsWith(
      "**Notes**\n\n" +
        "- The episode ended at the token bound rather than with nothing left open," +
        " and did not review 8d21a4f",
    ),
    `the state the bound left was not named: ${comment}`,
  );
});

/**
 * The close is `nothing-open`, which alone is no note. The cap still stopped the
 * queued state, and the note is the only place a person learns of it.
 */
test("the round cap names the state it left not reviewed, after nothing was left open", () => {
  const comment = renderSummary({
    ...quiet,
    because: "nothing-open",
    leftNotReviewed: { bound: "round-cap", after: reviewed, states: [stopped(later, "the round cap")] },
  });
  assert.equal(
    comment,
    [
      ...quietOpens,
      "- The episode ended at its round cap with nothing left open, and did not review 8d21a4f",
    ].join("\n"),
  );
});

test("the token bound names each state it left not reviewed, after nothing was left open", () => {
  const comment = renderSummary({
    ...quiet,
    because: "nothing-open",
    leftNotReviewed: {
      bound: "token-bound",
      after: reviewed,
      states: [stopped(later, "the token bound"), stopped(laterStill, "the token bound")],
    },
  });
  assert.equal(
    comment,
    [
      ...quietOpens,
      "- The episode ended at the token bound with nothing left open," +
        " and did not review 8d21a4f or c47e19b",
    ].join("\n"),
  );
});

/**
 * A reply with no commit after it is a state of its own with the same head, so
 * each such state is told apart by how many before it share that head.
 */
test("states that differ only in their replies are named apart from the commit and from each other", () => {
  const firstReply = { head: reviewed.head, activity: "PRRC_kwDOL7tYbc6OmQx7a" };
  const secondReply = { head: reviewed.head, activity: "PRRC_kwDOL7tYbc6OmQx9z" };
  const comment = renderSummary({
    ...quiet,
    leftNotReviewed: {
      bound: "round-cap",
      after: reviewed,
      states: [stopped(firstReply, "the round cap"), stopped(secondReply, "the round cap")],
    },
  });
  assert.ok(
    comment.endsWith(
      "and did not review 3f9c2e0 with different replies or 3f9c2e0 with different replies a second time",
    ),
    `the replies were not told apart: ${comment}`,
  );
});

test("three states left not reviewed are listed with a comma and an or", () => {
  const third = { head: "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567", activity: null };
  const comment = renderSummary({
    ...quiet,
    leftNotReviewed: {
      bound: "round-cap",
      after: reviewed,
      states: [stopped(later, "the round cap"), stopped(laterStill, "the round cap"), stopped(third, "the round cap")],
    },
  });
  assert.ok(
    comment.endsWith("and did not review 8d21a4f, c47e19b or 0a1b2c3"),
    `the three states were not listed: ${comment}`,
  );
});

/**
 * An episode that closed on no bound of its own writes no line about why. It is
 * what a close carrying no reason renders as, and a note reading as a bound
 * would say a cap was reached that was not.
 */
test("an episode closed by no bound at all notes none", () => {
  assert.equal(renderSummary({ ...quiet, because: null }), renderSummary(quiet));
});

/**
 * Nothing on the pull request carries a finding whose comment could not be
 * posted. The reviewer confirmed it and the harness lost it, so a comment that
 * left it out would read as a review that found nothing there. The summary
 * carries the failure because GitHub was reachable: it posted this comment.
 */
test("a finding whose comment could not be posted is counted and named in Notes", () => {
  const comment = renderSummary({
    ...quiet,
    findings: posted({
      outcome: "failed",
      finding: onLine("src/queue.ts", 134, "Retry backoff resets"),
      reason: "gh answered HTTP 422",
    }),
  });
  assert.equal(
    comment,
    [
      "**Squiz review — 1 round, 1 finding**",
      "",
      "Fixed 0 · Withdrawn 0 · Open 0 · Disputed 0",
      "20,100 tokens over 1 round: 20,100 · $0.0061",
      "",
      "**Needs a person**",
      "",
      "Nothing needs a person.",
      "",
      "**Notes**",
      "",
      "- `src/queue.ts:134` — Retry backoff resets (raised, and its comment could not be posted)",
    ].join("\n"),
  );
});

/**
 * What GitHub said is the round's to report. It is unbounded text, and a newline
 * in it would put a line in a comment that nothing wrote.
 */
test("the reason the comment could not be posted stays out of the summary", () => {
  const comment = renderSummary({
    ...quiet,
    findings: posted({
      outcome: "failed",
      finding: onFile("src/retry.ts", "Nothing in this file is reached"),
      reason: "gh answered HTTP 422\nValidation Failed",
    }),
  });
  assert.ok(
    comment.endsWith(
      "- `src/retry.ts` — Nothing in this file is reached (raised, and its comment could not be posted)",
    ),
    `the file-scoped finding was not named: ${comment}`,
  );
  assert.ok(!comment.includes("422"), `GitHub's own words reached the summary: ${comment}`);
});

/**
 * An episode can close having run no round: the gate found no pull request, or
 * the first round failed before the reviewer ran. There is then no spend to
 * report rather than a spend of nothing.
 */
test("an episode that ran no round reports no spend", () => {
  const comment = renderSummary({ ...quiet, rounds: [] });
  assert.ok(
    comment.startsWith(
      [
        "**Squiz review — 0 rounds, 0 findings**",
        "",
        "Fixed 0 · Withdrawn 0 · Open 0 · Disputed 0",
        "No rounds ran",
      ].join("\n"),
    ),
    `an episode with no round reported a spend: ${comment}`,
  );
});

// The reviewer must not change what the coding agent would commit, and the
// comparison is the only thing that catches a write it made through its shell.
test("every file that changed while the reviewer ran is named in Notes", () => {
  assert.equal(
    aboutTheWorktree({ changed: ["src/queue.ts", "src/retry.ts"] }),
    [
      ...quietOpens,
      "- Files changed in the worktree while the reviewer ran: `src/queue.ts`, `src/retry.ts`",
    ].join("\n"),
  );
});

// A commit leaves every file as it was, so a moved HEAD is named on its own line.
test("every move of HEAD is named in Notes, after the files that changed", () => {
  assert.equal(
    aboutTheWorktree({
      changed: ["src/queue.ts"],
      moved: [
        "from refs/heads/feature-a at 1111 to refs/heads/feature-a at 2222",
        "from refs/heads/feature-a at 2222 to a detached HEAD at 2222",
      ],
    }),
    [
      ...quietOpens,
      "- A file changed in the worktree while the reviewer ran: `src/queue.ts`",
      "- `HEAD` moved while the reviewer ran: from refs/heads/feature-a at 1111 to refs/heads/feature-a at 2222",
      "- `HEAD` moved while the reviewer ran: from refs/heads/feature-a at 2222 to a detached HEAD at 2222",
    ].join("\n"),
  );
});

/**
 * A round that found nothing and a round that never looked compose the same
 * comment if this is wrong, and the wrong one reads as reassurance.
 */
test("a comparison the round never took does not read as a worktree nothing changed", () => {
  const comment = aboutTheWorktree({
    uncompared: ["the round had too little of its window left to read the worktree"],
  });

  assert.equal(
    comment,
    [
      ...quietOpens,
      "- A round could not tell whether a file changed or `HEAD` moved while the reviewer ran:" +
        " the round had too little of its window left to read the worktree",
    ].join("\n"),
  );
  assert.notEqual(
    comment,
    renderSummary(quiet),
    "a round nothing compared composed the comment of a round that compared and found nothing",
  );
});

// Taken, and could not be had. The round's window, a git that failed, or a file
// it could not read: each is a comparison that establishes nothing.
test("a comparison that was taken and could not be had says so", () => {
  const comment = aboutTheWorktree({
    uncompared: ["the reading before could not be taken: git exited 128"],
  });

  assert.equal(
    comment,
    [
      ...quietOpens,
      "- A round could not tell whether a file changed or `HEAD` moved while the reviewer ran:" +
        " the reading before could not be taken: git exited 128",
    ].join("\n"),
  );
  assert.notEqual(
    comment,
    renderSummary(quiet),
    "a comparison that could not be had composed the comment of one that found nothing",
  );
});

/**
 * The reasons are git's and the system's own words, and they are unbounded text.
 * A newline left in one would put a bullet in this comment that nothing wrote,
 * under counts that say there is no such finding.
 */
test("a reason carrying newlines is one line of Notes", () => {
  const comment = aboutTheWorktree({
    uncompared: ["the reading before could not be taken:\ngit exited 128\n\nfatal: not a repository"],
  });

  assert.equal(
    comment,
    [
      ...quietOpens,
      "- A round could not tell whether a file changed or `HEAD` moved while the reviewer ran:" +
        " the reading before could not be taken: git exited 128 fatal: not a repository",
    ].join("\n"),
  );
  assert.equal(
    comment.split("\n").filter((line) => line.startsWith("- ")).length,
    1,
    `a reason opened a second bullet:\n${comment}`,
  );
});
