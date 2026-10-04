import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewThread, ThreadComment } from "../github/threads.ts";
import { renderComment } from "./comment.ts";
import type { LineFinding } from "./finding.ts";
import { threadListing } from "./listing.ts";

/**
 * A thread as the reader hands one over, with `overrides` naming what the case
 * is about.
 *
 * The anchor is already settled: the reader puts `originalLine` in the line's
 * place when GitHub nulls the live one, and anchors a thread whose subject is
 * the file to the file.
 */
function thread(overrides: Partial<ReviewThread>): ReviewThread {
  return {
    id: "PRRT_kwDOUEd2qM6hqHeq",
    isResolved: false,
    isOutdated: false,
    path: "src/cli.ts",
    anchor: { at: "line", line: 7 },
    comments: [],
    ...overrides,
  };
}

/**
 * One comment as GitHub reads it back.
 *
 * The author is the one account every comment is posted under, which is what
 * leaves the marker at the start of the body as the only thing that says who
 * wrote it.
 */
function comment(body: string): ThreadComment {
  return {
    id: "PRRC_fixture",
    createdAt: "2026-09-06T07:13:05Z",
    databaseId: null,
    author: "squiz",
    body,
  };
}

// Two findings on one file and different lines, so a listing that carries one
// headline onto every line fails here.
const partialPage: LineFinding = {
  scope: "line",
  file: "scratch/paging/pages.ts",
  line: 26,
  severity: "high",
  headline: "pageCount drops the partial last page",
  reasoning: ["`pageCount` returns `Math.floor(total / perPage)`."],
  suggestedFix: "Return `Math.ceil(total / perPage)`.",
};

const pageTooFar: LineFinding = {
  ...partialPage,
  line: 34,
  headline: "pageAt starts every page one page too far",
  reasoning: ["`pageAt` computes `start = number * perPage`, and pages count from 1."],
  suggestedFix: "Start the page at `(number - 1) * perPage`.",
};

/** The thread the reviewer opened for `finding`, carrying its comment. */
function raised(id: string, finding: LineFinding): ReviewThread {
  return thread({
    id,
    path: finding.file,
    anchor: { at: "line", line: finding.line },
    comments: [comment(renderComment(finding))],
  });
}

/**
 * The reviewer's comment with the severity taken out of its first line, which is
 * a comment a person edited on GitHub.
 *
 * Rendered and then edited rather than written out, so the marker stays spelled
 * in one place. The writer never produces this line: every finding it is handed
 * carries a severity.
 */
function withoutSeverity(finding: LineFinding): string {
  return renderComment(finding).replace(`· ${finding.severity} `, "·  ");
}

test("the listing names each open thread by its id and its file and line", () => {
  const printed = threadListing(80, [
    thread({ id: "PRRT_one", path: "scratch/target.txt", anchor: { at: "line", line: 7 } }),
    thread({ id: "PRRT_two", path: "scratch/target.txt", anchor: { at: "line", line: 12 } }),
  ]);

  assert.equal(
    printed,
    ["2 open threads on #80", "PRRT_one scratch/target.txt:7", "PRRT_two scratch/target.txt:12", ""].join(
      "\n",
    ),
  );
});

test("a resolved thread is not on the listing", () => {
  const printed = threadListing(80, [
    thread({ id: "PRRT_open", anchor: { at: "line", line: 7 } }),
    thread({ id: "PRRT_closed", isResolved: true, anchor: { at: "line", line: 19 } }),
  ]);

  assert.equal(
    printed,
    ["1 open thread on #80", "PRRT_open src/cli.ts:7", ""].join("\n"),
    "a closed thread listed as open sends the agent back to work the reviewer accepted",
  );
});

test("a pull request with nothing open says so in words", () => {
  const none = "no open threads on #80\n";

  assert.equal(threadListing(80, []), none, "printing nothing would read as a command that failed");
  assert.equal(threadListing(80, [thread({ isResolved: true })]), none);
});

test("a thread on the file as a whole is listed as its file, not as its first line", () => {
  // Both threads are on #80 and GitHub reads both back on line 1. Listing them
  // alike is what this exists to stop.
  const printed = threadListing(80, [
    thread({
      id: "PRRT_kwDOUEd2qM6hqMTt",
      path: "scratch/target.txt",
      anchor: { at: "file" },
    }),
    thread({
      id: "PRRT_kwDOUEd2qM6hqQd7",
      path: "scratch/a file with spaces.txt",
      anchor: { at: "line", line: 1 },
    }),
  ]);

  assert.equal(
    printed,
    [
      "2 open threads on #80",
      "PRRT_kwDOUEd2qM6hqMTt scratch/target.txt (whole file)",
      "PRRT_kwDOUEd2qM6hqQd7 scratch/a file with spaces.txt:1",
      "",
    ].join("\n"),
  );
  assert.doesNotMatch(printed, /null/u, "file:null names nothing a reader can open");
});

test("a thread on a line GitHub would not name says so rather than claiming the file", () => {
  const printed = threadListing(80, [thread({ id: "PRRT_lost", anchor: { at: "unnamed-line" } })]);

  assert.equal(
    printed,
    ["1 open thread on #80", "PRRT_lost src/cli.ts (line unknown)", ""].join("\n"),
    "a line thread listed as the whole file misreports what the finding is about",
  );
});

