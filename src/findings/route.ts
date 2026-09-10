/**
 * The router: where each finding's comment goes, an inline thread anchored to a
 * changed line or a line of text in the summary comment.
 *
 * The pull request is the whole record of a review, so a finding that routes
 * nowhere leaves no trace anywhere at all.
 * (review-harness-spec, "Pull request comments")
 */

import { type ChangedLines, DiffParseError, parseDiff, touchesLine } from "./diff.ts";
import type { ChangeFinding, Finding, LineFinding } from "./finding.ts";

/** A finding that becomes a review comment thread on the line it names. */
export type InlineRouting = {
  readonly placement: "inline";
  readonly finding: LineFinding;
};

/**
 * A finding the reviewer scoped to the change as a whole, which names no line.
 *
 * `unplacedAnchor` is declared absent rather than left out. Leaving it out bars
 * only a fresh object literal, so a routing built elsewhere and widened to
 * `Routing` would still carry a location no finding of this shape ever had.
 */
export type ChangeRouting = {
  readonly placement: "general";
  readonly finding: ChangeFinding;
  readonly unplacedAnchor?: never;
};

/**
 * A finding scoped to a line whose anchor the harness could not place.
 *
 * The anchor is carried as `file:line` text because the summary writes it into
 * its Notes. Required rather than optional: a general finding naming no
 * location is one a person cannot act on.
 * (review-harness-spec, "What the comment carries")
 */
export type UnplacedRouting = {
  readonly placement: "general";
  readonly finding: LineFinding;
  readonly unplacedAnchor: string;
};

export type Routing = InlineRouting | ChangeRouting | UnplacedRouting;

/** One round's findings, each routed, and the diff failure where there was one. */
export type Routed = {
  readonly routings: readonly Routing[];
  /**
   * Why the diff could not be read, where it could not. Every finding scoped to
   * a line routes general in that case, and this is the only thing that tells
   * that apart from a diff that was read and did not contain the line.
   */
  readonly unreadableDiff?: Error;
};

/**
 * Route each finding to an inline thread or to the summary comment.
 *
 * `scope` is the reviewer's judgement about what the finding is about, and is
 * never overridden here. The one decision this makes is whether the anchor a
 * `line` finding names can be placed.
 * (review-harness-spec, "Pull request comments")
 *
 * Returns one routing per finding, in the order they were handed in. Ordering
 * is `orderBySeverity`'s job in `finding.ts`, and a router that grouped the
 * inline findings together would take it back.
 *
 * Nothing here throws, and no finding is dropped. A diff that cannot be read
 * routes every finding general and is reported in `unreadableDiff`.
 */
export function routeFindings(findings: readonly Finding[], diff: string): Routed {
  let changed: ChangedLines;
  try {
    changed = parseDiff(diff);
  } catch (error) {
    // Every throw is caught, not only `DiffParseError`. A round whose findings
    // never reach the pull request is the failure this must not have, and a
    // parser that threw something else still failed to read the diff.
    return { routings: findings.map(general), unreadableDiff: asError(error) };
  }
  return { routings: findings.map((finding) => routeOne(finding, changed)) };
}

function routeOne(finding: Finding, changed: ChangedLines): Routing {
  // Only a line the change added is anchored to. GitHub would take a context
  // line too, but no finding is anchored to one: a finding is anchored to the
  // changed line that caused it.
  // (review-harness-spec, "Pull request comments")
  if (finding.scope === "line" && touchesLine(changed, finding.file, finding.line)) {
    return { placement: "inline", finding };
  }
  return general(finding);
}

/** The routing a finding takes when no anchor is placed for it. */
function general(finding: Finding): ChangeRouting | UnplacedRouting {
  if (finding.scope === "change") return { placement: "general", finding };
  return { placement: "general", finding, unplacedAnchor: `${finding.file}:${finding.line}` };
}

function asError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  return new DiffParseError(`the diff could not be read: ${String(thrown)}`);
}
