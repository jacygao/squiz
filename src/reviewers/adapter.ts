/**
 * The contract one reviewer CLI's adapter meets, and the vocabulary its two
 * sides share.
 *
 * An adapter is the whole of what knowing a CLI costs: the command line it
 * takes, the tools it is granted at each depth, and how its output reads back.
 * Everything around it — starting the process, confining it, bounding its time,
 * deciding what the round returned — is written once against these types, so a
 * second reviewer is a second adapter and no other change.
 */

import type { Depth, Thinking } from "../config/config.ts";
import type { Finding } from "../findings/finding.ts";
import type { Verdict } from "../findings/status.ts";

/** What the harness hands the reviewer for one round. */
export type Invocation = {
  /**
   * The git work tree holding the change under review. The reviewer runs with
   * this as its current directory.
   */
  readonly directory: string;
  /** The charter file, whose contents the CLI appends to its system prompt. */
  readonly charterFile: string;
  /** The task prompt, carrying the pull request and the threads already on it. */
  readonly prompt: string;
  readonly sessionDirectory: string;
  /**
   * Where the reviewer's temporary files go, so that a probe script or a
   * scratch file cannot land in the tree under review. `TMPDIR` points at it,
   * and it exists before the process starts.
   */
  readonly scratchDirectory: string;
  /**
   * How much the reviewer is allowed to do. The harness decides it; the adapter
   * turns it into the grant and never chooses a value of its own.
   */
  readonly depth: Depth;
  /**
   * How hard the reviewer thinks. The harness decides it, and the adapter puts
   * it on every command line rather than leaving the CLI to its own setting.
   */
  readonly thinking: Thinking;
};

/** A process to start: what to run, what to pass it, and where it runs. */
export type CommandLine = {
  readonly command: string;
  readonly args: readonly string[];
  readonly directory: string;
};

/** What a round spent: the dollars the CLI priced it at, and the tokens behind them. */
export type RoundCost = {
  /** US dollars. Zero against a non-zero `tokens` is unknown rather than free. */
  readonly dollars: number;
  readonly tokens: number;
  /** How many assistant messages the two figures cover. */
  readonly messages: number;
};

/**
 * A round that has reported nothing yet.
 *
 * It is also what a round killed before its first assistant message completed
 * comes back as, which is a fact about that round rather than a missing figure.
 */
export const unspent: RoundCost = Object.freeze({ dollars: 0, tokens: 0, messages: 0 });

/** The reviewer's ruling on one thread it was handed. */
export type ThreadVerdict = {
  /** The identifier the thread was handed over under, copied back. */
  readonly thread: string;
  readonly verdict: Verdict;
};

/** What one round of review returned. */
export type RoundOutput = {
  /** Empty where the reviewer found nothing, which is a result and not a failure. */
  readonly findings: readonly Finding[];
  /** Only the threads the reviewer ruled on. A thread it passed over has no entry. */
  readonly verdicts: readonly ThreadVerdict[];
};

/**
 * Told the round's cost each time an assistant message adds to it.
 *
 * It is where a killed round's figure comes from. The process is stopped with
 * its output half-read, so the last figure the caller was told is all there is,
 * and waiting for the parse to finish would wait on a stream that has stopped.
 */
export type CostSoFar = (cost: RoundCost) => void;

/** What one run of the reviewer established, its whole output read. */
export type RunResult =
  | ({ readonly kind: "reviewed" } & RoundOutput)
  /**
   * Output the adapter could not read as a review. The caller runs a fresh
   * process once and reports the reviewer unavailable if that fails too.
   */
  | { readonly kind: "unparsed"; readonly reason: string }
  /**
   * The run completed no message, and the reason the reviewer gave for it.
   * Never retried: the CLI has already retried the request itself, so a second
   * process spends a second run watching the same failure.
   */
  | { readonly kind: "incomplete"; readonly reason: string };

/**
 * What one run cost and what it established.
 *
 * The cost stands whatever the result is. A run that completed nothing still
 * spent whatever its messages reported before it stopped.
 */
export type ParsedRun = {
  readonly cost: RoundCost;
  readonly result: RunResult;
};

/** The three parts of driving one reviewer CLI. */
export type Adapter = {
  /** Build the command line for one round, from what the harness set for it. */
  readonly argv: (invocation: Invocation) => CommandLine;
  /**
   * Read the run's whole output: what it cost, and the review it returned.
   *
   * One pass, holding nothing. The stream runs to tens of megabytes, so a
   * second reader over a buffer of it is the one implementation ruled out.
   * `costSoFar` is how a caller that will stop the process mid-stream still has
   * a figure for it.
   */
  readonly parse: (
    stdout: AsyncIterable<string | Uint8Array>,
    costSoFar?: CostSoFar,
  ) => Promise<ParsedRun>;
  /**
   * Which tools the CLI is given at each depth.
   *
   * It sits beside the command line rather than only inside it, so that what a
   * round was allowed to do is readable without parsing the arguments back.
   */
  readonly grants: Readonly<Record<Depth, readonly string[]>>;
};
