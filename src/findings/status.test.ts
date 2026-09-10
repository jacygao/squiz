import assert from "node:assert/strict";
import { test } from "node:test";

import {
  defaultVerdict,
  isReopened,
  statusOf,
  type ThreadAtClose,
  type ThreadStatus,
} from "./status.ts";

// Every thread below writes all three fields out. A boolean written into the
// wrong field is then visible where the thread is built rather than only in the
// assertion that fails.

const fixedAndAnsweredBack: ThreadAtClose = {
  verdict: "fixed",
  codingAgentReplied: true,
  codingAgentResolved: true,
};

const withdrawnAndAnsweredBack: ThreadAtClose = {
  verdict: "withdrawn",
  codingAgentReplied: true,
  codingAgentResolved: true,
};

const stillWrongAndIgnored: ThreadAtClose = {
  verdict: "open",
  codingAgentReplied: false,
  codingAgentResolved: false,
};

const stillWrongAndArguedWith: ThreadAtClose = {
  verdict: "open",
  codingAgentReplied: true,
  codingAgentResolved: false,
};

// The case that decides what becomes of a thread the reviewer forgot. Reading
// it as anything but `open` closes threads nobody ruled on.

test("a thread the reviewer returned no verdict for is open", () => {
  const forgotten: ThreadAtClose = {
    verdict: null,
    codingAgentReplied: false,
    codingAgentResolved: false,
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
    codingAgentResolved: false,
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

// The re-opened counter is a counter and not a fifth status, so each thread
// counted below is asserted to have a status as well as a count.

test("a thread the coding agent resolved and the reviewer ruled open is counted", () => {
  const resolvedThenRuledOpen: ThreadAtClose = {
    verdict: "open",
    codingAgentReplied: false,
    codingAgentResolved: true,
  };
  assert.equal(isReopened(resolvedThenRuledOpen), true, "the thread was re-opened");
  assert.equal(
    statusOf(resolvedThenRuledOpen),
    "open",
    "a counted thread still ends its episode in one of the four statuses",
  );
});

test("a thread the coding agent resolved and replied to, ruled open, is counted", () => {
  const resolvedRepliedThenRuledOpen: ThreadAtClose = {
    verdict: "open",
    codingAgentReplied: true,
    codingAgentResolved: true,
  };
  assert.equal(isReopened(resolvedRepliedThenRuledOpen), true, "the thread was re-opened");
  assert.equal(
    statusOf(resolvedRepliedThenRuledOpen),
    "disputed",
    "a counted thread still ends its episode in one of the four statuses",
  );
});

test("a thread the coding agent resolved and the reviewer forgot is counted", () => {
  const resolvedThenForgotten: ThreadAtClose = {
    verdict: null,
    codingAgentReplied: false,
    codingAgentResolved: true,
  };
  assert.equal(
    isReopened(resolvedThenForgotten),
    true,
    "the no-verdict default is open, which re-opens a resolved thread",
  );
  assert.equal(statusOf(resolvedThenForgotten), "open", "and it ends open");
});

test("a thread is not counted where the reviewer closed it or the coding agent left it open", () => {
  assert.equal(
    isReopened(fixedAndAnsweredBack),
    false,
    "a resolved thread the reviewer ruled fixed was closed, not re-opened",
  );
  assert.equal(
    isReopened(withdrawnAndAnsweredBack),
    false,
    "a resolved thread the reviewer withdrew was closed, not re-opened",
  );
  assert.equal(
    isReopened(stillWrongAndIgnored),
    false,
    "a thread the coding agent never resolved cannot be re-opened",
  );
  assert.equal(
    isReopened(stillWrongAndArguedWith),
    false,
    "a reply is not a resolve, so an argued thread was never re-opened",
  );
});
