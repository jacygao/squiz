/**
 * The router: where each finding's comment goes, a thread anchored to a changed
 * line, a thread on a file as a whole, or a line of text in the summary comment.
 *
 * The pull request is the whole record of a review, so a finding that routes
 * nowhere leaves no trace anywhere at all. A thread is worth more than a line of
 * text, because only a thread is ruled on again in a later round, so a finding
 * takes the summary only when the diff carries nowhere to hang a thread.
 */

import { type ChangedLines, DiffParseError, filesNamed, parseDiff, touchesFile, touchesLine } from "./diff.ts";
import type { ChangeFinding, FileFinding, Finding, LineFinding } from "./finding.ts";

/** A finding that becomes a review comment thread on the line it names. */
export type InlineRouting = {
  readonly placement: "inline";
  readonly finding: LineFinding;
};

/**
 * A finding the reviewer scoped to a file, or to the change as a whole, which
 * becomes a thread on the file it names.
 *
 * `unplacedAnchor` and `namedFile` are declared absent rather than left out.
 * Leaving them out bars only a fresh object literal, so a routing built
 * elsewhere and widened to `Routing` would still carry a location no finding of
 * this shape ever had.
 */
export type FileRouting = {
  readonly placement: "file";
  readonly finding: FileFinding | ChangeFinding;
  readonly unplacedAnchor?: never;
  readonly namedFile?: never;
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
  readonly namedFile?: never;
};

/**
 * A finding about the change as a whole whose file the diff does not name, on
 * the first file the diff does name.
 *
 * The finding's `file` is the one the thread hangs on, and `namedFile` the one
 * the reviewer named, which the comment writes into its body so that a reader
 * can tell why the thread is where it is.
 */
export type MovedRouting = {
  readonly placement: "file";
  readonly finding: ChangeFinding;
  readonly unplacedAnchor?: never;
  readonly namedFile: string;
};

/**
 * A finding naming a location the harness could not place, neither on its line
 * nor on its file.
 *
 * The location is carried as text because the summary writes it into its Notes:
 * `file:line` for a finding scoped to a line, and the file alone for one scoped
 * to a file. Required rather than optional: a note naming no location is one a
 * person cannot act on.
 */
export type UnplacedRouting = {
  readonly placement: "noted";
  readonly finding: LineFinding | FileFinding;
  readonly unplacedAnchor: string;
};

/**
 * A finding about the change as a whole that no file can hold, because the diff
 * carries none or could not be read. Its note is about the change as a whole,
 * so it carries no location.
 */
export type UnplacedChangeRouting = {
  readonly placement: "noted";
  readonly finding: ChangeFinding;
  readonly unplacedAnchor?: never;
};

export type Routing =
  | InlineRouting
  | FileRouting
  | DegradedRouting
  | MovedRouting
  | UnplacedRouting
  | UnplacedChangeRouting;

/** One round's findings, each routed, and the diff failure where there was one. */
export type Routed = {
  readonly routings: readonly Routing[];
  /**
   * Why the diff could not be read, where it could not. Every finding is noted
   * in that case, and this is the only thing that tells that apart from a diff
   * that was read and carried neither the line nor the file.
   */
  readonly unreadableDiff?: Error;
};

/**
 * Route each finding to an inline thread, to a thread on a file, or to the
 * summary's notes.
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
 * notes every finding and is reported in `unreadableDiff`.
 */
export function routeFindings(findings: readonly Finding[], diff: string): Routed {
  let changed: ChangedLines;
  try {
    changed = parseDiff(diff);
  } catch (error) {
    // Every throw is caught, not only `DiffParseError`. A round whose findings
    // never reach the pull request is the failure this must not have, and a
    // parser that threw something else still failed to read the diff.
    return { routings: findings.map(noted), unreadableDiff: asError(error) };
  }
  // A file thread needs no line, so a deleted file and an unaltered rename hold
  // one too, though neither has a line to anchor to.
  const named = [...new Set([...filesNamed(diff), ...changed.keys()])];
  return { routings: findings.map((finding) => routeOne(finding, changed, named)) };
}

function routeOne(finding: Finding, changed: ChangedLines, named: readonly string[]): Routing {
  if (finding.scope === "change") {
    if (named.includes(finding.file)) return { placement: "file", finding };
    // A finding about the change as a whole is about every file of it, so any
    // file the diff names holds it. Only a thread keeps it open for a later
    // round to rule on.
    const [first] = named;
    if (first === undefined) return noted(finding);
    return { placement: "file", finding: { ...finding, file: first }, namedFile: finding.file };
  }


  if (finding.scope === "file") {
    if (touchesFile(changed, finding.file)) return { placement: "file", finding };
    return noted(finding);
  }

  // Only a line the change added is anchored to. GitHub would take a context
  // line too, but no finding is anchored to one: a finding is anchored to the
  // changed line that caused it.
  if (touchesLine(changed, finding.file, finding.line)) return { placement: "inline", finding };

  if (touchesFile(changed, finding.file)) {
    return { placement: "file", finding, unplacedAnchor: locationOf(finding) };
  }
  return noted(finding);
}

/**
 * The routing a finding takes when the diff places nothing for it.
 *
 * An unreadable diff sends every finding here, a file-scoped one included: a
 * diff that could not be read is not evidence that GitHub would take the file.
 */
function noted(finding: Finding): UnplacedRouting | UnplacedChangeRouting {
  if (finding.scope === "change") return { placement: "noted", finding };
  return { placement: "noted", finding, unplacedAnchor: locationOf(finding) };
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
