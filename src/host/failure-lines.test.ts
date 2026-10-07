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
    },
  });

  assert.deepEqual(lines, [
    "the reviewer's reply on thread PRRT_lost could not be posted: GitHub could not be reached",
  ]);
});
