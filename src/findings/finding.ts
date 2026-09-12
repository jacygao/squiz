/**
 * The finding contract: the one shape the reviewer returns and every later part
 * composes a comment from. A finding carries only what composes a comment and
 * what routes it, because the pull request holds the record.
 *
 * An anchor field a scope does not carry is declared absent rather than left
 * out. Leaving it out bars only a fresh object literal, so a finding built
 * elsewhere and widened to `Finding` would still carry an anchor nothing
 * downstream has a place for.
 */

// Severity orders the findings; it does not decide whether they count.
export type Severity = "high" | "medium" | "low";

/** The fields the comment template is composed from. */
type Body = {
  readonly severity: Severity;
  // The problem, named in one line.
  readonly headline: string;
  /**
   * The bullets beneath the headline, one point each. A list rather than one
   * string, because bullets rather than paragraphs is what the template asks
   * for and a string meets that only by accident.
   */
  readonly reasoning: readonly string[];
  // What to do about it.
  readonly suggestedFix: string;
  /**
   * A quoted convention, or something the reviewer could not check. Optional:
   * the comment must still stand with it deleted.
   *
   * The property being absent is the only way to carry none. An empty string is
   * a reference that is empty, which is a malformed finding rather than one
   * carrying none.
   */
  readonly reference?: string;
};

/** A finding anchored to a line the change touched, which becomes a thread. */
export type LineFinding = Body & {
  readonly scope: "line";
  readonly file: string;
  readonly line: number;
};

/**
 * A finding about a file rather than any line of it, which becomes a thread on
 * the file.
 *
 * The file is required: a thread on no file is a thread GitHub has nowhere to
 * put.
 */
export type FileFinding = Body & {
  readonly scope: "file";
  readonly file: string;
  readonly line?: never;
};

/** A finding about the change as a whole, which goes into the summary comment. */
export type ChangeFinding = Body & {
  readonly scope: "change";
  readonly file?: never;
  readonly line?: never;
};

export type Finding = LineFinding | FileFinding | ChangeFinding;

/**
 * Which scope a finding declares, for a caller that routes on it. Read off
 * `Finding` rather than written out again, so the two cannot drift apart.
 */
export type Scope = Finding["scope"];

// A severity added to the union with no place in the order is a type error,
// which is what `Record<Severity, number>` is here for.
const rank: Readonly<Record<Severity, number>> = { high: 0, medium: 1, low: 2 };

/**
 * Orders two findings by severity, `high` to `low`.
 *
 * Two findings of one severity compare equal. The tie is deliberately not
 * broken by `file:line`, which not every scope carries.
 */
export function bySeverity(a: Finding, b: Finding): number {
  return rank[a.severity] - rank[b.severity];
}

/**
 * The findings in the order they are reported: `high` to `low`, and within one
 * severity the order the reviewer returned them in.
 *
 * Holding to that returned order is this function's job rather than each
 * caller's. The array it is handed is left as it was.
 */
export function orderBySeverity(findings: readonly Finding[]): Finding[] {
  return findings.toSorted(bySeverity);
}

/** Whether the finding carries a reference, which the quote block is emitted for. */
export function hasReference(finding: Finding): boolean {
  return finding.reference !== undefined;
}
