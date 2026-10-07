import assert from "node:assert/strict";
import { test } from "node:test";

import { renderComment, renderReply } from "../findings/comment.ts";
import type { ChangeFinding, FileFinding, LineFinding } from "../findings/finding.ts";
import type { Verdict } from "../findings/status.ts";
import type { ReviewThread, ThreadComment } from "../github/threads.ts";
import { classifyAtClose, type ClassifiedThread, type EpisodeAtClose } from "./classify.ts";
import type { PostedFindings, ThreadPlacement, Threaded } from "./post-findings.ts";
import type { AppliedVerdicts } from "./verdicts.ts";

/** A finding on a changed line, its body fields filled so a test names only its subject. */
function onLine(file: string, line: number, headline: string): LineFinding {
  return {
    scope: "line",
    file,
    line,
    severity: "high",
    headline,
    reasoning: ["The defect, in one bullet."],
    suggestedFix: "Do the other thing.",
  };
}

function onFile(file: string, headline: string): FileFinding {
  return {
    scope: "file",
    file,
    severity: "medium",
    headline,
    reasoning: ["The defect, in one bullet."],
    suggestedFix: "Do the other thing.",
  };
}

function onTheChange(headline: string): ChangeFinding {
  return {
    scope: "change",
    severity: "low",
    headline,
    reasoning: ["The defect, in one bullet."],
    suggestedFix: "Do the other thing.",
  };
}

// The comments are rendered by the writer the harness posts with rather than
// spelled out here. A fixture that spelled the marker itself would keep passing
// after the marker changed, which is the one thing that says who wrote a comment.
function comment(body: string): ThreadComment {
  return {
    id: "PRRC_fixture",
    createdAt: "2026-09-06T07:13:05Z",
    databaseId: 1,
    author: "octocat",
    body,
  };
}

/** The thread a finding's comment opened, as a later round is handed it. */
function threadFor(id: string, finding: LineFinding): ReviewThread {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path: finding.file,
    anchor: { at: "line", line: finding.line },
    comments: [comment(renderComment(finding))],
  };
}

/** The thread with the coding agent's answer on it, under its own marker. */
function answeredBack(thread: ReviewThread, text: string): ReviewThread {
  return { ...thread, comments: [...thread.comments, comment(renderReply(text))] };
}

/** A thread a person opened, which no marker claims. */
function personThread(id: string, path: string, line: number): ReviewThread {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path,
    anchor: { at: "line", line },
    comments: [comment("Why is this here at all?")],
  };
}

/**
 * What the round did to the threads it handed over, naming only the ruling on
 * each.
 *
 * Every outcome is `left-open`, because what the mutation did is not what
 * decides a thread's status. One test names an outcome of its own to pin that.
 */
function rulings(ruled: Readonly<Record<string, Verdict | null>>): AppliedVerdicts {
  return {
    threads: Object.entries(ruled).map(([thread, ruling]) => ({
      thread,
      ruled: ruling,
      outcome: "left-open",
    })),
    unapplied: [],
  };
}

function threaded(
  finding: LineFinding | FileFinding | ChangeFinding,
  placement: ThreadPlacement,
  threadId: string,
): Threaded {
  return {
    outcome: "threaded",
    finding,
    placement,
    url: "https://github.test/pull/1#discussion_r1",
    threadId,
  };
}

/** A finding whose comment landed and whose thread id did not come back. */
function threadedWithoutId(finding: LineFinding, placement: ThreadPlacement): Threaded {
  return {
    outcome: "threaded",
    finding,
    placement,
    url: "https://github.test/pull/1#discussion_r2",
    threadId: null,
    unknownThread: "the create answered with no thread id",
  };
}

function posted(...outcomes: PostedFindings["outcomes"]): PostedFindings {
  return { outcomes };
}

const nothingPosted = posted();

const nothingHandedOver: readonly ReviewThread[] = [];

/** An episode whose closing round raised nothing and was handed nothing. */
const quiet: EpisodeAtClose = {
  handedOver: nothingHandedOver,
  verdicts: rulings({}),
  findings: nothingPosted,
};

function statuses(classified: readonly ClassifiedThread[]): readonly string[] {
  return classified.map((thread) => thread.status);
}

