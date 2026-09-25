/**
 * Posting a round's new findings: each one routed, then opened as the thread its
 * routing names, and left to the summary comment where no thread can hold it.
 *
 * Nothing here throws, and no finding is dropped. Exactly one outcome comes back
 * for every finding handed in, because a finding that reaches neither a thread
 * nor the summary is a defect recorded nowhere at all while the round still
 * reads as clean.
 *
 * No aggregate verdict comes back either, so a round that posted some of its
 * findings cannot be read as a round that posted them all. A caller reports the
 * round by reading every outcome.
 */

import { renderComment } from "../findings/comment.ts";
import { orderBySeverity, type Finding } from "../findings/finding.ts";
import {
  routeFindings,
  type DegradedRouting,
  type FileRouting,
  type InlineRouting,
  type Routing,
} from "../findings/route.ts";
import type { GhCall } from "../github/gh.ts";
import { postFileThread, postThread, type ThreadPosting } from "../github/post-thread.ts";

/** A round's new findings, and the pull request their threads go on. */
export type NewFindings = {
  /**
   * The findings as the reviewer returned them. Ordering them by severity is
   * this module's, so that they are posted `high` to `low` whatever order a
   * caller hands them over in.
   */
  readonly findings: readonly Finding[];
  /** The pull request's diff, which decides where each finding's comment can hang. */
  readonly diff: string;
  readonly pullRequest: number;
  readonly headSha: string;
};

/** Whether a thread hangs on one line of a file or on the file as a whole. */
export type ThreadPlacement = "inline" | "file";

/**
 * A thread whose node id came back, which is every thread a later round can rule
 * on.
 */
type Ruleable = {
  /** The `PRRT_` id, which is what a reply, a resolve and a re-open are addressed to. */
  readonly threadId: string;
  readonly unknownThread?: never;
};

/**
 * A thread whose node id did not come back.
 *
 * The comment is on the pull request and no later round can rule on it. Posting
 * it again would put up a second copy, so the comment stays and this says why
 * nothing will be addressed to it.
 */
type Unruleable = {
  readonly threadId: null;
  readonly unknownThread: string;
};

/** A finding that is now a review comment thread on the pull request. */
export type Threaded = {
  readonly outcome: "threaded";
  readonly finding: Finding;
  readonly placement: ThreadPlacement;
  /** The comment's own URL, which is the only handle on a thread with no node id. */
  readonly url: string;
} & (Ruleable | Unruleable);

/**
 * A finding the summary comment carries, because no thread on this pull request
 * can hold it.
 *
 * Nothing is posted for it here. The summary is one comment written when the
 * episode closes, and a finding in it is a line of text that no later round
 * rules on.
 */
export type Noted = {
  readonly outcome: "noted";
  readonly finding: Finding;
  /**
   * Where the finding said the defect is, as the summary's Notes writes it:
   * `file:line` for a finding scoped to a line and the file alone for one scoped
   * to a file. `undefined` for a finding scoped to the change, which names no
   * location.
   */
  readonly location: string | undefined;
};

/**
 * A finding nothing on the pull request carries.
 *
 * Nothing is stored to retry it: a later round reads the same code and makes the
 * same finding.
 */
export type Failed = {
  readonly outcome: "failed";
  readonly finding: Finding;
  /** The one line the round reports: what GitHub did instead of opening the thread. */
  readonly reason: string;
};

/** What became of one finding. Every finding has one, and none has two. */
export type FindingOutcome = Threaded | Noted | Failed;

/** What became of a round's findings, and nothing about whether that went well. */
export type PostedFindings = {
  /** One outcome per finding, in the order the findings were posted in. */
  readonly outcomes: readonly FindingOutcome[];
  /**
   * Why the pull request's diff could not be read, where it could not. Every
   * finding naming a location is noted rather than threaded in that case, and
   * this is what tells that apart from a diff that carried neither the line nor
   * the file.
   */
  readonly unreadableDiff?: Error;
};

