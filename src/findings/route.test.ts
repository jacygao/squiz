/**
 * The routing of a batch is asserted as a batch, not one finding at a time. The
 * failure this module exists to prevent is a finding that reaches neither
 * place, and a test that routes one finding at a time cannot see it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DiffParseError } from "./diff.ts";
import type { ChangeFinding, LineFinding } from "./finding.ts";
import {
  type ChangeRouting,
  type InlineRouting,
  type RoutableFinding,
  type Routed,
  routeFindings,
  type Routing,
  type UnplacedRouting,
} from "./route.ts";

/**
 * `git diff` of one changed line in a hundred-line file, copied from a scratch
 * repository rather than written by hand.
 *
 * Line 88 is the only line the change touched. Lines 85 to 87 and 89 to 91 are
 * context, and every other line of the file is outside the diff altogether, so
 * the fixture carries an anchorable line and two ways of missing it.
 */
const cardDiff = `
diff --git a/src/ui/card.ts b/src/ui/card.ts
index d3d0cb2..6db135b 100644
--- a/src/ui/card.ts
+++ b/src/ui/card.ts
@@ -85,7 +85,7 @@
 // line 85
 // line 86
 // line 87
-// line 88
+// line 88 CHANGED
 // line 89
 // line 90
 // line 91
`.slice(1);

// The same diff cut off inside its hunk, which is what one truncated in transit
// looks like: the header declares seven new lines and the body delivers four.
const cutOffDiff = cardDiff.split("\n").slice(0, 9).join("\n");

/** A finding scoped to a line, carrying its headline so a batch reads as names. */
function lineFinding(headline: string, file: string, line: number): LineFinding {
  return {
    scope: "line",
    file,
    line,
    severity: "high",
    headline,
    reasoning: ["The one point beneath the headline."],
    suggestedFix: "Do the other thing.",
  };
}

function changeFinding(headline: string): ChangeFinding {
  return {
    scope: "change",
    severity: "medium",
    headline,
    reasoning: ["The change as a whole, which no single line owns."],
    suggestedFix: "Take the other approach.",
  };
}

const onAChangedLine = lineFinding("on a changed line", "src/ui/card.ts", 88);
const onAContextLine = lineFinding("on a context line", "src/ui/card.ts", 85);
const inAnUntouchedFile = lineFinding("in an untouched file", "src/sync/queue.ts", 134);
const aboutTheChange = changeFinding("about the change as a whole");

function only(routed: Routed): Routing {
  assert.equal(routed.routings.length, 1, "one finding in must be one routing out");
  const [routing] = routed.routings;
  assert.ok(routing);
  return routing;
}

function inlineOnly(routed: Routed): InlineRouting {
  const routing = only(routed);
  assert.ok(routing.placement === "inline", `${routing.finding.headline} must route inline`);
  return routing;
}

function generalOnly(routed: Routed): ChangeRouting | UnplacedRouting {
  const routing = only(routed);
  assert.ok(routing.placement === "general", `${routing.finding.headline} must route general`);
  return routing;
}

function placements(routed: Routed): string[] {
  return routed.routings.map((routing) => routing.placement);
}

function headlines(routed: Routed): string[] {
  return routed.routings.map((routing) => routing.finding.headline);
}

test("a finding scoped to a line the change touched routes inline", () => {
  const routed = routeFindings([onAChangedLine], cardDiff);
  const routing = inlineOnly(routed);

  // The anchor is read off the finding without a cast, which is what M3 posts
  // the thread from.
  const anchored: LineFinding = routing.finding;
  assert.equal(anchored.file, "src/ui/card.ts");
  assert.equal(anchored.line, 88);
  assert.equal(routing.finding, onAChangedLine, "the finding routed is the finding handed in");
  assert.equal(routed.unreadableDiff, undefined, "the diff was read");
});

