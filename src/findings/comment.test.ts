/**
 * Every comment is asserted whole, against the template. A renderer that emits
 * the parts in the wrong order, with the wrong blank lines, or with the marker
 * gone passes a test that looks for each part on its own. Those assertions
 * carry no message, because the diff between two comments is the output worth
 * reading.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { renderComment } from "./comment.ts";
import {
  type ChangeFinding,
  type FileFinding,
  hasReference,
  type LineFinding,
} from "./finding.ts";

// The expected comments are lines joined rather than template literals: the
// markdown they carry is full of backticks, and a blank line is a `""` that
// can be seen.
function comment(...lines: readonly string[]): string {
  return lines.join("\n");
}

const cardReference = "`AGENTS.md`: re-run placement whenever the card's height changes.";

/**
 * The finding the specification's own example is rendered from.
 */
const card: LineFinding = {
  scope: "line",
  file: "src/ui/card.ts",
  line: 88,
  severity: "high",
  headline: "Card can be placed off-screen once the explanation expands",
  reasoning: [
    "`placeCard()` clamps against `window.innerHeight` before the expand animation runs, so a card that grows past the fold keeps its pre-expansion offset.",
    "Triggers at 150% zoom or above, on an entry with three or more senses.",
  ],
  suggestedFix:
    "re-run `placeCard()` from the animation's completion callback, and clamp against the card's measured height rather than its initial height.",
  reference: cardReference,
};

/**
 * The specification's example, with the wrapping of the document it is printed
 * in undone. Markdown renders a soft wrap and the line it wrapped the same, and
 * the renderer leaves the reviewer's text as it was handed it.
 */
const cardComment = comment(
  "**Squiz reviewer · high — Card can be placed off-screen once the explanation expands**",
  "",
  "- `placeCard()` clamps against `window.innerHeight` before the expand animation runs, so a card that grows past the fold keeps its pre-expansion offset.",
  "- Triggers at 150% zoom or above, on an entry with three or more senses.",
  "",
  "**Suggested fix:** re-run `placeCard()` from the animation's completion callback, and clamp against the card's measured height rather than its initial height.",
  "",
  `> ${cardReference}`,
);

// The same comment with the reference deleted, which is what the specification
// says it has to stand as.
const cardCommentWithoutReference = comment(
  "**Squiz reviewer · high — Card can be placed off-screen once the explanation expands**",
  "",
  "- `placeCard()` clamps against `window.innerHeight` before the expand animation runs, so a card that grows past the fold keeps its pre-expansion offset.",
  "- Triggers at 150% zoom or above, on an entry with three or more senses.",
  "",
  "**Suggested fix:** re-run `placeCard()` from the animation's completion callback, and clamp against the card's measured height rather than its initial height.",
);

// Derived from the finding above rather than written out again, so that the two
// can differ in the reference and in nothing else.
const cardWithoutReference: LineFinding = (() => {
  const { reference, ...rest } = card;
  return rest;
})();

/** A finding with one point of reasoning and no reference, scoped to the change. */
const duplicate: ChangeFinding = {
  scope: "change",
  severity: "low",
  headline: "The retry queue duplicates the scheduler",
  reasoning: ["Nothing calls `src/sync/scheduler.ts`."],
  suggestedFix: "Call the scheduler the project already has.",
};

const duplicateComment = comment(
  "**Squiz reviewer · low — The retry queue duplicates the scheduler**",
  "",
  "- Nothing calls `src/sync/scheduler.ts`.",
  "",
  "**Suggested fix:** Call the scheduler the project already has.",
);

test("a finding renders as the comment the specification shows", () => {
  assert.equal(renderComment(card), cardComment);
});

test("the reference is optional, and deleting it is the whole difference", () => {
  assert.equal(renderComment(cardWithoutReference), cardCommentWithoutReference);
  assert.equal(renderComment(card), `${cardCommentWithoutReference}\n\n> ${cardReference}`);
});

