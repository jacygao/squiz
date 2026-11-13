import assert from "node:assert/strict";
import { test } from "node:test";

import type { Owner, StateRecord } from "../loop/state-record.ts";
import { printedThread } from "../review/output.ts";
import { followUpFor } from "../venues/github/venue.ts";
import type { ReviewThread } from "../venues/venue.ts";
import { threadLine } from "../findings/listing.ts";
import { handoffFor, updateFor } from "./handoff.ts";

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

test("#859: a session's own stop gives its report, and a Copilot subagent's names the parent's events.jsonl its events are in", () => {
  const copilotParent = "af7a1b25-6bdc-459f-99e1-5c3ab2513f83";
  const copilotSubagent = "dcc0b994-3d65-4ad3-92f3-ccf70b8232d5";
  const events = `/Users/someone/.copilot/session-state/${copilotParent}/events.jsonl`;
  const sessionTranscript = `/Users/someone/.claude/projects/-work-squiz/${PARENT}.jsonl`;
  const records: readonly StateRecord[] = [
    reviewed(2, ["PRRT_b"], { sessionId: PARENT, lastMessage: "DONE", transcript: sessionTranscript }, EARLIER_HEAD),
    reviewed(2, ["PRRT_b"], { sessionId: copilotParent, subagent: copilotSubagent, lastMessage: "PONG", parentTranscript: events }),
  ];
  const record = records[1];
  assert.ok(record !== undefined);

  const text = composed(handoffFor(CHANGE, record, [PLAIN], DIFF, records));

  const reports = text.slice(text.indexOf("## The agents' final reports"), text.indexOf("## The diff"));
  assert.equal(
    reports,
    [
      "## The agents' final reports",
      `### Session ${PARENT}`,
      `Transcript: ${sessionTranscript}`,
      "DONE",
      `### Subagent ${copilotSubagent}, dispatched by session ${copilotParent}`,
      `Transcript: none of its own. Its events are in its parent's transcript, ${events}`,
      "PONG",
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

test("#870: a description that is the run's prompt is given under the description heading, and says it is the prompt", () => {
  const record = reviewed(2, ["PRRT_b"]);
  const prompt = "Add backoff. Requirement: the first retry is immediate.\n";

  const text = composed(handoffFor({ ...CHANGE, description: prompt, descriptionFrom: "prompt" }, record, [PLAIN], DIFF, [record]));

  assert.ok(
    text.includes(
      "## The description\n\nNobody wrote a description of this change, so this is the prompt the run was started with:\n\nAdd backoff. Requirement: the first retry is immediate.\n\n## The open threads",
    ),
    text,
  );
});

test("#802: a diff holding a fence of its own is fenced with a longer one", () => {
  const record = reviewed(2, ["PRRT_b"]);
  const diff = "+```ts\n+const a = 1;\n+```\n";

  const text = composed(handoffFor(CHANGE, record, [PLAIN], diff, [record]));

  assert.ok(text.endsWith(`## The diff\n\n\`\`\`\`diff\n${diff}\`\`\`\`\n`), text);
});

test("#802: a diff with more backtick runs than a call takes arguments is fenced, rather than throwing", () => {
  const record = reviewed(2, ["PRRT_b"]);
  const diff = "+`a` ".repeat(300_000) + "\n";

  const text = composed(handoffFor(CHANGE, record, [PLAIN], diff, [record]));

  assert.ok(text.endsWith(`## The diff\n\n\`\`\`diff\n${diff}\`\`\`\n`), "the diff was not fenced with three backticks");
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

const RULED_OPEN = "**Squiz reviewer · open**\n\nThe drain does not run on a timeout.";
const RULED_FIXED = "**Squiz reviewer · fixed**\n\nThe reset now waits for an empty queue.";

test("#876: an update holds only what changed since the fixer's last handoff: the new threads whole, the new replies and rulings on threads it was shown, and the threads closed since", () => {
  const record = reviewed(2, ["PRRT_a", "PRRT_b", "PRRT_d"]);
  const disputed = thread("PRRT_a", "Retry backoff resets", [WONT_FIX, RULED_OPEN]);
  const closed = thread("PRRT_c", "The timer leaks", [WONT_FIX, RULED_FIXED], true);
  const quiet = thread("PRRT_d", "A name says nothing");
  // A person's thread, which the fixer was never shown.
  const person = thread("PRRT_person", "A person's thread", ["A reply nobody handed on."], true);
  const shown = ["PRRT_a-c0", "PRRT_a-c1", "PRRT_c-c0", "PRRT_c-c1", "PRRT_d-c0"];

  const update = updateFor(CHANGE, record, [disputed, PLAIN, closed, quiet, person], shown);

  assert.equal(update.outcome, "composed", JSON.stringify(update));
  assert.equal(
    update.outcome === "composed" ? update.text : "",
    [
      "# Update for PR #41 at 3f9c2e0, round 2",
      "Squiz reviewed PR #41 at 3f9c2e0 again in round 2: 3 threads are open. This holds only what changed since your last handoff.",
      followUpFor(41),
      "## New threads",
      printedThread(PLAIN),
      "## New replies on threads still open",
      `${threadLine(disputed)}\n  **Squiz reviewer · open**\n\n  The drain does not run on a timeout.`,
      "## Threads closed since",
      `${threadLine(closed)}\n  **Squiz reviewer · fixed**\n\n  The reset now waits for an empty queue.`,
      "## Still open, with nothing new",
      threadLine(quiet),
    ].join("\n\n") + "\n",
  );
  assert.deepEqual(
    [...(update.outcome === "composed" ? update.shown : [])].sort(),
    ["PRRT_a-c0", "PRRT_a-c1", "PRRT_a-c2", "PRRT_b-c0", "PRRT_c-c0", "PRRT_c-c1", "PRRT_c-c2", "PRRT_d-c0"],
    "what the fixer has now been shown is not every comment of each thread it was handed",
  );
});

test("#876: an update leaves out a section with nothing in it, and a round that hands nothing back gets none", () => {
  const record = reviewed(2, ["PRRT_b"]);

  const update = updateFor(CHANGE, record, [PLAIN], []);
  const text = update.outcome === "composed" ? update.text : "";
  assert.ok(text.includes("## New threads"), text);
  for (const empty of ["## New replies", "## Threads closed since", "## Still open"]) assert.ok(!text.includes(empty), `${empty} is there with nothing in it:\n${text}`);

  assert.deepEqual(updateFor(CHANGE, reviewed(3, ["PRRT_b"]), [PLAIN], []), { outcome: "none" });
  assert.deepEqual(updateFor(CHANGE, record, [], []), { outcome: "no open thread listed" });
});

test("#876: a handoff says which comments it showed, so a later update can leave them out", () => {
  const record = reviewed(2, ["PRRT_a"]);
  const handoff = handoffFor(CHANGE, record, [DISPUTED, PLAIN], DIFF, [record]);
  assert.deepEqual(handoff.outcome === "composed" ? handoff.shown : [], ["PRRT_a-c0", "PRRT_a-c1", "PRRT_a-c2"]);
});
