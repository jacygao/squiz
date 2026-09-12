/**
 * A finding rendered as the markdown comment that goes on the pull request.
 * One template serves every scope, and the anchor is not written into the body:
 * an anchored comment is placed where it belongs rather than naming it.
 */

import type { Finding } from "./finding.ts";

/**
 * What a comment written by the reviewer begins with. A comment carrying none
 * of the specification's markers was written by a person, so this is a contract
 * rather than a label. The table gives it bolded on its own; the template folds
 * it into the first line's bold span, so what a reader or a later matcher has
 * is the prefix.
 */
const marker = "Squiz reviewer";

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

function firstLine(finding: Finding): string {
  const named = [`${marker} · ${finding.severity}`, oneLine(finding.headline)];
  return `**${named.filter(nonEmpty).join(" — ")}**`;
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
