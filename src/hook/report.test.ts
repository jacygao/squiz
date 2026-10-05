import assert from "node:assert/strict";
import { test } from "node:test";

import { failureLine } from "./report.ts";

test("the failure pointer reads the way the specification records it", () => {
  assert.equal(
    failureLine("round 3 found 3 findings and could not post them to PR #142"),
    "squiz: round 3 found 3 findings and could not post them to PR #142\n",
  );
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

test("whitespace within a line is left as it arrived", () => {
  // A reason can carry a path, and a path with its spaces collapsed names a
  // directory that does not exist.
  assert.equal(
    failureLine('no review ran in "/work/two  spaces/\ttab"'),
    'squiz: no review ran in "/work/two  spaces/\ttab"\n',
  );
});

test("a reason naming nothing still says that something failed", () => {
  // A bare prefix on stderr is silence dressed as a report, which a failure
  // must never be.
  const line = failureLine("  \n\t ");

  assert.notEqual(line, "squiz: \n");
  assert.ok(line.startsWith("squiz: the hook failed"));
  assert.equal(line.indexOf("\n"), line.length - 1);
});
