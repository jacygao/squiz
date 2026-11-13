import assert from "node:assert/strict";
import { test } from "node:test";

import type { Owner, StateRecord } from "../loop/state-record.ts";
import { printedThread } from "../review/output.ts";
import { followUpFor } from "../venues/github/venue.ts";
import type { ReviewThread } from "../venues/venue.ts";
import { handoffFor } from "./handoff.ts";

const HEAD = "3f9c2e07b1d4a8c6e5f0923b7a1d6c4e8b2f5a90";
const EARLIER_HEAD = "8d21a4f0c3b2e1d4a5f6b7c8d9e0f1a2b3c4d5e6";
const PARENT = "60517e1f-e1dc-49b1-8e39-6fcbe686f3fb";
const SUBAGENT = "a402ef8f56c1b2ed1";
const TRANSCRIPT = `/Users/someone/.claude/projects/-work-squiz/${PARENT}/subagents/agent-${SUBAGENT}.jsonl`;
const CHANGE = {
  name: "PR #41",
  head: HEAD,
  description: "Back off the sync queue's retries.",
  followUp: followUpFor(41),
};
const DIFF = [
  "diff --git a/src/sync/queue.ts b/src/sync/queue.ts",
  "--- a/src/sync/queue.ts",
  "+++ b/src/sync/queue.ts",
  "@@ -133,1 +133,1 @@",
  "-  resetBackoff();",
  "+  if (this.empty) resetBackoff();",
  "",
].join("\n");