test("an episode with nothing on its pull request classifies nothing", () => {
  assert.deepEqual(classifyAtClose(quiet), []);
});

test("the verdict the reviewer ruled is the status, found by the thread it names", () => {
  const gone = threadFor("PRRT_gone", onLine("src/queue.ts", 12, "Backoff resets on enqueue"));
  const wrong = threadFor("PRRT_wrong", onLine("src/queue.ts", 40, "There was no defect"));
  const classified = classifyAtClose({
    ...quiet,
    handedOver: [gone, wrong],
    // Keyed the other way round from the hand-over, so a ruling read off its
    // position would swap the two.
    verdicts: rulings({ PRRT_wrong: "withdrawn", PRRT_gone: "fixed" }),
  });
  assert.deepEqual(
    statuses(classified),
    ["fixed", "withdrawn"],
    "a verdict must reach the thread its identifier names",
  );
});

test("a thread the reviewer returned no verdict for is open", () => {
  const passedOver = threadFor("PRRT_1", onLine("src/queue.ts", 12, "Backoff resets on enqueue"));
  const ruledNothing = classifyAtClose({
    ...quiet,
    handedOver: [passedOver],
    verdicts: rulings({ PRRT_1: null }),
  });
  const absentEntirely = classifyAtClose({ ...quiet, handedOver: [passedOver] });
  assert.deepEqual(
    statuses(ruledNothing),
    ["open"],
    "a thread the reviewer forgot must not be closed by the forgetting",
  );
  assert.deepEqual(
    statuses(absentEntirely),
    ["open"],
    "a thread with no verdict entry at all is a thread the reviewer ruled nothing on",
  );
});

test("a thread the coding agent answered and the reviewer left open is disputed", () => {
  const argued = answeredBack(
    threadFor("PRRT_1", onLine("src/session.ts", 57, "Clock skew is read as token expiry")),
    "The skew is bounded by the token's own lifetime, so this cannot fire.",
  );
  assert.deepEqual(
    statuses(classifyAtClose({ ...quiet, handedOver: [argued], verdicts: rulings({}) })),
    ["disputed"],
    "a reply the reviewer did not rule on is a disagreement for a person to settle",
  );
  assert.deepEqual(
    statuses(
      classifyAtClose({ ...quiet, handedOver: [argued], verdicts: rulings({ PRRT_1: "open" }) }),
    ),
    ["disputed"],
    "a reply on a thread ruled still wrong is a disagreement too",
  );
  assert.deepEqual(
    statuses(
      classifyAtClose({ ...quiet, handedOver: [argued], verdicts: rulings({ PRRT_1: "fixed" }) }),
    ),
    ["fixed"],
    "a reply must not turn a defect the reviewer says is gone into a dispute",
  );
});

test("a thread the reviewer answered again is not a thread the coding agent replied to", () => {
  const finding = onLine("src/queue.ts", 12, "Backoff resets on enqueue");
  const reviewerSaidMore: ReviewThread = {
    ...threadFor("PRRT_1", finding),
    comments: [
      comment(renderComment(finding)),
      comment(renderComment(onLine("src/queue.ts", 12, "Still here after the rewrite"))),
    ],
  };
  assert.deepEqual(
    statuses(classifyAtClose({ ...quiet, handedOver: [reviewerSaidMore] })),
    ["open"],
    "only the coding agent's own marker makes a dispute",
  );
});

test("a thread whose reason could not be posted says so, and one whose reason landed does not (#511)", () => {
  const lost = threadFor("PRRT_lost", onLine("src/queue.ts", 12, "Backoff resets on enqueue"));
  const landed = threadFor("PRRT_landed", onLine("src/queue.ts", 40, "The cap is never read"));
  const classified = classifyAtClose({
    ...quiet,
    handedOver: [lost, landed],
    verdicts: {
      threads: [
        { thread: "PRRT_lost", ruled: "open", outcome: "left-open", reply: { outcome: "failed", reason: "HTTP 502" } },
        { thread: "PRRT_landed", ruled: "open", outcome: "left-open", reply: { outcome: "acted" } },
      ],
      unapplied: [],
    },
  });
  assert.deepEqual(
    classified.map((thread) => thread.reasonUnposted === true),
    [true, false],
  );
});

