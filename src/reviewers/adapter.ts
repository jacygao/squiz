/**
 * The contract one reviewer CLI's adapter meets, and the vocabulary its two
 * sides share.
 *
 * An adapter is the whole of what knowing a CLI costs: the command line it
 * takes, the tools it is granted at each depth, how what the reviewer reported reads back, and
 * whatever that CLI has to be handed for reporting a finding to be a call it
 * validates. Everything around it — starting the process, confining it,
 * bounding its time, deciding what the round returned — is written once against
 * these types, so a second reviewer is a second adapter and no other change.
 */

import type { Depth, Thinking } from "../config/config.ts";
import type { Finding } from "../findings/finding.ts";
import type { Verdict } from "../findings/status.ts";
import type { RoundSpace } from "./groups.ts";

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
  /**
   * The file holding `prompt`, written by the round before the process starts.
   *
   * It is for a CLI that takes its prompt from a file. The prompt has newlines,
   * and Herdr refuses to start a command with a newline in any argument.
   */
  readonly promptFile: string;
  readonly sessionDirectory: string;
  /**
   * The file the reviewer reports into, one line for each thing it did that the
   * round reads. The round empties it before each process starts, so nothing of
   * an earlier run is read as this one's.
   */
  readonly reportsFile: string;
  /**
   * Where the reviewer's temporary files go, so that a probe script or a
   * scratch file cannot land in the tree under review. `TMPDIR` points at it,
   * and it exists before the process starts.
   */
  readonly scratchDirectory: string;
  /**
   * The round's own `gh` configuration directory, which `GH_CONFIG_DIR` names.
   * The round empties it before the reviewer starts, so a `gh` the reviewer or
   * its test command runs finds no login there.
   */
  readonly githubConfigDirectory: string;
  /**
   * How much the reviewer is allowed to do. The harness decides it; the adapter
   * turns it into the grant and never chooses a value of its own.
   */
  readonly depth: Depth;
  /**
   * The configured test command, which `run_tests` runs at `deep`. `null` where
   * none is configured.
   */
  readonly test: string | null;
  /**
   * How hard the reviewer thinks. The harness decides it, and the adapter puts
   * it on every command line rather than leaving the CLI to its own setting.
   */
  readonly thinking: Thinking;
  /**
   * The model the project configured, in the CLI's own spelling. `null` leaves
   * the CLI on its own default, with the command line it has without one.
   */
  readonly model: string | null;
  /**
   * The round's own space: where each run of the test command records the
   * group it leads.
   *
   * `undefined` at `read`, where nothing runs the test command and there is
   * nothing to record and nothing to reach.
   */
  readonly roundSpace: RoundSpace | undefined;
  /**
   * Where the reviewer runs: in a pane a person can watch and type into, or
   * with no terminal at all. The round host decides it, and the adapter builds
   * the command line for it.
   */
  readonly terminal: "pane" | "none";
};

/** A process to start: what to run, what to pass it, and where it runs. */
export type CommandLine = {
  readonly command: string;
  readonly args: readonly string[];
  readonly directory: string;
  /**
   * What the process must read its stdin from. Whoever starts it owes it this,
   * because a CLI handed the wrong stdin can hang with nothing to show for it.
   */
  readonly stdin: "/dev/null" | "terminal";
  /**
   * What to add to the process's environment. It travels with the command line
   * because a pane runs the line as given, with nothing else passed alongside.
   */
  readonly environment: Readonly<Record<string, string>>;
};

/** What a round spent: the dollars the CLI priced it at, and the tokens behind them. */
export type RoundCost = {
  /** US dollars. Zero against a non-zero `tokens` is unknown rather than free. */
  readonly dollars: number;
  readonly tokens: number;
  /** How many assistant messages the two figures cover. */
  readonly messages: number;
  /** AI credits, where the CLI prices a run in them rather than in dollars. */
  readonly credits?: number;
  /**
   * The figures are at least what was spent and may be less than it, because
   * the run's end could not confirm that every message's spend was counted.
   * Absent where it could.
   */
  readonly floor?: true;
};

/**
 * A round that has reported nothing yet.
 *
 * It is also what a round killed before its first assistant message completed
 * comes back as, which is a fact about that round rather than a missing figure.
 */
export const unspent: RoundCost = Object.freeze({ dollars: 0, tokens: 0, messages: 0 });

