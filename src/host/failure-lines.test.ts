import assert from "node:assert/strict";
import { test } from "node:test";

import { failureLinesOf } from "./host.ts";

test("a failed round names each reason the reviewer gave that could not be posted (#511)", () => {
  const lines = failureLinesOf({
    outcome: "failed",
    failure: "unavailable",
    reason: "the reviewer stopped without finishing its review",
    salvaged: {
      pullRequest: 41,
      posted: [],
      findings: { outcomes: [] },
      verdicts: {
        threads: [
          { thread: "PRRT_posted", ruled: "open", outcome: "left-open", reply: { outcome: "acted" } },
          {
            thread: "PRRT_lost",
            ruled: "open",
            outcome: "left-open",
            reply: { outcome: "failed", reason: "GitHub could not be reached" },
          },
          { thread: "PRRT_closed", ruled: "fixed", outcome: "closed" },
        ],
        unapplied: [],
      },
      unappliedNotes: [],
      unpostedReplyNotes: [],
    },
  });

  assert.deepEqual(lines, [
    "the reviewer's reply on thread PRRT_lost could not be posted: GitHub could not be reached",
  ]);
});

test("a failed round names each ruling it could not apply, with what the reviewer ruled (#605)", () => {
  const lines = failureLinesOf({
    outcome: "failed",
    failure: "unavailable",
    reason: "the reviewer stopped without finishing its review",
    salvaged: {
      pullRequest: 41,
      posted: [],
      findings: { outcomes: [] },
      verdicts: {
        threads: [{ thread: "PRRT_refused", ruled: "fixed", outcome: "failed", reason: "GitHub answered 502" }],
        unapplied: [
          { thread: "PRRT_invented", verdict: "withdrawn", reason: "no thread with that id was handed to the reviewer" },
        ],
      },
      unappliedNotes: [],
      unpostedReplyNotes: [],
    },
  });

  assert.deepEqual(lines, [
    "the reviewer ruled thread PRRT_refused fixed, and it could not be resolved: GitHub answered 502",
    "the reviewer ruled thread PRRT_invented withdrawn, and the ruling was not applied: no thread with that id was handed to the reviewer",
  ]);
});