test("a thread whose anchored line was edited is listed on the line it was anchored to", () => {
  const printed = threadListing(80, [
    thread({ id: "PRRT_old", isOutdated: true, anchor: { at: "line", line: 12 } }),
  ]);

  assert.match(printed, /^PRRT_old src\/cli\.ts:12$/mu);
});

test("the identifier is the whole of the first field, so it copies into squiz reply", () => {
  const ids = ["PRRT_kwDOUEd2qM6hqQd7", "PRRT_kwDOUEd2qM6hqQfm"];
  // What #80 carries: a path holding a space, so the location cannot be split on
  // the first field; a path outside ASCII; and a headline holding both spaces and
  // the separator the severity sits in front of.
  const dashed: LineFinding = { ...partialPage, headline: "pageCount — the last one — drops a page" };
  const printed = threadListing(80, [
    thread({
      id: ids[0],
      path: "scratch/a file with spaces.txt",
      anchor: { at: "line", line: 1 },
      comments: [comment(renderComment(dashed))],
    }),
    thread({ id: ids[1], path: "scratch/ünïcödé.txt", anchor: { at: "line", line: 1 } }),
  ]);

  const listed = printed.trimEnd().split("\n").slice(1);
  assert.deepEqual(
    listed.map((line) => line.split(" ")[0]),
    ids,
    "an id that does not survive being copied leaves the agent unable to reply",
  );
  assert.deepEqual(listed, [
    `${ids[0]} scratch/a file with spaces.txt:1 high — ${dashed.headline}`,
    `${ids[1]} scratch/ünïcödé.txt:1`,
  ]);
});

test("each open thread carries the severity and the headline of the finding on it (#200)", () => {
  const printed = threadListing(185, [
    raised("PRRT_kwDOUEd2qM6mPuUP", partialPage),
    raised("PRRT_kwDOUEd2qM6mPuVO", pageTooFar),
  ]);

  assert.equal(
    printed,
    [
      "2 open threads on #185",
      "PRRT_kwDOUEd2qM6mPuUP scratch/paging/pages.ts:26 high — pageCount drops the partial last page",
      "PRRT_kwDOUEd2qM6mPuVO scratch/paging/pages.ts:34 high — pageAt starts every page one page too far",
      "",
    ].join("\n"),
    "an agent told only where a finding is has to fetch the comment bodies itself",
  );
});

/**
 * A person can open a thread on the pull request, and the live episode's own
 * pull request had one. It is no finding, so there is nothing to print after its
 * location.
 */
test("a thread carrying no finding ends at its location", () => {
  const printed = threadListing(185, [
    thread({ id: "PRRT_asked", comments: [comment("Can you check the line above?")] }),
  ]);

  assert.equal(
    printed,
    ["1 open thread on #185", "PRRT_asked src/cli.ts:7", ""].join("\n"),
    "a dangling separator or a printed null is worse than the line it replaced",
  );
});

test("a finding naming one of the two fields reads as a line rather than one with a hole in it", () => {
  const printed = threadListing(185, [
    thread({
      id: "PRRT_unsaid",
      comments: [comment(renderComment({ ...partialPage, headline: " " }))],
    }),
    thread({ id: "PRRT_ungraded", comments: [comment(withoutSeverity(pageTooFar))] }),
  ]);

  assert.equal(
    printed,
    [
      "2 open threads on #185",
      "PRRT_unsaid src/cli.ts:7 high",
      "PRRT_ungraded src/cli.ts:7 pageAt starts every page one page too far",
      "",
    ].join("\n"),
    "the reader answers the severity and the headline independently, so either can be missing",
  );
});

/**
 * A path is git's rather than the harness's, and a newline is legal in one. One
 * thread per line is the shape `squiz reply` users read off the listing, and the
 * stray line's first field is what a reader would take for an identifier.
 */
test("a path that is not one line still prints as one thread on one line (#213)", () => {
  const printed = threadListing(185, [
    thread({ id: "PRRT_split", path: "src/a\nb.ts", anchor: { at: "line", line: 3 } }),
    thread({ id: "PRRT_plain", path: "src/c.ts", anchor: { at: "line", line: 4 } }),
  ]);

  const listed = printed.trimEnd().split("\n").slice(1);
  assert.equal(listed.length, 2, `two threads printed as ${listed.length} lines: ${printed}`);
  assert.equal(listed[0], "PRRT_split src/a b.ts:3");
});

/**
 * The renderer collapses a headline to one line, and a comment a person edited on
 * GitHub is not bound by that. One thread per line is the shape `squiz reply`
 * users read off the listing.
 */
test("a headline that is not one line still prints as one thread on one line", () => {
  const headlines = ["pageCount drops\nthe partial last page", "pageCount   drops\ta page"];

  for (const headline of headlines) {
    const edited = renderComment(partialPage).replace(partialPage.headline, headline);
    const printed = threadListing(185, [thread({ id: "PRRT_wrapped", comments: [comment(edited)] })]);

    const listed = printed.trimEnd().split("\n").slice(1);
    assert.equal(listed.length, 1, `one thread printed as ${listed.length} lines: ${printed}`);
    assert.match(
      listed[0] ?? "",
      /^PRRT_wrapped src\/cli\.ts:7 high — pageCount drops/u,
      "a line with no identifier in front of it is one nothing can reply to",
    );
  }
});
