import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReviewThread, ThreadComment } from "../venues/github/threads.ts";
import { latestActivity } from "./activity.ts";
import { renderComment, renderOpenReason, renderReply } from "./comment.ts";

// Every comment is written by the renderers that post them, so a fixture keeps
// matching the markers after either is respelled.
const opening = renderComment({
  scope: "change",
  severity: "high",
  headline: "Card can be placed off-screen",
  reasoning: ["The height is never measured."],
  suggestedFix: "Clamp against the measured height.",
});

const reviewerReply = renderComment({
  scope: "change",
  severity: "high",
  headline: "Still off-screen",
  reasoning: ["The clamp uses the width."],
  suggestedFix: "Clamp against the height.",
});

function comment(
  id: string,
  body: string,
  createdAt: string,
  databaseId: number | null = null,
): ThreadComment {
  return { id, databaseId, author: "squiz", body, createdAt };
}

function thread(id: string, ...comments: readonly ThreadComment[]): ReviewThread {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path: "src/ui/card.ts",
    anchor: { at: "line", line: 88 },
    comments,
  };
}

const opened = comment("PRRC_opened", opening, "2026-09-06T07:00:00Z");

test("a pull request with no threads has no activity", () => {
  assert.equal(latestActivity([]), null);
});

test("the comment that opened the reviewer's thread is not activity", () => {
  assert.equal(latestActivity([thread("PRRT_a", opened)]), null);
});

test("a thread carrying no comments holds no activity", () => {
  assert.equal(latestActivity([thread("PRRT_a")]), null);
});

test("the coding agent's reply on the reviewer's thread is activity", () => {
  const reply = comment("PRRC_agent", renderReply("Clamped now."), "2026-09-06T07:05:00Z");

  assert.equal(latestActivity([thread("PRRT_a", opened, reply)]), "PRRC_agent");
});

test("a person's reply on the reviewer's thread is activity", () => {
  const reply = comment("PRRC_person", "This is by design.", "2026-09-06T07:05:00Z");

  assert.equal(latestActivity([thread("PRRT_a", opened, reply)]), "PRRC_person");
});

test("the reviewer's own reply on its thread is not activity", () => {
  const reply = comment("PRRC_reviewer", reviewerReply, "2026-09-06T07:05:00Z");

  assert.equal(latestActivity([thread("PRRT_a", opened, reply)]), null);
});

test("the reason the reviewer posts for keeping a thread open is not activity (#511)", () => {
  const reason = comment("PRRC_reason", renderOpenReason("Still off-screen."), "2026-09-06T07:05:00Z");
  assert.equal(latestActivity([thread("PRRT_a", opened, reason)]), null);
});

test("a reply after the reviewer's own still counts, and the reviewer's does not", () => {
  const agent = comment("PRRC_agent", renderReply("Clamped now."), "2026-09-06T07:05:00Z");
  const reviewer = comment("PRRC_reviewer", reviewerReply, "2026-09-06T07:09:00Z");

  assert.equal(latestActivity([thread("PRRT_a", opened, agent, reviewer)]), "PRRC_agent");
});

test("a thread a person opened holds no activity, whatever is said on it", () => {
  const personal = thread(
    "PRRT_person",
    comment("PRRC_question", "Why is this exported?", "2026-09-06T07:00:00Z"),
    comment("PRRC_agent", renderReply("It is used by the card."), "2026-09-06T07:05:00Z"),
    comment("PRRC_person", "Fair enough.", "2026-09-06T07:06:00Z"),
  );

  assert.equal(latestActivity([personal]), null);
});

test("a thread the coding agent opened holds no activity", () => {
  const agents = thread(
    "PRRT_agent",
    comment("PRRC_agent_opened", renderReply("A note on this line."), "2026-09-06T07:00:00Z"),
    comment("PRRC_person", "Thanks.", "2026-09-06T07:05:00Z"),
  );

  assert.equal(latestActivity([agents]), null);
});