/**
 * `finding.ts` reports a reference of `""` as one that is present and empty
 * rather than as none, and leaves what to render to this module. Nothing is
 * quoted: an empty quote block is markdown the reader has to decode, and a
 * comment that has to stand with the reference deleted stands with an empty one
 * deleted too.
 */
test("a reference that is present and empty is quoted no differently from none", () => {
  const empty = { ...card, reference: "" };
  const blank = { ...card, reference: " \n " };
  assert.ok(hasReference(empty), "an empty reference is present, which is what makes this a choice");
  assert.equal(renderComment(empty), cardCommentWithoutReference);
  assert.equal(renderComment(blank), cardCommentWithoutReference);
});

/**
 * A newline in a headline would split the first line out of its bold span, and
 * one in a point of reasoning would break out of its bullet. The fields below
 * carry the wrapping the specification's own document prints them with, and one
 * more in the headline.
 */
test("text that carries newlines is rendered as one line rather than breaking the format", () => {
  const wrapped: LineFinding = {
    ...card,
    headline: "Card can be placed off-screen\nonce the explanation expands",
    reasoning: [
      "`placeCard()` clamps against `window.innerHeight` before the expand animation\n  runs, so a card that grows past the fold keeps its pre-expansion offset.",
      "Triggers at 150% zoom or above, on an entry with three or more senses.",
    ],
    suggestedFix:
      "re-run `placeCard()` from the animation's completion\ncallback, and clamp against the card's measured height rather than its initial\nheight.",
    reference: `\n${cardReference}\n`,
  };
  assert.equal(renderComment(wrapped), cardComment);
});

test("one point of reasoning is a bullet, not a paragraph", () => {
  assert.equal(renderComment(duplicate), duplicateComment);
});

/**
 * The scope reaches the routing and never the body. The findings below differ
 * from the change-scoped one in scope and anchor alone, and render as the one
 * comment it renders as.
 */
test("one template serves every scope, and the anchor is never written into the comment", () => {
  const anchoredFile = "src/retry/queue.ts";
  const anchoredLine = 41;
  const onALine: LineFinding = {
    ...duplicate,
    scope: "line",
    file: anchoredFile,
    line: anchoredLine,
  };
  const onAFile: FileFinding = { ...duplicate, scope: "file", file: anchoredFile };

  assert.equal(renderComment(onALine), duplicateComment);
  assert.equal(renderComment(onAFile), duplicateComment);
  assert.equal(
    duplicateComment.includes(anchoredFile),
    false,
    "a comment is placed on the file it was anchored to rather than naming it",
  );
  assert.equal(
    duplicateComment.includes(String(anchoredLine)),
    false,
    "a comment is placed on the line it was anchored to rather than naming it",
  );
});

test("the severity sits on the first line, between the marker and the headline", () => {
  assert.equal(
    renderComment({ ...duplicate, severity: "high" }),
    duplicateComment.replace("· low", "· high"),
  );
  assert.equal(
    renderComment({ ...duplicate, severity: "medium" }),
    duplicateComment.replace("· low", "· medium"),
  );
});

test("the comment begins with the marker the specification gives the reviewer", () => {
  assert.ok(
    renderComment(duplicate).startsWith("**Squiz reviewer"),
    "a comment carrying no marker is one a person wrote, so the reviewer must always write it",
  );
});

test("a blank field leaves no empty bullet and no label with nothing under it", () => {
  const blank: ChangeFinding = { ...duplicate, reasoning: ["", "  "], suggestedFix: " " };
  assert.equal(
    renderComment(blank),
    "**Squiz reviewer · low — The retry queue duplicates the scheduler**",
  );
});

test("a blank headline leaves no dash with nothing after it", () => {
  const blank: ChangeFinding = { ...duplicate, headline: " " };
  assert.equal(
    renderComment(blank),
    comment(
      "**Squiz reviewer · low**",
      "",
      "- Nothing calls `src/sync/scheduler.ts`.",
      "",
      "**Suggested fix:** Call the scheduler the project already has.",
    ),
  );
});