test("a finding scoped to the change routes general and acquires no anchor", () => {
  const routing = generalOnly(routeFindings([aboutTheChange], cardDiff));

  assert.equal(routing.finding, aboutTheChange);
  assert.equal(routing.unplacedAnchor, undefined, "there was no anchor to fail to place");
  assert.equal(
    Object.hasOwn(routing.finding, "file"),
    false,
    "routing must not give a finding scoped to the change a file",
  );
  assert.equal(
    Object.hasOwn(routing.finding, "line"),
    false,
    "routing must not give a finding scoped to the change a line",
  );
});

/**
 * A general finding naming no location is one a person cannot act on, and the
 * summary's Notes records exactly the location this carries.
 */
test("a finding whose anchor is rejected routes general, carrying its `file:line`", () => {
  const context = generalOnly(routeFindings([onAContextLine], cardDiff));
  assert.equal(
    context.unplacedAnchor,
    "src/ui/card.ts:85",
    "a finding on a line the change did not add keeps its own file:line",
  );

  const untouched = generalOnly(routeFindings([inAnUntouchedFile], cardDiff));
  assert.equal(untouched.unplacedAnchor, "src/sync/queue.ts:134");

  assert.equal(context.finding, onAContextLine, "the finding itself is unchanged by routing");
  assert.equal(context.finding.scope, "line", "the reviewer's scope is not rewritten");
});

/**
 * A finding that routes nowhere leaves nothing on the pull request, which is
 * the whole record of a review. A round that reported nothing then looks
 * exactly like a round that found nothing.
 */
test("no finding is dropped: the count out is the count in", () => {
  const findings: readonly RoutableFinding[] = [
    onAChangedLine,
    aboutTheChange,
    onAContextLine,
    inAnUntouchedFile,
    lineFinding("on the same changed line again", "src/ui/card.ts", 88),
  ];
  const routed = routeFindings(findings, cardDiff);

  assert.equal(routed.routings.length, findings.length, "every finding must route somewhere");
  assert.deepEqual(placements(routed), ["inline", "general", "general", "general", "inline"]);
  assert.deepEqual(
    routed.routings.map((routing) => routing.finding),
    findings,
    "each routing must carry the finding it was handed, and no substitute",
  );
});

test("an empty batch routes to an empty batch rather than to nothing", () => {
  const routed = routeFindings([], cardDiff);
  assert.deepEqual(routed.routings, []);
  assert.equal(routed.unreadableDiff, undefined);
});

/**
 * A diff that cannot be read and an anchor that was read and rejected are
 * different facts. If both routed general and said nothing, one malformed diff
 * would demote a whole round into the summary and the round would still look
 * healthy.
 */
test("an unreadable diff routes every finding general and is reported as such", () => {
  const findings: readonly RoutableFinding[] = [onAChangedLine, aboutTheChange, onAContextLine];
  const routed = routeFindings(findings, cutOffDiff);

  assert.equal(routed.routings.length, findings.length, "an unreadable diff drops no finding");
  assert.deepEqual(placements(routed), ["general", "general", "general"]);
  assert.ok(
    routed.unreadableDiff instanceof DiffParseError,
    `the diff failure must be reported, and was ${String(routed.unreadableDiff)}`,
  );
  assert.match(
    routed.unreadableDiff.message,
    /inside a hunk/,
    "the report must name what could not be read, so that a person can act on it",
  );
});

test("a diff that was read and rejected an anchor is not an unreadable diff", () => {
  const rejected = routeFindings([onAContextLine], cardDiff);
  const unreadable = routeFindings([onAContextLine], cutOffDiff);

  assert.deepEqual(placements(rejected), placements(unreadable), "both route general");
  assert.equal(
    rejected.unreadableDiff,
    undefined,
    "a diff that was read must not be reported as one that could not be",
  );
  assert.ok(unreadable.unreadableDiff !== undefined);
});

test("a finding routed general by an unreadable diff still carries its `file:line`", () => {
  const routing = generalOnly(routeFindings([onAChangedLine], cutOffDiff));
  assert.equal(routing.unplacedAnchor, "src/ui/card.ts:88");
});

