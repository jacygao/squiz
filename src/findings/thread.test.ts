/**
 * The reviewer's comments here are rendered rather than written out, so that a
 * thread is read back through the writer that put it there. A test asserting a
 * hand-written first line passes while the two spell the marker differently.
 *
 * Each answer is asserted whole. A reader that finds the severity and loses the
 * headline passes a test that looks at one field.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReviewThread } from "../github/threads.ts";
import { renderComment } from "./comment.ts";
import type { LineFinding } from "./finding.ts";
import { readThread } from "./thread.ts";

const offScreen: LineFinding = {
  scope: "line",
  file: "src/ui/card.ts",
  line: 88,
  severity: "high",
  headline: "Card can be placed off-screen once the explanation expands",
  reasoning: ["`placeCard()` clamps before the expand animation runs."],
  suggestedFix: "Clamp against the card's measured height.",
};

/**
 * A thread carrying `bodies` in the order GitHub returns them, the first being
 * the comment that opened it.
 *
 * The author of every comment is the one account they are all posted under,
 * which is what leaves the marker as the only thing that says who wrote one.
 */
function threadOf(...bodies: readonly string[]): ReviewThread {
  return {
    id: "PRRT_kwDOP7Gu3c5fzFvS",
    isResolved: false,
    isOutdated: false,
    path: offScreen.file,
    anchor: { at: "line", line: offScreen.line },
    comments: bodies.map((body) => ({ databaseId: null, author: "jacygao", body })),
  };
}

const codingAgentReply = "**Squiz coding agent:** fixed in abc1234.";

test("a thread the reviewer opened answers with the severity and headline it was given", () => {
  assert.deepEqual(readThread(threadOf(renderComment(offScreen))), {
    raised: "finding",
    severity: "high",
    headline: offScreen.headline,
    codingAgentReplied: false,
  });
});

test("a headline carrying the separator keeps every part of it", () => {
  const dashed = { ...offScreen, headline: "The card — once expanded — sits off-screen" };
  assert.deepEqual(readThread(threadOf(renderComment(dashed))), {
    raised: "finding",
    severity: "high",
    headline: dashed.headline,
    codingAgentReplied: false,
  });
});

/**
 * The summary counts findings, and a thread a person opened is not one. Answered
 * as a finding with the fields blank, it would be listed with nothing said about
 * it.
 */
test("a thread a person opened is no finding at all", () => {
  assert.deepEqual(
    readThread(threadOf("Can you check the line above?", codingAgentReply)),
    { raised: "nothing" },
    "a thread whose first comment carries no marker was opened by a person",
  );
});

/**
 * `**Squiz review` is a prefix of `**Squiz reviewer`, so the character after the
 * name is what separates the harness's own summary from a finding.
 */
test("a comment beginning with the summary's marker is not read as the reviewer's", () => {
  assert.deepEqual(
    readThread(threadOf("**Squiz review — 3 rounds, 7 findings**")),
    { raised: "nothing" },
    "a matcher that stops at the name reads the harness's summary as a finding",
  );
});

test("a thread the coding agent replied to answers that it replied", () => {
  assert.deepEqual(readThread(threadOf(renderComment(offScreen), codingAgentReply)), {
    raised: "finding",
    severity: "high",
    headline: offScreen.headline,
    codingAgentReplied: true,
  });
});

/**
 * The reviewer's own later comments are not the coding agent's, and the comment
 * that opened the thread is the one the finding is read off: the second one here
 * names another severity and another headline.
 */
test("several comments from the reviewer are not a reply from the coding agent", () => {
  const again = renderComment({
    ...offScreen,
    severity: "low",
    headline: "And the card is still off-screen",
  });
  assert.deepEqual(readThread(threadOf(renderComment(offScreen), again, again)), {
    raised: "finding",
    severity: "high",
    headline: offScreen.headline,
    codingAgentReplied: false,
  });
});

test("a finding the reviewer left no headline on is answered without one", () => {
  assert.deepEqual(readThread(threadOf(renderComment({ ...offScreen, headline: " " }))), {
    raised: "finding",
    severity: "high",
    headline: null,
    codingAgentReplied: false,
  });
});

// A thread the type permits: GitHub answers with the comment that opened it, and
// a thread with nothing written on it carries no marker to read.
test("a thread carrying no comments raised nothing", () => {
  assert.deepEqual(readThread(threadOf()), { raised: "nothing" });
});
