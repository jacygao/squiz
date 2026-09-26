/**
 * One run of `pi`, read out of its stdout in a single pass: what it cost, and
 * the review it returned.
 *
 * The cost and the review live in different events, and the stream runs to tens
 * of megabytes with one line of a few hundred kilobytes in it. So the two are
 * read together as the events go past rather than one after the other: a second
 * reader would find an exhausted stream and report that the reviewer completed
 * nothing, and buffering the events for it would hold the whole stream. What is
 * held here is three numbers, a flag, one reason, and the reports the reviewer
 * has made.
 *
 * Both halves are passed on as they arrive, as one figure for what the round
 * has so far. A caller that stops the process mid-stream keeps that, and it is
 * the whole of what a killed round has.
 *
 * The stop reasons are read before the review. A run that completed no message
 * reached no reviewer at all, and the reason it gives for that is the one worth
 * reporting.
 */

import {
  type ParsedRun,
  type ProgressSoFar,
  type Reported,
  type RoundCost,
  type RunResult,
  unspent,
} from "../adapter.ts";
import { costWith } from "./cost.ts";
import { type OutputRead, readOutput } from "./output.ts";
import { type PiEvent, readEvents } from "./stream.ts";

/**
 * What the pass has established so far.
 *
 * Mutable, and read after the pass rather than returned from it, because the
 * events are handed onward as they are counted and a generator's return value
 * is not what a consumer of it receives.
 */
type Tally = {
  cost: RoundCost;
  /** Whether any assistant message carried a stop reason of `stop`. */
  stopped: boolean;
  /** The last reason an errored message gave. `pi` writes none to stderr. */
  reason: string | undefined;
};

const nothingReported: Reported = {
  findings: [],
  verdicts: [],
  finished: false,
  answered: true,
};

/**
 * Read one run's whole output.
 *
 * `soFar` is told the running total and the reports so far as each arrives,
 * which is what a caller that stops the process mid-stream keeps. Never throws
 * on the stream's content; a stream that fails at its source still raises
 * through the iteration.
 */
export async function parse(
  stdout: AsyncIterable<string | Uint8Array>,
  soFar?: ProgressSoFar,
): Promise<ParsedRun> {
  const tally: Tally = { cost: unspent, stopped: false, reason: undefined };
  let reported: Reported = nothingReported;
  // One figure for the two halves, so a caller never holds a cost from one
  // moment of the run beside findings from another.
  const tell = (): void => soFar?.({ cost: tally.cost, ...reported });

  const output = await readOutput(counting(readEvents(stdout), tally, tell), (made) => {
    reported = made;
    tell();
  });
  return { cost: tally.cost, result: resultOf(tally, output) };
}

/**
 * Every event, passed straight on, with the cost and the stop reasons taken off
 * it as it goes.
 *
 * Nothing is kept but the tally, so the pass costs one event at a time however
 * long the stream runs.
 */
async function* counting(
  events: AsyncIterable<PiEvent>,
  tally: Tally,
  tell: () => void,
): AsyncGenerator<PiEvent> {
  for await (const event of events) {
    tally.cost = costWith(tally.cost, event);
    if (event.type === "message_end" && event.message.role === "assistant") {
      tell();
      if (event.message.stopReason === "stop") tally.stopped = true;
      if (event.message.errorMessage !== undefined) tally.reason = event.message.errorMessage;
    }
    yield event;
  }
}

/**
 * What the run established, from its stop reasons and then its output.
 *
 * An errored message is not a failed run. `pi` retries a failed request itself,
 * so one sits among the working messages of a round that reviewed, and a run
 * that completed a message is read for what the reviewer reported whatever else
 * it carries.
 *
 * A review the reviewer finished is a review whatever the messages around it
 * stopped for, so the output is read first. It is the reviewer's own word that
 * it was done, and nothing else in the run says as much.
 */
function resultOf(tally: Tally, output: OutputRead): RunResult {
  if (output.outcome === "read") {
    return { kind: "reviewed", findings: output.findings, verdicts: output.verdicts };
  }
  if (!tally.stopped) {
    return { kind: "incomplete", reason: tally.reason ?? "the reviewer completed no message" };
  }
  return { kind: "unparsed", reason: output.reason };
}