test("a thread closed whose reply could not be posted is not read as one kept open with no reason (#586)", () => {
  const classified = classifyAtClose({
    ...quiet,
    handedOver: [threadFor("PRRT_fixed", onLine("src/queue.ts", 12, "Backoff resets on enqueue"))],
    verdicts: {
      threads: [
        { thread: "PRRT_fixed", ruled: "fixed", outcome: "closed", reply: { outcome: "failed", reason: "HTTP 502" } },
      ],
      unapplied: [],
    },
  });
  assert.deepEqual(
    classified.map((thread) => thread.reasonUnposted === true),
    [false],
  );
});

test("a thread no marker claims is left out", () => {
  const classified = classifyAtClose({
    ...quiet,
    handedOver: [
      personThread("PRRT_person", "src/queue.ts", 3),
      threadFor("PRRT_1", onLine("src/queue.ts", 12, "Backoff resets on enqueue")),
    ],
    verdicts: rulings({ PRRT_1: "fixed" }),
  });
  assert.deepEqual(
    classified.map((thread) => thread.headline),
    ["Backoff resets on enqueue"],
    "a thread a person opened is not a finding of this review, and the summary counts findings",
  );
});

// The failure this cannot have: the thread was opened after the hand-over
// listing was read, so it is in the round's posted findings and nowhere else.
test("a thread the closing round itself posted is classified", () => {
  const raised = onLine("src/retry.ts", 8, "Every path here is dead once the queue lands");
  const classified = classifyAtClose({
    ...quiet,
    handedOver: nothingHandedOver,
    findings: posted(threaded(raised, "inline", "PRRT_new")),
  });
  assert.deepEqual(
    classified,
    [{ status: "open", headline: raised.headline, location: "src/retry.ts:8" }],
    "a finding raised in the last round is the one that most needs a person",
  );
});

test("a thread the closing round posted is classified beside the threads handed over", () => {
  const classified = classifyAtClose({
    handedOver: [threadFor("PRRT_1", onLine("src/queue.ts", 12, "Backoff resets on enqueue"))],
    verdicts: rulings({ PRRT_1: "fixed" }),
    findings: posted(
      threaded(onLine("src/retry.ts", 8, "Dead once the queue lands"), "inline", "PRRT_new"),
    ),
  });
  assert.deepEqual(
    classified.map((thread) => [thread.status, thread.location]),
    [
      ["fixed", "src/queue.ts:12"],
      ["open", "src/retry.ts:8"],
    ],
    "both sources are read, the hand-over first and this round's own threads after",
  );
});

test("a thread the closing round posted whose thread id did not come back is classified", () => {
  const raised = onLine("src/retry.ts", 8, "Dead once the queue lands");
  assert.deepEqual(
    classifyAtClose({ ...quiet, findings: posted(threadedWithoutId(raised, "inline")) }),
    [{ status: "open", headline: raised.headline, location: "src/retry.ts:8" }],
    "the comment is on the pull request and the finding still needs a person",
  );
});

test("a thread in both the hand-over and this round's postings is counted once", () => {
  const finding = onLine("src/queue.ts", 12, "Backoff resets on enqueue");
  const classified = classifyAtClose({
    handedOver: [threadFor("PRRT_1", finding)],
    verdicts: rulings({ PRRT_1: "fixed" }),
    findings: posted(threaded(finding, "inline", "PRRT_1")),
  });
  assert.deepEqual(
    statuses(classified),
    ["fixed"],
    "one thread has one status, and the hand-over is the account that carries its verdict",
  );
});

test("a finding nothing threaded is not classified", () => {
  const unplaced = onLine("src/untouched.ts", 4, "Nothing in the diff carries this");
  const classified = classifyAtClose({
    ...quiet,
    findings: posted(
      { outcome: "noted", finding: onTheChange("The approach is wrong"), location: undefined },
      { outcome: "noted", finding: unplaced, location: "src/untouched.ts:4" },
      { outcome: "failed", finding: unplaced, reason: "GitHub refused the create" },
    ),
  });
  assert.deepEqual(
    classified,
    [],
    "a finding no thread holds carries no status, and the summary's Notes is where it goes",
  );
});

