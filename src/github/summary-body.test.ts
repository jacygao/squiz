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
import type { RoundConfinement } from "../loop/confinement.ts";
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

/**
 * A worktree the round had to itself, with nothing changed in it and the round
 * named to whoever came next. Nothing here is a note.
 */
const undisturbed: RoundConfinement = {
  trackedFiles: { outcome: "unchanged" },
  otherEpisodes: { outcome: "alone" },
  marked: { outcome: "written" },
};

/** An episode that raised nothing and closed with nothing open. */
const quiet: ClosedEpisode = {
  rounds: [round(0.0061, 20_100)],
  threads: [],
  findings: posted(),
  because: "nothing-open",
  confinement: undisturbed,
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
function aboutTheWorktree(found: Partial<RoundConfinement>): string {
  return renderSummary({ ...quiet, confinement: { ...undisturbed, ...found } });
}

/**
 * The episode the specification's example is written from.
 *
 * Its Notes carries the two the example does: a finding about the change as a
 * whole, and a file that changed while the reviewer ran. Each is one line rather
 * than the example's wrapped two, because the comment a person reads is markdown
 * and the wrap is not in it.
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
    confinement: {
      ...undisturbed,
      trackedFiles: { outcome: "changed", paths: ["packages/sync/src/queue.test.ts"] },
    },
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

test("the token bound is a note", () => {
  const comment = renderSummary({ ...quiet, because: "token-bound" });
  assert.ok(
    comment.endsWith("- The episode ended at the token bound rather than with nothing left open"),
    `the token bound was not noted: ${comment}`,
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
    aboutTheWorktree({
      trackedFiles: { outcome: "changed", paths: ["src/queue.ts", "src/retry.ts"] },
    }),
    [
      ...quietOpens,
      "- Files changed in the worktree while the reviewer ran: `src/queue.ts`, `src/retry.ts`",
    ].join("\n"),
  );
});

/**
 * A round that found nothing and a round that never looked compose the same
 * comment if this is wrong, and the wrong one reads as reassurance.
 */
test("a comparison the round never took does not read as a worktree nothing changed", () => {
  const comment = aboutTheWorktree({
    trackedFiles: {
      outcome: "not-taken",
      reason: "the worktree is shared with live episode 91bc",
    },
  });

  assert.equal(
    comment,
    [
      ...quietOpens,
      "- Nothing says whether a file changed in the worktree while the reviewer ran:" +
        " the worktree is shared with live episode 91bc",
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
    trackedFiles: {
      outcome: "unknown",
      reason: "the reading before could not be taken: git exited 128",
    },
  });

  assert.equal(
    comment,
    [
      ...quietOpens,
      "- Nothing says whether a file changed in the worktree while the reviewer ran:" +
        " the reading before could not be taken: git exited 128",
    ].join("\n"),
  );
  assert.notEqual(
    comment,
    renderSummary(quiet),
    "a comparison that could not be had composed the comment of one that found nothing",
  );
});

test("the other episodes in the worktree are named where the tree was shared", () => {
  assert.equal(
    aboutTheWorktree({
      otherEpisodes: {
        outcome: "shared",
        episodes: [
          { id: "2f3a", pid: 4021 },
          { id: "91bc", pid: null },
        ],
      },
      trackedFiles: {
        outcome: "not-taken",
        reason: "the worktree is shared with live episodes 2f3a, 91bc",
      },
    }),
    [
      ...quietOpens,
      "- Nothing says whether a file changed in the worktree while the reviewer ran:" +
        " the worktree is shared with live episodes 2f3a, 91bc",
      "- Other episodes were in the worktree while the reviewer ran: 2f3a, 91bc",
    ].join("\n"),
  );
});

test("one other episode in the worktree reads as one", () => {
  assert.equal(
    aboutTheWorktree({
      otherEpisodes: { outcome: "shared", episodes: [{ id: "2f3a", pid: 4021 }] },
      trackedFiles: {
        outcome: "not-taken",
        reason: "the worktree is shared with live episode 2f3a",
      },
    }),
    [
      ...quietOpens,
      "- Nothing says whether a file changed in the worktree while the reviewer ran:" +
        " the worktree is shared with live episode 2f3a",
      "- Another episode was in the worktree while the reviewer ran: 2f3a",
    ].join("\n"),
  );
});

// A tree nothing could be established about is not a tree the round had to
// itself, and the comparison above the line is only worth what this answer is.
test("a round that could not tell who else was in the worktree says so", () => {
  const comment = aboutTheWorktree({
    otherEpisodes: { outcome: "unknown", reason: "ps was killed by SIGKILL" },
    trackedFiles: {
      outcome: "not-taken",
      reason: "the live episodes of the worktree could not be established: ps was killed by SIGKILL",
    },
  });

  assert.equal(
    comment,
    [
      ...quietOpens,
      "- Nothing says whether a file changed in the worktree while the reviewer ran:" +
        " the live episodes of the worktree could not be established: ps was killed by SIGKILL",
      "- Nothing says whether another episode was in the worktree while the reviewer ran:" +
        " ps was killed by SIGKILL",
    ].join("\n"),
  );
  assert.notEqual(
    comment,
    renderSummary(quiet),
    "a round that could not tell who else was here composed the comment of a round that was alone",
  );
});

/**
 * The two answers arrive separately and each is its own line, so a composer that
 * stopped after the first would write a comment that is not wrong, only
 * incomplete.
 */
test("a shared worktree and a changed file are both carried", () => {
  assert.equal(
    aboutTheWorktree({
      trackedFiles: { outcome: "changed", paths: ["src/queue.ts"] },
      otherEpisodes: { outcome: "shared", episodes: [{ id: "2f3a", pid: 4021 }] },
    }),
    [
      ...quietOpens,
      "- A file changed in the worktree while the reviewer ran: `src/queue.ts`",
      "- Another episode was in the worktree while the reviewer ran: 2f3a",
    ].join("\n"),
  );
});

/**
 * The reasons are git's and the system's own words, and they are unbounded text.
 * A newline left in one would put a bullet in this comment that nothing wrote,
 * under counts that say there is no such finding.
 */
test("a reason carrying newlines is one line of Notes", () => {
  const comment = aboutTheWorktree({
    trackedFiles: {
      outcome: "unknown",
      reason: "the reading before could not be taken:\ngit exited 128\n\nfatal: not a repository",
    },
  });

  assert.equal(
    comment,
    [
      ...quietOpens,
      "- Nothing says whether a file changed in the worktree while the reviewer ran:" +
        " the reading before could not be taken: git exited 128 fatal: not a repository",
    ].join("\n"),
  );
  assert.equal(
    comment.split("\n").filter((line) => line.startsWith("- ")).length,
    1,
    `a reason opened a second bullet:\n${comment}`,
  );
});

/**
 * A marker that was not written costs a later round its comparison rather than
 * this one, and nobody reading this pull request can do anything about it.
 */
test("a marker that was not written is not a note", () => {
  assert.equal(
    renderSummary({
      ...quiet,
      confinement: { ...undisturbed, marked: { outcome: "failed", reason: "EACCES" } },
    }),
    renderSummary(quiet),
  );
});
