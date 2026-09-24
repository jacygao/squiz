/**
 * What the reviewer returned for one round, read out of the stream's events as
 * findings and verdicts.
 *
 * The reviewer's last message is one JSON object and nothing else: no prose
 * around it and no code fence, carrying `findings` and `verdicts` always, each
 * empty where there is nothing to report. So an empty list of findings is a
 * review that honestly found nothing, and output that could not be read is a
 * failure carrying a reason. The two never collapse into one another: an empty
 * list standing for both would read as a clean review forever.
 *
 * Every field is checked against the shape a finding is declared in rather than
 * asserted to have it, because a field the reviewer omitted or mistyped has to
 * be caught before anything composes a comment from it.
 *
 * Nothing here decides whether the round failed or should be run again. That
 * reads the run's stop reasons, which this never looks at.
 */

import type { Finding } from "../../findings/finding.ts";
import type { Verdict } from "../../findings/status.ts";
import type { RoundOutput, ThreadVerdict } from "../adapter.ts";
import type { PiEvent, PiMessage } from "./stream.ts";

/** Why the output could not be read. One line, which is what the caller reports. */
type Failure = { readonly outcome: "failed"; readonly reason: string };

/** What the run's output established. */
export type OutputRead = ({ readonly outcome: "read" } & RoundOutput) | Failure;

/** A part read, or the one line saying why it could not be. */
type Reading<T> = { readonly value: T } | { readonly reason: string };

/**
 * The fields every finding carries whatever its scope. Read off `Finding`
 * rather than written out again, so the two cannot drift apart.
 */
type FindingBody = Omit<Finding, "scope" | "file" | "line">;

/** As much of the reviewer's message as a reason quotes. */
const EXCERPT_LIMIT = 120;

/**
 * Read the findings and the verdicts out of a round's events.
 *
 * They come from the last assistant message of the run, whatever its stop
 * reason: `pi` retries a failed request itself, so an errored message sits
 * before the one that replaced it.
 *
 * A line the reader could not turn into an event does not fail this on its own,
 * because the findings arrive in one message and a dropped line is almost never
 * that message. It is counted, and a failure names how many were dropped, since
 * one of them may have been it.
 *
 * Never throws. Output that carries no readable findings comes back as `failed`
 * with a reason naming what was wrong with it.
 */
export async function readOutput(events: AsyncIterable<PiEvent>): Promise<OutputRead> {
  let last: PiMessage | undefined;
  let dropped = 0;
  for await (const event of events) {
    if (event.type === "unreadable") dropped += 1;
    if (event.type === "message_end" && event.message.role === "assistant") last = event.message;
  }
  if (last === undefined) return failed("the run completed no assistant message", dropped);
  const said = textIn(last);
  if (said === "") return failed("the reviewer's last message carries no text", dropped);
  return readSaid(said, dropped);
}

/**
 * The verdict the reviewer returned for `thread`, or `null` where it returned
 * none.
 *
 * `null` is a missing verdict reported as missing, and not a verdict of its
 * own. What a thread nobody ruled on counts as is decided where a thread's
 * status is, and deciding it here as well would put one rule in two places.
 */
export function verdictFor(verdicts: readonly ThreadVerdict[], thread: string): Verdict | null {
  return verdicts.find((ruled) => ruled.thread === thread)?.verdict ?? null;
}

/** The reviewer's message, read as the object it is meant to be. */
function readSaid(said: string, dropped: number): OutputRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(said);
  } catch {
    return failed(`the reviewer's last message is not JSON: ${excerptOf(said)}`, dropped);
  }
  const record = recordOf(parsed);
  if (record === null) {
    return failed(`the reviewer's last message is not one object: ${excerptOf(said)}`, dropped);
  }
  const findings = findingsOf(record["findings"]);
  if ("reason" in findings) return failed(findings.reason, dropped);
  const verdicts = verdictsOf(record["verdicts"]);
  if ("reason" in verdicts) return failed(verdicts.reason, dropped);
  return { outcome: "read", findings: findings.value, verdicts: verdicts.value };
}