function reviewed(exitStatus: 0 | 2 | 3, openThreads: readonly string[], owner?: Owner, head = HEAD): StateRecord {
  return {
    head,
    activity: null,
    ...(owner === undefined ? {} : { owner }),
    status: "reviewed",
    result: "exited",
    exitStatus,
    openThreads,
    round: { number: 2, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" } },
    newFindings: openThreads.length,
  };
}

function thread(id: string, headline: string, replies: readonly string[] = [], isResolved = false): ReviewThread {
  return {
    id,
    isResolved,
    isOutdated: false,
    path: "src/sync/queue.ts",
    anchor: { at: "line", line: 134 },
    comments: [
      `**Squiz reviewer · high — ${headline}**\n\n- It is reached on every enqueue.\n\n**Suggested fix:** Reset it once.`,
      ...replies,
    ].map((body, at) => ({ id: `${id}-c${at}`, databaseId: at, author: "squiz", body, createdAt: "2026-10-05T07:13:05Z" })),
  };
}

const WONT_FIX = "**Squiz coding agent**\n\nWon't fix, because the queue is drained before every reset.";
const DISPUTED = thread("PRRT_a", "Retry backoff resets", [WONT_FIX, "**Squiz reviewer · open**\n\nThe drain does not run on a timeout."]);
const PLAIN = thread("PRRT_b", "Clock skew is read as expiry");

function composed(result: ReturnType<typeof handoffFor>): string {
  assert.equal(result.outcome, "composed", `no handoff was composed: ${JSON.stringify(result)}`);
  return result.outcome === "composed" ? result.text : "";
}

test("#802: a handoff holds the open threads with every reply, the description, each agent's last report and transcript, and the diff", () => {
  const owner: Owner = { sessionId: PARENT, subagent: SUBAGENT, lastMessage: "The backoff resets only on an empty queue now.", transcript: TRANSCRIPT };
  const earlier: Owner = { ...owner, lastMessage: "A first attempt, superseded." };
  const record = reviewed(2, ["PRRT_a", "PRRT_b"], owner);
  const records: readonly StateRecord[] = [reviewed(2, ["PRRT_a"], earlier, EARLIER_HEAD), record];
  const listed = [DISPUTED, thread("PRRT_resolved", "Already fixed", [], true), PLAIN, thread("PRRT_person", "A person's thread")];

  const text = composed(handoffFor(CHANGE, record, listed, DIFF, records));

  assert.equal(
    text,
    [
      "# Handoff for PR #41 at 3f9c2e0, round 2",
      "Squiz reviewed PR #41 at 3f9c2e0 in round 2: 2 threads are open.",
      followUpFor(41),
      "## The description",
      "Back off the sync queue's retries.",
      "## The open threads",
      printedThread(DISPUTED),
      printedThread(PLAIN),
      "## The agents' final reports",
      `### Subagent ${SUBAGENT}, dispatched by session ${PARENT}`,
      `Transcript: ${TRANSCRIPT}`,
      "The backoff resets only on an empty queue now.",
      "## The diff",
      `\`\`\`diff\n${DIFF}\`\`\``,
    ].join("\n\n") + "\n",
  );
  assert.ok(text.includes("Won't fix, because the queue is drained"), "the coding agent's reply is missing");
  assert.ok(text.includes("The drain does not run on a timeout."), "the reviewer's reply is missing");
});

test("#802: each agent is given once, with what its latest stop recorded, and one that recorded nothing is named as such", () => {
  const records: readonly StateRecord[] = [
    reviewed(2, ["PRRT_b"], { sessionId: PARENT, subagent: SUBAGENT, transcript: TRANSCRIPT, lastMessage: "first" }, EARLIER_HEAD),
    { head: "1111111111111111111111111111111111111111", activity: null, owner: { sessionId: PARENT }, status: "not reviewed", reason: "superseded by 3f9c2e0" },
    reviewed(2, ["PRRT_b"], { sessionId: PARENT, subagent: SUBAGENT }),
  ];
  const record = records[2];
  assert.ok(record !== undefined);

  const text = composed(handoffFor(CHANGE, record, [PLAIN], DIFF, records));

  const reports = text.slice(text.indexOf("## The agents' final reports"), text.indexOf("## The diff"));
  assert.equal(
    reports,
    [
      "## The agents' final reports",
      `### Subagent ${SUBAGENT}, dispatched by session ${PARENT}`,
      "No final report or transcript was recorded for it.",
      `### Session ${PARENT}`,
      "No final report or transcript was recorded for it.",
      "",
    ].join("\n\n"),
  );
});

test("#802: a change with no description, and no agent recorded, says so rather than leaving its section empty", () => {
  const record = reviewed(2, ["PRRT_b"]);

  const text = composed(handoffFor({ ...CHANGE, description: "  \n" }, record, [PLAIN], DIFF, [record]));

  assert.ok(text.includes("## The description\n\nThe change has no description.\n\n"), text);
  assert.ok(text.includes("## The agents' final reports\n\nNo agent's stop was recorded for this episode.\n\n"), text);
});

test("#802: a diff holding a fence of its own is fenced with a longer one", () => {
  const record = reviewed(2, ["PRRT_b"]);
  const diff = "+```ts\n+const a = 1;\n+```\n";

  const text = composed(handoffFor(CHANGE, record, [PLAIN], diff, [record]));

  assert.ok(text.endsWith(`## The diff\n\n\`\`\`\`diff\n${diff}\`\`\`\`\n`), text);
});

test("#802: a round that closed the episode, or left nothing open, hands nothing off", () => {
  for (const record of [reviewed(3, ["PRRT_b"]), reviewed(0, [])]) {
    assert.deepEqual(handoffFor(CHANGE, record, [PLAIN], DIFF, [record]), { outcome: "none" }, JSON.stringify(record));
  }
  const clean: StateRecord = { head: HEAD, activity: null, status: "reviewed", result: "clean, episode open", round: { number: 2, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" } }, newFindings: 0 };
  assert.deepEqual(handoffFor(CHANGE, clean, [PLAIN], DIFF, [clean]), { outcome: "none" });
});

test("#802: a listing that holds none of the threads the round left open still open composes no handoff, rather than one with no threads", () => {
  const record = reviewed(2, ["PRRT_b"]);

  assert.deepEqual(handoffFor(CHANGE, record, [thread("PRRT_b", "Clock skew", [], true)], DIFF, [record]), { outcome: "no open thread listed" });
  assert.deepEqual(handoffFor(CHANGE, record, [], DIFF, [record]), { outcome: "no open thread listed" });
});