/**
 * Post each of `round`'s findings where its routing says, `high` severity first.
 *
 * Never throws, and never stops early. Every finding is attempted, because a
 * create that failed says nothing about the next one, and the comments that
 * landed stay: nothing here deletes or rewrites a comment it posted.
 *
 * A refused anchor is not a failure. GitHub would not place a comment there, and
 * the finding comes back `noted` for the summary to carry.
 */
export function postFindings(round: NewFindings, call: GhCall): PostedFindings {
  const routed = routeFindings(orderBySeverity(round.findings), round.diff);
  const outcomes = routed.routings.map((routing) => post(routing, round, call));
  if (routed.unreadableDiff === undefined) return { outcomes };
  return { outcomes, unreadableDiff: routed.unreadableDiff };
}

/** One finding's whole account, which for a general routing is posted nowhere. */
function post(routing: Routing, round: NewFindings, call: GhCall): FindingOutcome {
  switch (routing.placement) {
    case "inline":
      return onLine(routing, round, call);
    case "file":
      return onFile(routing, round, call);
    case "general":
      return { outcome: "noted", finding: routing.finding, location: routing.unplacedAnchor };
  }
}

function onLine(routing: InlineRouting, round: NewFindings, call: GhCall): FindingOutcome {
  const { finding } = routing;
  const posting = postThread(
    {
      pullRequest: round.pullRequest,
      headSha: round.headSha,
      // `RIGHT` because a finding is anchored only to a line the change added,
      // and an added line is counted in the head file.
      anchor: { path: finding.file, line: finding.line, side: "RIGHT" },
      body: renderComment(finding),
    },
    call,
  );
  // Written here rather than taken from the routing, which carries no location
  // for an anchor it placed. GitHub refusing the line is what the router could
  // not know, and the summary still has to say where the defect is.
  return outcomeOf(posting, finding, "inline", `${finding.file}:${finding.line}`);
}

function onFile(
  routing: FileRouting | DegradedRouting,
  round: NewFindings,
  call: GhCall,
): FindingOutcome {
  const { finding, unplacedAnchor } = routing;
  const comment = renderComment(finding);
  const posting = postFileThread(
    {
      pullRequest: round.pullRequest,
      headSha: round.headSha,
      path: finding.file,
      body: unplacedAnchor === undefined ? comment : namingTheLine(comment, unplacedAnchor),
    },
    call,
  );
  return outcomeOf(posting, finding, "file", unplacedAnchor ?? finding.file);
}

/**
 * The comment, with the line it could not be anchored to named in the text.
 *
 * The thread hangs on the file, so this is the only thing left saying which line
 * the defect is on.
 */
function namingTheLine(comment: string, anchor: string): string {
  const where = `**Where:** \`${anchor}\` — the diff carries no such line to anchor a comment to.`;
  return `${comment}\n\n${where}`;
}

/**
 * What one create came to, as the finding's one outcome.
 *
 * `location` is where the summary's Notes would say the defect is, and is used
 * only where GitHub refuses the anchor. That refusal is a routing signal rather
 * than a failure: nothing on the pull request holds the finding, so the summary
 * does.
 */
function outcomeOf(
  posting: ThreadPosting,
  finding: Finding,
  placement: ThreadPlacement,
  location: string,
): FindingOutcome {
  switch (posting.outcome) {
    case "posted":
      return {
        outcome: "threaded",
        finding,
        placement,
        url: posting.url,
        threadId: posting.threadId,
      };
    case "posted-without-thread-id":
      return {
        outcome: "threaded",
        finding,
        placement,
        url: posting.url,
        threadId: null,
        unknownThread: posting.reason,
      };
    case "anchor-refused":
      return { outcome: "noted", finding, location };
    case "failed":
      return { outcome: "failed", finding, reason: posting.reason };
  }
}
