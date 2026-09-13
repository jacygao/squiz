import assert from "node:assert/strict";
import { test } from "node:test";

import {
  defaultVerdict,
  statusOf,
  type ThreadAtClose,
  type ThreadStatus,
} from "./status.ts";

const fixedAndAnsweredBack: ThreadAtClose = {
  verdict: "fixed",
  codingAgentReplied: true,
};

const withdrawnAndAnsweredBack: ThreadAtClose = {
  verdict: "withdrawn",
  codingAgentReplied: true,
};

const stillWrongAndIgnored: ThreadAtClose = {
  verdict: "open",
  codingAgentReplied: false,
};

const stillWrongAndArguedWith: ThreadAtClose = {
  verdict: "open",
  codingAgentReplied: true,
};

// The case that decides what becomes of a thread the reviewer forgot. Reading
// it as anything but `open` closes threads nobody ruled on.

test("a thread the reviewer returned no verdict for is open", () => {
  const forgotten: ThreadAtClose = {
    verdict: null,
    codingAgentReplied: false,
  };
  assert.equal(defaultVerdict, "open", "the no-verdict default must be open");
  assert.equal(
    statusOf(forgotten),
    "open",
    "no verdict is a default of open, not an error and not a close",
  );
});

test("a thread the reviewer forgot that was replied to is disputed", () => {
  const forgottenAndArguedWith: ThreadAtClose = {
    verdict: null,
    codingAgentReplied: true,
  };
  assert.equal(
    statusOf(forgottenAndArguedWith),
    "disputed",
    "the no-verdict default must take the same path an open verdict takes",
  );
});

test("the verdict the reviewer names stands, whatever the coding agent did", () => {
  assert.equal(
    statusOf(fixedAndAnsweredBack),
    "fixed",
    "a reply must not turn a defect the reviewer says is gone into a dispute",
  );
  assert.equal(
    statusOf(withdrawnAndAnsweredBack),
    "withdrawn",
    "a reply must not turn a finding the reviewer withdrew into a dispute",
  );
});

test("a thread unresolved at the close is open, and disputed where there is a reply", () => {
  assert.equal(
    statusOf(stillWrongAndIgnored),
    "open",
    "a defect that still stands with no reply needs a person, as open",
  );
  assert.equal(
    statusOf(stillWrongAndArguedWith),
    "disputed",
    "a defect that still stands and was replied to is a disagreement to settle",
  );
});

test("every one of the four statuses comes out of a thread", () => {
  const produced = [
    fixedAndAnsweredBack,
    withdrawnAndAnsweredBack,
    stillWrongAndIgnored,
    stillWrongAndArguedWith,
  ].map(statusOf);
  const four: ThreadStatus[] = ["disputed", "fixed", "open", "withdrawn"];
  assert.deepEqual(
    [...new Set(produced)].sort(),
    four,
    "a status no input produces here may be unreachable in the code",
  );
});
