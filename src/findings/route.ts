/**
 * The router: where each finding's comment goes, a thread anchored to a changed
 * line, a thread on a file as a whole, or a line of text in the summary comment.
 *
 * The pull request is the whole record of a review, so a finding that routes
 * nowhere leaves no trace anywhere at all. A thread is worth more than a line of
 * text, because only a thread is ruled on again in a later round, so a finding
 * takes the summary only when the diff carries nowhere to hang a thread.
 */

import { type ChangedLines, DiffParseError, parseDiff, touchesFile, touchesLine } from "./diff.ts";
import type { ChangeFinding, FileFinding, Finding, LineFinding } from "./finding.ts";

/** A finding that becomes a review comment thread on the line it names. */
export type InlineRouting = {
  readonly placement: "inline";
  readonly finding: LineFinding;
};

/**
 * A finding the reviewer scoped to a file, which becomes a thread on that file.
 *
 * `unplacedAnchor` is declared absent rather than left out. Leaving it out bars
 * only a fresh object literal, so a routing built elsewhere and widened to
 * `Routing` would still carry a location no finding of this shape ever had.
 */
export type FileRouting = {
  readonly placement: "file";
  readonly finding: FileFinding;
  readonly unplacedAnchor?: never;
};

/**
 * A finding scoped to a line, on the file rather than the line, because the diff
 * does not carry the line.
 *
 * The anchor is carried as `file:line` text because the comment writes it into
 * its body. The thread hangs on the file, so the text is the only thing left
 * saying which line the defect is on, and it is required for that reason.
 */
export type DegradedRouting = {
  readonly placement: "file";
  readonly finding: LineFinding;
  readonly unplacedAnchor: string;
};

/**
 * A finding the reviewer scoped to the change as a whole, which names no file.
 *
 * `unplacedAnchor` is declared absent for the reason `FileRouting` gives.
 */
export type ChangeRouting = {
  readonly placement: "general";
  readonly finding: ChangeFinding;
  readonly unplacedAnchor?: never;
};

/**
 * A finding naming a location the harness could not place, neither on its line
 * nor on its file.
 *
 * The location is carried as text because the summary writes it into its Notes:
 * `file:line` for a finding scoped to a line, and the file alone for one scoped
 * to a file. Required rather than optional: a general finding naming no location
 * is one a person cannot act on.
 */
export type UnplacedRouting = {
  readonly placement: "general";
  readonly finding: LineFinding | FileFinding;
  readonly unplacedAnchor: string;
};

export type Routing =
  | InlineRouting
  | FileRouting
  | DegradedRouting
  | ChangeRouting
  | UnplacedRouting;

/** One round's findings, each routed, and the diff failure where there was one. */
export type Routed = {
  readonly routings: readonly Routing[];
  /**
   * Why the diff could not be read, where it could not. Every finding naming a
   * location routes general in that case, and this is the only thing that tells
   * that apart from a diff that was read and carried neither the line nor the
   * file.
   */
  readonly unreadableDiff?: Error;
};

/**
 * Route each finding to an inline thread, to a thread on its file, or to the
 * summary comment.
 *
 * `scope` is the reviewer's judgement about what the finding is about, and is
 * never overridden here. The one decision this makes is whether the diff carries
 * the place the finding names.
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
  if (finding.scope === "change") return { placement: "general", finding };

  if (finding.scope === "file") {
    if (touchesFile(changed, finding.file)) return { placement: "file", finding };
    return general(finding);
  }

  // Only a line the change added is anchored to. GitHub would take a context
  // line too, but no finding is anchored to one: a finding is anchored to the
  // changed line that caused it.
  if (touchesLine(changed, finding.file, finding.line)) return { placement: "inline", finding };

  if (touchesFile(changed, finding.file)) {
    return { placement: "file", finding, unplacedAnchor: locationOf(finding) };
  }
  return general(finding);
}

/**
 * The routing a finding takes when the diff places nothing for it.
 *
 * An unreadable diff sends every finding here, a file-scoped one included: a
 * diff that could not be read is not evidence that GitHub would take the file.
 */
function general(finding: Finding): ChangeRouting | UnplacedRouting {
  if (finding.scope === "change") return { placement: "general", finding };
  return { placement: "general", finding, unplacedAnchor: locationOf(finding) };
}

/** Where the finding said the defect is, as the text a comment carries. */
function locationOf(finding: LineFinding | FileFinding): string {
  if (finding.scope === "file") return finding.file;
  return `${finding.file}:${finding.line}`;
}

function asError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  return new DiffParseError(`the diff could not be read: ${String(thrown)}`);
}
