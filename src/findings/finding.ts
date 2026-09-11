/**
 * The finding contract: the one shape the reviewer returns and every later part
 * composes a comment from. A finding carries only what composes a comment and
 * what routes it, because the pull request holds the record.
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
 * A finding about the change as a whole, which goes into the summary comment.
 *
 * `file` and `line` are declared absent rather than left out. Leaving them out
 * bars only a fresh object literal, so a finding built elsewhere and widened to
 * `Finding` would still carry an anchor the summary has nowhere to put.
 */
export type ChangeFinding = Body & {
  readonly scope: "change";
  readonly file?: never;
  readonly line?: never;
};

export type Finding = LineFinding | ChangeFinding;

/**
 * Which of the two a finding is, for a caller that routes on it. Read off
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
 * broken by `file:line`, which a finding scoped to the change does not carry.
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