/**
 * What a run spent, or `undefined` where it has no cost: the CLI reported no
 * figure for it.
 *
 * No cost is not a zero. A zero is a round that spent nothing, and it is summed
 * into the summary's totals and counted against the token bound as one.
 */
export type Spend = RoundCost | undefined;

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

/** What the reviewer has reported, and whether it has said the review is done. */
export type Reported = RoundOutput & {
  /**
   * How many of the reviewer's calls the run refused before they ran.
   *
   * A review that spent its window being refused reports the same findings as
   * one that had nothing to say, and this is the whole of the difference
   * between them. Zero on a CLI whose adapter refuses nothing.
   */
  readonly refusals: number;
  /**
   * Whether the reviewer has reported its review complete.
   *
   * It is the only thing that says a review is finished, and it is why a caller
   * stopped at the bound keeps this: a run the time bound ended after the reviewer
   * declared its review is that review rather than a round that failed.
   */
  readonly finished: boolean;
  /**
   * Why a line of the report file could not be read, or a report the run
   * accepted could not be read back, where either happened.
   *
   * The reviewer was told that report had landed. It fails the output rather
   * than shortening it, and a declaration does not settle it, so a caller
   * stopped at the bound needs it beside `finished`. `undefined` is every line
   * read as the reviewer wrote it.
   */
  readonly broken: string | undefined;
};

/** What a round has so far: what it has spent, and what the reviewer has reported. */
export type RoundProgress = { readonly cost: Spend } & Reported;

/**
 * Told what the round has so far, each time the run adds to it.
 *
 * It is where a killed round's findings and its figure both come from, so each
 * telling carries both as of the same point of the run. The last the caller was
 * told is all a round stopped at its bound has.
 */
export type ProgressSoFar = (progress: RoundProgress) => void;

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
  readonly cost: Spend;
  readonly result: RunResult;
};

/**
 * What one round has to put in place before its CLI starts, or why it could not.
 *
 * `prepared` carries what to add to the reviewer's environment. Everything the
 * CLI reads from a file the adapter owns is already written by then.
 */
export type Confinement =
  | { readonly outcome: "prepared"; readonly environment: Readonly<Record<string, string>> }
  | { readonly outcome: "failed"; readonly reason: string };

/** The parts of driving one reviewer CLI. */
export type Adapter = {
  /** Build the command line for one round, from what the harness set for it. */
  readonly argv: (invocation: Invocation) => CommandLine;
  /**
   * Put in place whatever the CLI is handed outside its command line, and say
   * what to add to its environment.
   *
   * It is where a CLI that takes a setting rather than a flag is given one. The
   * round calls it once, before the first process starts, and reports a failure
   * as a setup problem: a confinement that is not in place is not a round to run
   * anyway.
   */
  readonly confine: (invocation: Invocation) => Confinement;
  /**
   * Read the report file as it grows: what the run cost, and the review it
   * returned.
   *
   * `reports` is the file's bytes as they are appended, ending once the process
   * is gone, and a chunk can end partway through a line. `soFar` is how a
   * caller that stops the process at its bound still has what the reviewer had
   * reached.
   *
   * Each report is passed on as the run makes it. An adapter for a CLI that
   * cannot report a finding before its run ends passes them all on at the end,
   * and rounds of that CLI keep nothing when they are killed.
   */
  readonly parse: (
    reports: AsyncIterable<string | Uint8Array>,
    soFar?: ProgressSoFar,
  ) => Promise<ParsedRun>;
  /**
   * Which tools the CLI is given at each depth, the calls the reviewer reports
   * through among them.
   *
   * It sits beside the command line rather than only inside it, so that what a
   * round was allowed to do is readable without parsing the arguments back.
   */
  readonly grants: Readonly<Record<Depth, readonly string[]>>;
  /**
   * The command that resumes the session the reviewer kept in
   * `sessionDirectory`, with that directory written as `spelled`. Undefined
   * where there is no session to resume, or none that could be read. An adapter
   * whose CLI keeps no session has no resume.
   */
  readonly resume?: (sessionDirectory: string, spelled: string) => readonly string[] | undefined;
  /**
   * The CLI reports a run's cost once, as it exits by itself, so a run the round
   * stopped has no cost. Absent where it reports each message's cost as the
   * message completes, so a stopped run has a floor: what completed, short of
   * the message in flight.
   */
  readonly costAtExit?: true;
};
