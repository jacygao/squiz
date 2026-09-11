import assert from "node:assert/strict";
import { test } from "node:test";

import { failureLine } from "./report.ts";

test("the failure pointer reads the way the specification records it", () => {
  assert.equal(
    failureLine("round 3 found 3 findings and could not post them to PR #142"),
    "squiz: round 3 found 3 findings and could not post them to PR #142\n",
  );
});

test("a blocking reason cannot be carried by the failure pointer", () => {
  // The hook's two stderr channels stay apart. A blocking reason is several lines of
  // the round's own text, and the coding agent reads it as an instruction.
  // Anything handed to the reporter leaves as one line under the failure
  // prefix, so the pointer has nowhere to grow into the other channel.
  const blockingReason = [
    "Squiz reviewed the change on this branch and left 3 comments on PR #6.",
    "",
    "  gh pr view 6 --comments",
    "",
    "Address what applies, reply on anything you disagree with, then finish.",
  ].join("\n");

  const line = failureLine(blockingReason);

  assert.ok(line.startsWith("squiz: "));
  assert.equal(line.indexOf("\n"), line.length - 1);
});

test("every reason leaves as exactly one line", () => {
  const reasons = [
    "posting to PR #142 failed",
    "posting to PR #142 failed\n",
    "\nposting to PR #142 failed",
    "posting to PR #142\r\nfailed",
    "posting to\tPR #142 failed",
    "posting to PR #142 failed\n\n\n",
  ];

  for (const reason of reasons) {
    const line = failureLine(reason);
    assert.equal(line.indexOf("\n"), line.length - 1, `not one line: ${JSON.stringify(line)}`);
    assert.ok(line.startsWith("squiz: "), `no prefix: ${JSON.stringify(line)}`);
  }
});

test("a reason naming nothing still says that something failed", () => {
  // A bare prefix on stderr is silence dressed as a report, which a failure
  // must never be.
  const line = failureLine("  \n\t ");

  assert.notEqual(line, "squiz: \n");
  assert.ok(line.startsWith("squiz: the hook failed"));
  assert.equal(line.indexOf("\n"), line.length - 1);
});
