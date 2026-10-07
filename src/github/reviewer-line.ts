/**
 * The summary's reviewer line: which reviewer CLI ran each round of the episode,
 * and on which model.
 *
 * Every name here is one a round recorded from its own run. The model the
 * project configured is never given in place of one the run did not report:
 * a CLI that silently ran another model would then read as having honoured the
 * setting, and a line naming the wrong model reads exactly like a right one.
 */

import type { Reviewer } from "../config/config.ts";

/** What a round recorded about who reviewed it. */
export type ReviewedBy = {
  readonly reviewer?: Reviewer;
  readonly models?: readonly string[];
};

/** One reviewer and one model, and the rounds that ran on the two. */
type Ran = { readonly reviewer: string; readonly model: string; readonly rounds: number[] };

/**
 * The reviewer line for an episode whose rounds are `rounds`, as one line with
 * no trailing newline, or `null` where no round ran.
 *
 * A reviewer or a model a round did not record is named as unknown. Where every
 * round ran the same reviewer on the same models, the line names them once.
 * Otherwise each model is named with the rounds that ran on it, under the
 * reviewer that ran them, in the order the rounds first named each.
 */
export function renderReviewerLine(rounds: readonly ReviewedBy[]): string | null {
  if (rounds.length === 0) return null;

  const ran: Ran[] = [];
  rounds.forEach((round, index) => {
    const reviewer = round.reviewer === undefined ? "an unknown reviewer" : `\`${round.reviewer}\``;
    const models = round.models === undefined || round.models.length === 0
      ? ["an unknown model"]
      : round.models.map(codeSpan);
    for (const model of models) {
      const known = ran.find((entry) => entry.reviewer === reviewer && entry.model === model);
      if (known === undefined) ran.push({ reviewer, model, rounds: [index + 1] });
      else if (!known.rounds.includes(index + 1)) known.rounds.push(index + 1);
    }
  });

  const everyRound = ran.every((entry) => entry.rounds.length === rounds.length);
  const reviewers = [...new Set(ran.map((entry) => entry.reviewer))];
  const byReviewer = reviewers.map((reviewer) => {
    const own = ran.filter((entry) => entry.reviewer === reviewer);
    if (everyRound) return `by ${reviewer} on ${allOf(own.map((entry) => entry.model))}`;
    const each = own.map((entry) => `on ${entry.model} in ${roundsNamed(entry.rounds)}`);
    return `by ${reviewer} ${each.join(", and ")}`;
  });
  return `Reviewed ${byReviewer.join(", and ")}`;
}

/**
 * `name` as one inline code span on one line.
 *
 * A model's name is the CLI's own text. A newline in it would end the line and
 * start a heading or a bullet, and a backtick would end the span early, so
 * whitespace collapses and the fence is longer than any backtick run inside.
 */
function codeSpan(name: string): string {
  const said = name.replace(/\s+/gu, " ").trim();
  const longest = Math.max(0, ...(said.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = said.startsWith("`") || said.endsWith("`") ? " " : "";
  return `${fence}${pad}${said}${pad}${fence}`;
}

/** `round 2`, `rounds 1 and 3`, or `rounds 1, 3 and 4`. */
function roundsNamed(numbers: readonly number[]): string {
  return `${numbers.length === 1 ? "round" : "rounds"} ${allOf(numbers.map(String))}`;
}

/** `a`, `a and b`, or `a, b and c`. */
function allOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
