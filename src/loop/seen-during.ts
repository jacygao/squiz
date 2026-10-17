/**
 * What squiz saw during a round the time bound killed, one clause each, for the
 * round's failure line.
 *
 * A clause states what was observed and never what caused it. Squiz cannot tell
 * a slow provider from a long review, so a person reading the line judges that.
 * Each thing squiz can observe about a killed round adds its own clause here.
 */

import type { FailedRequests } from "../reviewers/adapter.ts";
import type { Round, Sleep } from "../reviewers/round.ts";

type TimedOut = Extract<Round, { readonly outcome: "timed-out" }>;

/** As much of a provider's error as a clause quotes. An error has no length this can rely on. */
const ERROR_LIMIT = 120;

/** The clauses, in the order the line gives them. Empty where squiz saw nothing it can say. */
export function seenDuring(review: TimedOut): readonly string[] {
  return [messagesOf(review), failuresOf(review.failedRequests), sleepOf(review.sleep)].filter(
    (clause): clause is string => clause !== undefined,
  );
}

/**
 * The messages the reviewer completed, and the bound shared out among them.
 *
 * A round with no cost says nothing: its CLI reports a cost only as it exits, so
 * a count of none would be a guess.
 */
function messagesOf(review: TimedOut): string | undefined {
  const messages = review.cost?.messages;
  if (messages === undefined) return undefined;
  if (messages === 0) return "the reviewer completed no message";
  const each = Math.round(review.seconds / messages);
  const took = each === 0 ? "under a second" : `about ${each} ${each === 1 ? "second" : "seconds"}`;
  if (messages === 1) return `the reviewer's one message took ${took}`;
  return `the reviewer's ${messages} messages took ${took} each`;
}

function failuresOf(failed: FailedRequests | undefined): string | undefined {
  if (failed === undefined || failed.count === 0) return undefined;
  const counted = `its provider failed ${failed.count} ${failed.count === 1 ? "request" : "requests"}`;
  if (failed.last === undefined || failed.last.trim() === "") return counted;
  return `${counted}, the last with "${quoted(failed.last)}"`;
}

function sleepOf(sleep: Sleep | undefined): string | undefined {
  if (sleep === undefined) return undefined;
  const seconds = Math.round(sleep.slept / 1_000);
  if (seconds < 60) return `the machine slept for ${seconds} ${seconds === 1 ? "second" : "seconds"} of the round`;
  const minutes = Math.round(seconds / 60);
  return `the machine slept for ${minutes} ${minutes === 1 ? "minute" : "minutes"} of the round`;
}

/** The error's first line, cut where a failure line could not carry the rest. */
function quoted(error: string): string {
  const line = (error.trim().split("\n")[0] ?? "").trim();
  return line.length > ERROR_LIMIT ? `${line.slice(0, ERROR_LIMIT)}…` : line;
}
