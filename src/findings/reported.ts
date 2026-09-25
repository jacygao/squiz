/**
 * A finding and a verdict as the reviewer reports one, read into the shapes the
 * harness composes a comment and a mutation from.
 *
 * Both ends of a report read through here. The call the reviewer makes is
 * refused against these rules while the reviewer is still there to be told, and
 * what comes back to the harness is read against them again. One reader rather
 * than two is what keeps a report the reviewer was told had landed from being
 * dropped on the way back.
 *
 * Never throws. A value that cannot be read comes back as the one line saying
 * why, and that line is what the reviewer is handed.
 */

import type { ThreadVerdict } from "../reviewers/adapter.ts";
import type { Finding } from "./finding.ts";
import type { Verdict } from "./status.ts";

/** A report read, or the one line saying why it could not be. */
export type Reading<T> = { readonly value: T } | { readonly reason: string };

/**
 * The fields every finding carries whatever its scope. Read off `Finding`
 * rather than written out again, so the two cannot drift apart.
 */
type FindingBody = Omit<Finding, "scope" | "file" | "line">;

/**
 * One finding, read as the scope it declares.
 *
 * An anchor a scope does not carry is refused rather than dropped. A finding
 * scoped to a file and naming a line makes two claims about what it is about,
 * and picking one of them here is picking at random.
 */
export function readFinding(value: unknown): Reading<Finding> {
  const record = recordOf(value);
  if (record === null) return { reason: "is not an object" };
  const body = bodyOf(record);
  if ("reason" in body) return body;
  switch (record["scope"]) {
    case "line": {
      const file = textOf(record["file"]);
      if (file === null) return { reason: "is scoped to a line and carries no file" };
      const line = numberOf(record["line"]);
      if (line === null) return { reason: "is scoped to a line and carries no line number" };
      return { value: { ...body.value, scope: "line", file, line } };
    }
    case "file": {
      const file = textOf(record["file"]);
      if (file === null) return { reason: "is scoped to a file and carries no file" };
      if (record["line"] !== undefined) return { reason: "is scoped to a file and carries a line" };
      return { value: { ...body.value, scope: "file", file } };
    }
    case "change": {
      if (record["file"] !== undefined) {
        return { reason: "is scoped to the change and carries a file" };
      }
      if (record["line"] !== undefined) {
        return { reason: "is scoped to the change and carries a line" };
      }
      return { value: { ...body.value, scope: "change" } };
    }
    default:
      return { reason: "names no scope of line, file or change" };
  }
}

/** One ruling on one thread, read as the thread it names and the verdict it gives. */
export function readVerdict(value: unknown): Reading<ThreadVerdict> {
  const record = recordOf(value);
  if (record === null) return { reason: "is not an object" };
  const thread = textOf(record["thread"]);
  if (thread === null) return { reason: "names no thread" };
  const verdict = verdictOf(record["verdict"]);
  if (verdict === null) {
    return { reason: `is none of fixed, withdrawn or open, on thread ${thread}` };
  }
  return { value: { thread, verdict } };
}

/** The fields a finding carries whatever its scope, or the first one missing. */
function bodyOf(record: Readonly<Record<string, unknown>>): Reading<FindingBody> {
  const severity = severityOf(record["severity"]);
  if (severity === null) return { reason: "names no severity of high, medium or low" };
  const headline = textOf(record["headline"]);
  if (headline === null) return { reason: "carries no headline" };
  const reasoning = reasoningOf(record["reasoning"]);
  if (reasoning === null) return { reason: "carries no reasoning" };
  const suggestedFix = textOf(record["suggestedFix"]);
  if (suggestedFix === null) return { reason: "carries no suggested fix" };

  const reference = record["reference"];
  if (reference === undefined) return { value: { severity, headline, reasoning, suggestedFix } };
  // A reference that is present and empty is a malformed finding rather than
  // one carrying none, which is what leaving the key out is for.
  if (reference === "") return { reason: "carries an empty reference" };
  const quoted = textOf(reference);
  if (quoted === null) return { reason: "carries a reference that is not text" };
  return { value: { severity, headline, reasoning, suggestedFix, reference: quoted } };
}

/** The bullets beneath the headline, or `null` where they are not a list of them. */
function reasoningOf(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const items: readonly unknown[] = value;
  const points: string[] = [];
  for (const item of items) {
    const point = textOf(item);
    if (point === null) return null;
    points.push(point);
  }
  return points;
}

function severityOf(value: unknown): Finding["severity"] | null {
  switch (value) {
    case "high":
    case "medium":
    case "low":
      return value;
    default:
      return null;
  }
}

function verdictOf(value: unknown): Verdict | null {
  switch (value) {
    case "fixed":
    case "withdrawn":
    case "open":
      return value;
    default:
      return null;
  }
}

/** A value read as its fields, or `null` where it is not an object at all. */
function recordOf(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

/** A field read as a non-empty string, or `null` where it is anything else. */
function textOf(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value;
}

/** A field read as a finite number, or `null` where it is anything else. */
function numberOf(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}
