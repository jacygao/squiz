/**
 * A finding as the markdown comment that goes on the pull request, written and
 * read back. One template serves every scope, and the anchor is not written into
 * the body: an anchored comment is placed where it belongs rather than naming it.
 *
 * Reading one back is here rather than beside its caller so that the marker, the
 * separator and the bold span are spelled once. A writer and a reader that spell
 * them differently make a summary that lists findings nobody raised.
 *
 * The coding agent's reply to a thread is composed here for that same reason.
 * The marker is the only thing that says who wrote a comment, and one spelled in
 * two places is wrong from the first edit that touches either.
 */

import { type Finding, type Severity, severityOf } from "./finding.ts";

/**
 * Who wrote a comment. Every comment is posted under the one GitHub account the
 * reviewer, the coding agent and the harness share, so the marker at the start
 * of a comment's first line is the only thing that says which of them wrote it.
 * A comment carrying none of the markers was written by a person.
 */
export type CommentAuthor = "reviewer" | "coding agent" | "harness" | "person";

/**
 * What a comment the reviewer wrote begins with, the bold span's opening and the
 * separator after the name included.
 *
 * The whole of it is one string because the character after the name is what
 * tells a finding from the summary the harness posts at the close: `**Squiz
 * review` is itself a prefix of `**Squiz reviewer`, and a matcher that stops at
 * the name reads that summary as a finding.
 */
const reviewerMarker = "**Squiz reviewer · ";

/**
 * What a comment the coding agent wrote begins with, the bold span's opening
 * included.
 *
 * The name is the whole of it. Nothing else is fixed about the line, so a reply
 * the coding agent marked for itself is read as its own whatever it put after
 * the name.
 */
const codingAgentMarker = "**Squiz coding agent";

/** What stands between the severity and the headline on the first line. */
const headlineSeparator = " — ";

/** What closes the bold span the first line is. */
const boldClose = "**";

/** A marker, and the author whose comments open with it. */
type Marked = {
  readonly author: Exclude<CommentAuthor, "person">;
  readonly begins: string;
};

/**
 * What each author's comment begins with. No marker here is a prefix of another,
 * which is what lets the first one that matches decide.
 */
const markers: readonly Marked[] = [
  { author: "reviewer", begins: reviewerMarker },
  { author: "coding agent", begins: codingAgentMarker },
  { author: "harness", begins: "**Squiz review — " },
];

/**
 * The reviewer's own comment, as its first line names the finding.
 *
 * Either field is `null` where the first line stopped before it. A field the
 * reviewer left blank contributes no block to the comment at all, so a first
 * line naming a severity and nothing after it is one the writer here produces.
 */
type ReviewerComment = {
  readonly by: "reviewer";
  // Null where the first line named nothing, or named none of the three severities.
  readonly severity: Severity | null;
  readonly headline: string | null;
};

/** A comment read: who wrote it, and what the reviewer's first line named. */
export type CommentReading = ReviewerComment | { readonly by: Exclude<CommentAuthor, "reviewer"> };

/**
 * The comment for one finding: the marker, the severity and the headline on the
 * first line, the reasoning as bullets, the suggested fix, and the reference
 * where there is one.
 *
 * No finding is refused and nothing here throws. Every field is rendered as one
 * line, any run of whitespace collapsed, so that a newline in the reviewer's
 * text cannot break the markdown around it. A field left blank by that
 * contributes no block at all, which is how a reference that is present and
 * empty is handled: there is nothing to quote, and the comment has to stand with
 * the reference deleted in any case.
 */
export function renderComment(finding: Finding): string {
  return [
    firstLine(finding),
    bullets(finding.reasoning),
    suggestedFix(finding.suggestedFix),
    quotedReference(finding.reference),
  ]
    .filter(nonEmpty)
    .join("\n\n");
}

/**
 * The comment the coding agent's reply to a thread goes on as: the marker on the
 * first line, and `text` beneath it as it was written.
 *
 * The marker takes a line of its own so that the reply's own markdown stands. The
 * text arrives from a shell and can begin a bullet, a heading or a quote, and a
 * marker prefixed onto that line would make prose of it. The reviewer reads every
 * comment on the thread and rules on what it reads, so a reply the marker mangled
 * is a reply it rules against.
 *
 * Nothing is refused and nothing here throws. A reply already carrying the marker
 * is handed back as it stands: marked twice is a shape nothing reading the thread
 * has a rule for. A reply with no text at all is the marker alone, which still
 * says who said nothing.
 */
export function renderReply(text: string): string {
  const said = text.trim();
  if (readComment(said).by === "coding agent") return said;
  return [`${codingAgentMarker}${boldClose}`, said].filter(nonEmpty).join("\n\n");
}

/**
 * What the comment `body` says: who wrote it, and for one the reviewer wrote,
 * the severity and the headline its first line names.
 *
 * Nothing is refused and nothing here throws. Any text at all is a comment
 * somebody wrote, and text carrying no marker is a person's.
 */
export function readComment(body: string): CommentReading {
  const line = firstLineOf(body);
  const marked = markers.find((marker) => line.startsWith(marker.begins));
  if (marked === undefined) return { by: "person" };
  if (marked.author !== "reviewer") return { by: marked.author };
  return { by: "reviewer", ...severityAndHeadline(line.slice(marked.begins.length)) };
}

function firstLine(finding: Finding): string {
  const parts = [finding.severity, oneLine(finding.headline)].filter(nonEmpty);
  return `${reviewerMarker}${parts.join(headlineSeparator)}${boldClose}`;
}

/**
 * The severity and the headline of what follows the marker on the first line.
 *
 * The split is on the first separator: a severity never carries one and a
 * headline is free to, so a later one belongs to the headline.
 */
function severityAndHeadline(rest: string): Omit<ReviewerComment, "by"> {
  // Only the last of them closes the span, so a headline ending in bold keeps its own.
  const inside = rest.endsWith(boldClose) ? rest.slice(0, -boldClose.length) : rest;
  const at = inside.indexOf(headlineSeparator);
  if (at === -1) return { severity: severityOf(oneLine(inside)), headline: null };
  return {
    severity: severityOf(oneLine(inside.slice(0, at))),
    headline: blankAsNone(inside.slice(at + headlineSeparator.length)),
  };
}

/**
 * The first line of `body`, its trailing whitespace gone.
 *
 * Dropped so that a body stored with CRLF endings closes its bold span where one
 * stored with LF closes it.
 */
function firstLineOf(body: string): string {
  const end = body.indexOf("\n");
  return (end === -1 ? body : body.slice(0, end)).trimEnd();
}

/**
 * The text as one line, or `null` where it is blank.
 *
 * An empty headline is not a headline. Answered as the empty string, it has a
 * summary list a finding with nothing said about it.
 */
function blankAsNone(text: string): string | null {
  const said = oneLine(text);
  return said === "" ? null : said;
}

function bullets(reasoning: readonly string[]): string {
  return reasoning
    .map(oneLine)
    .filter(nonEmpty)
    .map((point) => `- ${point}`)
    .join("\n");
}

function suggestedFix(fix: string): string {
  const stated = oneLine(fix);
  return stated === "" ? "" : `**Suggested fix:** ${stated}`;
}

function quotedReference(reference: string | undefined): string {
  const cited = oneLine(reference ?? "");
  return cited === "" ? "" : `> ${cited}`;
}

// A run of whitespace, a newline among it, is one space.
function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function nonEmpty(text: string): boolean {
  return text !== "";
}