/**
 * `orderBySeverity` in `finding.ts` decides the order findings are reported in.
 * A router that grouped the inline findings ahead of the general ones would
 * hand the summary an order nobody chose.
 */
test("the order the findings arrived in is the order they are routed in", () => {
  const findings: readonly RoutableFinding[] = [
    changeFinding("first"),
    onAChangedLine,
    changeFinding("third"),
    onAContextLine,
    lineFinding("fifth", "src/ui/card.ts", 88),
  ];
  const routed = routeFindings(findings, cardDiff);

  assert.deepEqual(headlines(routed), [
    "first",
    "on a changed line",
    "third",
    "on a context line",
    "fifth",
  ]);
  assert.deepEqual(placements(routed), ["general", "inline", "general", "general", "inline"]);
});

test("routing leaves the findings and the array it was handed as they were", () => {
  const findings = [onAChangedLine, aboutTheChange];
  const before = structuredClone(findings);
  routeFindings(findings, cardDiff);
  assert.deepEqual(findings, before);
});

// Nothing routed may throw: a throw escaping here loses every finding of the
// round, which the pull request would then hold no record of.

test("a diff that is not a diff at all is reported rather than thrown", () => {
  const routed = routeFindings([onAChangedLine], "the reviewer wrote prose here\n");
  assert.deepEqual(placements(routed), ["general"]);
  assert.ok(routed.unreadableDiff instanceof DiffParseError);
});

test("an empty diff is a diff with no changes, not one that could not be read", () => {
  const routed = routeFindings([onAChangedLine, aboutTheChange], "");
  assert.deepEqual(placements(routed), ["general", "general"]);
  assert.equal(routed.unreadableDiff, undefined, "a change touching nothing is readable");
});

test("a parser that throws something other than a parse error takes no finding down", () => {
  // The catch is not narrowed to `DiffParseError`. A value that is not a string
  // reaches `split` and throws a `TypeError`, which must be reported the same
  // way rather than escaping.
  const routed = routeFindings([onAChangedLine], undefined as unknown as string);
  assert.deepEqual(placements(routed), ["general"]);
  assert.ok(routed.unreadableDiff instanceof TypeError);
});

test("a parser that throws a value that is not an error is reported as one", () => {
  // JavaScript permits throwing anything, and a caller reading `.message` off a
  // thrown string would report the failure as `undefined`.
  const hostile = {
    split(): string[] {
      throw "not an Error";
    },
  } as unknown as string;
  const routed = routeFindings([aboutTheChange], hostile);

  assert.deepEqual(placements(routed), ["general"]);
  assert.ok(routed.unreadableDiff instanceof DiffParseError);
  assert.match(routed.unreadableDiff.message, /not an Error/);
});

// The illegal shapes below are checked by `npm run typecheck`, not by this run:
// `@ts-expect-error` is a compile-time assertion, and a shape that becomes
// legal fails the check as an unused directive.

test("the type refuses a routing that anchors a finding scoped to the change", () => {
  const built = {
    placement: "general" as const,
    finding: aboutTheChange,
    unplacedAnchor: "src/ui/card.ts:88",
  };
  // @ts-expect-error a finding scoped to the change has no anchor to have failed to place
  const widened: Routing = built;
  assert.equal(widened.placement, "general");
});

test("the type refuses a rejected anchor that reports no location", () => {
  // @ts-expect-error a finding routed general off a rejected anchor carries `file:line`
  const missing: UnplacedRouting = { placement: "general", finding: onAContextLine };
  assert.equal(missing.placement, "general");
});

test("the type refuses an inline routing of a finding scoped to the change", () => {
  // @ts-expect-error only a finding naming a file and a line can be anchored to one
  const anchored: InlineRouting = { placement: "inline", finding: aboutTheChange };
  assert.equal(anchored.placement, "inline");
});