test("a threaded finding naming no file is not classified", () => {
  const classified = classifyAtClose({
    ...quiet,
    findings: posted(threaded(onTheChange("The approach is wrong"), "file", "PRRT_new")),
  });
  assert.deepEqual(
    classified,
    [],
    "there is nowhere to say the thread is, and the router opens no thread for such a finding",
  );
});

test("a thread on a line is located as file:line, and one on a file by its file", () => {
  const onALine = threadFor("PRRT_line", onLine("src/queue.ts", 134, "Backoff resets on enqueue"));
  const onAFile: ReviewThread = {
    ...onALine,
    id: "PRRT_file",
    path: "src/retry.ts",
    anchor: { at: "file" },
  };
  const lineUnknown: ReviewThread = {
    ...onALine,
    id: "PRRT_unnamed",
    path: "src/window.ts",
    anchor: { at: "unnamed-line" },
  };
  const classified = classifyAtClose({
    ...quiet,
    handedOver: [onALine, onAFile, lineUnknown],
  });
  assert.deepEqual(
    classified.map((thread) => thread.location),
    ["src/queue.ts:134", "src/retry.ts", "src/window.ts"],
    "a location the summary prints carries a line only where the thread is on one",
  );
});

test("a thread this round posted on a file is located by its file alone", () => {
  const classified = classifyAtClose({
    ...quiet,
    findings: posted(
      // A finding scoped to a line whose line the diff did not carry. The comment
      // hangs on the file, which is how a later round is handed it.
      threaded(onLine("src/retry.ts", 8, "Dead once the queue lands"), "file", "PRRT_degraded"),
      threaded(onFile("src/window.ts", "This file duplicates the scheduler"), "file", "PRRT_file"),
    ),
  });
  assert.deepEqual(
    classified.map((thread) => thread.location),
    ["src/retry.ts", "src/window.ts"],
    "a thread on a file must be located the same way whichever source it is read from",
  );
});

test("the status a thread ends in is the reviewer's ruling, not what the mutation did", () => {
  const classified = classifyAtClose({
    ...quiet,
    handedOver: [threadFor("PRRT_1", onLine("src/queue.ts", 12, "Backoff resets on enqueue"))],
    verdicts: {
      threads: [
        {
          thread: "PRRT_1",
          ruled: "fixed",
          outcome: "failed",
          reason: "GitHub refused the resolve",
        },
      ],
      unapplied: [],
    },
  });
  assert.deepEqual(
    statuses(classified),
    ["fixed"],
    "the defect being gone is the reviewer's judgement, and a resolve that failed does not undo it",
  );
});

test("a headline the reviewer left blank is carried as none rather than as an empty one", () => {
  const blank = onLine("src/queue.ts", 12, "");
  assert.deepEqual(
    classifyAtClose({ ...quiet, handedOver: [threadFor("PRRT_1", blank)] }),
    [{ status: "open", headline: null, location: "src/queue.ts:12" }],
    "an empty headline would have the summary list a finding with nothing said about it",
  );
});

test("every thread on the pull request gets exactly one status", () => {
  const handedOver = [
    threadFor("PRRT_fixed", onLine("src/a.ts", 1, "Gone")),
    threadFor("PRRT_withdrawn", onLine("src/b.ts", 2, "No defect")),
    threadFor("PRRT_open", onLine("src/c.ts", 3, "Still wrong")),
    answeredBack(threadFor("PRRT_disputed", onLine("src/d.ts", 4, "Argued over")), "It cannot."),
    personThread("PRRT_person", "src/e.ts", 5),
  ];
  const classified = classifyAtClose({
    handedOver,
    verdicts: rulings({
      PRRT_fixed: "fixed",
      PRRT_withdrawn: "withdrawn",
      PRRT_open: "open",
      PRRT_disputed: "open",
      PRRT_person: "open",
    }),
    findings: posted(threaded(onLine("src/f.ts", 6, "Raised at the close"), "inline", "PRRT_new")),
  });
  assert.deepEqual(
    statuses(classified),
    ["fixed", "withdrawn", "open", "disputed", "open"],
    "four of this review's five threads came from the hand-over and the fifth from this round",
  );
});