/**
 * The findings, or the one that could not be read.
 *
 * One malformed finding fails the whole output rather than being dropped from
 * it. A list short of the finding nobody was told about is the silence this
 * refuses.
 */
function findingsOf(value: unknown): Reading<readonly Finding[]> {
  if (!Array.isArray(value)) {
    return { reason: "the reviewer's last message carries no list of findings" };
  }
  const items: readonly unknown[] = value;
  const findings: Finding[] = [];
  for (const [index, item] of items.entries()) {
    const finding = findingOf(item);
    if ("reason" in finding) return { reason: `finding ${index + 1} ${finding.reason}` };
    findings.push(finding.value);
  }
  return { value: findings };
}

/**
 * One finding, read as the scope it declares.
 *
 * An anchor a scope does not carry is refused rather than dropped. A finding
 * scoped to a file and naming a line makes two claims about what it is about,
 * and picking one of them here is picking at random.
 */
function findingOf(value: unknown): Reading<Finding> {
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
      if (record["file"] !== undefined) return { reason: "is scoped to the change and carries a file" };
      if (record["line"] !== undefined) return { reason: "is scoped to the change and carries a line" };
      return { value: { ...body.value, scope: "change" } };
    }
    default:
      return { reason: "names no scope of line, file or change" };
  }
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

/**
 * The verdicts, or the one that could not be read.
 *
 * A thread named twice fails the output. Two rulings on one thread is a
 * contradiction, and taking either of them is taking it at random.
 */
function verdictsOf(value: unknown): Reading<readonly ThreadVerdict[]> {
  if (!Array.isArray(value)) {
    return { reason: "the reviewer's last message carries no list of verdicts" };
  }
  const items: readonly unknown[] = value;
  const verdicts: ThreadVerdict[] = [];
  const ruled = new Set<string>();
  for (const [index, item] of items.entries()) {
    const at = `verdict ${index + 1}`;
    const record = recordOf(item);
    if (record === null) return { reason: `${at} is not an object` };
    const thread = textOf(record["thread"]);
    if (thread === null) return { reason: `${at} names no thread` };
    const verdict = verdictOf(record["verdict"]);
    if (verdict === null) {
      return { reason: `${at} is none of fixed, withdrawn or open, on thread ${thread}` };
    }
    if (ruled.has(thread)) return { reason: `thread ${thread} carries more than one verdict` };
    ruled.add(thread);
    verdicts.push({ thread, verdict });
  }
  return { value: verdicts };
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

/**
 * What the message said: its text blocks concatenated in the order they
 * arrived, with thinking and tool calls left out.
 *
 * Nothing goes between the blocks. A block boundary is where a tool call
 * interrupted the text rather than anything the reviewer wrote, so a separator
 * here would land inside whatever token the interruption fell in.
 */
function textIn(message: PiMessage): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type !== "text") continue;
    const text = textOf(block["text"]);
    if (text !== null) parts.push(text);
  }
  return parts.join("").trim();
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

/**
 * A failure, carrying how many lines the reader dropped where it dropped any.
 *
 * One of them may have been the message the findings were in, and a reason that
 * said only that no findings arrived would send a reader looking in the wrong
 * place.
 */
function failed(reason: string, dropped: number): Failure {
  if (dropped === 0) return { outcome: "failed", reason };
  const lines = dropped === 1 ? "1 line" : `${dropped} lines`;
  return { outcome: "failed", reason: `${reason}; ${lines} of the stream could not be read` };
}

/** As much of the message as a reason carries. It has no length this can rely on. */
function excerptOf(said: string): string {
  return said.length > EXCERPT_LIMIT ? `${said.slice(0, EXCERPT_LIMIT - 3)}...` : said;
}