test("the newest reply is the one posted last, wherever it is listed", () => {
  // The newest reply sits in the first thread, first among the replies, and its
  // node id sorts before the older one's. Position and identifier order would
  // each give the older reply.
  const newer = comment("PRRC_aaa", "Newer.", "2026-09-06T08:00:00Z");
  const older = comment("PRRC_zzz", "Older.", "2026-09-06T07:30:00Z");
  const first = thread("PRRT_a", opened, newer);
  const second = thread("PRRT_b", opened, older);

  assert.equal(latestActivity([first, second]), "PRRC_aaa");
  assert.equal(latestActivity([second, first]), "PRRC_aaa");
});

test("two replies posted in the same second go to the one with the larger REST id", () => {
  const lower = comment("PRRC_zzz", "First.", "2026-09-06T07:05:00Z", 100);
  const higher = comment("PRRC_aaa", "Second.", "2026-09-06T07:05:00Z", 101);

  assert.equal(latestActivity([thread("PRRT_a", opened, higher, lower)]), "PRRC_aaa");
  assert.equal(latestActivity([thread("PRRT_a", opened, lower, higher)]), "PRRC_aaa");
});

test("a tie nothing else breaks gives the same answer in either listing order", () => {
  const one = comment("PRRC_one", "One.", "2026-09-06T07:05:00Z");
  const two = comment("PRRC_two", "Two.", "2026-09-06T07:05:00Z");

  assert.equal(
    latestActivity([thread("PRRT_a", opened, one), thread("PRRT_b", opened, two)]),
    latestActivity([thread("PRRT_b", opened, two), thread("PRRT_a", opened, one)]),
  );
});

test("an edited reply changes nothing", () => {
  const before = comment("PRRC_agent", renderReply("Clamped."), "2026-09-06T07:05:00Z");
  const after = { ...before, body: renderReply("Clamped against the height.") };

  assert.equal(latestActivity([thread("PRRT_a", opened, after)]), "PRRC_agent");
});

test("a deleted newest reply hands the answer to the one before it", () => {
  const older = comment("PRRC_older", "First.", "2026-09-06T07:05:00Z");
  const newer = comment("PRRC_newer", "Second.", "2026-09-06T07:06:00Z");

  assert.equal(latestActivity([thread("PRRT_a", opened, older, newer)]), "PRRC_newer");
  assert.equal(latestActivity([thread("PRRT_a", opened, older)]), "PRRC_older");
});

/** A general thread, about the change as a whole, whose comments carry ids of their own sequence. */
function general(id: string, ...comments: readonly ThreadComment[]): ReviewThread {
  return { ...thread(id, ...comments), path: "", anchor: { at: "change" } };
}

// A review comment's REST id and a conversation comment's are two sequences, so neither orders replies posted in one second.
test("#889: a review reply posted in the same second as a newer general reply, with a smaller REST id, is still new activity", () => {
  const generalReply = comment("IC_reply", "On the general thread.", "2026-09-06T07:05:00Z", 6870441277);
  const before = latestActivity([thread("PRRT_a", opened), general("G1", opened, generalReply)]);
  const reviewReply = comment("PRRC_reply", "On the review thread.", "2026-09-06T07:05:00Z", 3993908108);
  const after = latestActivity([thread("PRRT_a", opened, reviewReply), general("G1", opened, generalReply)]);

  assert.equal(before, "IC_reply");
  assert.notEqual(after, before, "the new reply left the activity as it was, so no round reviews it");
  assert.equal(after, "PRRC_reply IC_reply");
});

test("#889: replies a second apart on a review thread and a general thread are ordered by time alone", () => {
  const reviewReply = comment("PRRC_reply", "On the review thread.", "2026-09-06T07:05:01Z", 3993908108);
  const generalReply = comment("IC_reply", "On the general thread.", "2026-09-06T07:05:00Z", 6870441277);
  assert.equal(latestActivity([thread("PRRT_a", opened, reviewReply), general("G1", opened, generalReply)]), "PRRC_reply");
});
