/**
 * The extension `pi` loads: the calls the reviewer reports each finding
 * through, the handler that refuses the calls which would change what the
 * coding agent commits, and the end of the review.
 *
 * Nothing in the harness imports this. `pi` loads it from the path on the
 * command line, compiles it and the modules it imports, and runs the default
 * export once with its own API. So the types here describe as much of that API
 * as the three calls and the handlers use, structurally: the package is
 * not a dependency of this one and nothing here may make it one.
 *
 * A report that is not one the harness could compose a comment or a mutation
 * from is refused, and the refusal reaches the reviewer as the call's error
 * while it is still there to correct it. The round's other reports stand: one
 * malformed finding is one refusal.
 *
 * Every accepted report, every refusal, every assistant message's usage and the
 * finish go to the report file as they happen. The reviewer is told a report
 * landed only once it is in the file, so a write that fails is answered as a
 * failure:
 *
 * - a report or the finish that cannot be recorded is refused, and the reviewer
 *   can make the call again;
 * - a refusal that cannot be recorded still refuses, and says it was not
 *   recorded;
 * - usage that cannot be recorded throws, and `pi` shows the throw as the
 *   extension's error and carries on. The line is kept and written ahead of
 *   the next line that can be written, so a finish never lands in a file still
 *   missing usage, which would read as a complete review that cost less than
 *   it did. The run's end is the last attempt. Usage that still cannot be
 *   written then is lost, and the file cannot say so: it is the file that
 *   refused the write. So a finish in the file does not prove the usage after
 *   it is complete.
 *
 * Interactive `pi` waits for input once its agent settles, so the extension
 * ends it: once the finish is recorded, or, where the agent settles with no
 * finish recorded, once it has recorded an unfinished end. An unfinished end
 * that cannot be recorded throws for `pi` to show and ends it all the same,
 * since a run with no finish is unfinished whether or not the file says so.
 * Print-mode `pi` exits on its own and ignores the request.
 *
 * Where no file is named, nothing is written and every call answers as it would
 * with one.
 */

import { readFinding, readVerdict } from "../../findings/reported.ts";
import { type Refusal, refuse, type ToolCall } from "./refusals.ts";
import {
  type Line,
  type ReportFile,
  reportFileAt,
  REPORTS_VARIABLE,
  type UsageLine,
} from "./report-file.ts";
import { FINISH_REVIEW, REPORT_FINDING, REPORT_VERDICT } from "./reporting.ts";

/** One block of what a call answers with. Only text is ever returned here. */
type TextContent = { readonly type: "text"; readonly text: string };

/**
 * What a call answers with.
 *
 * `content` is what the reviewer reads and `details` is what the harness reads:
 * `pi` sends the content to the model and keeps the details out of the request
 * entirely. So the report goes back whole in `details` without being paid for a
 * second time in the reviewer's own context.
 */
type ToolResult = {
  readonly content: readonly TextContent[];
  readonly details?: unknown;
};

/** One tool, as `pi` registers it. `parameters` is the JSON Schema it validates against. */
type ToolDefinition = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly parameters: unknown;
  readonly execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: Context,
  ) => Promise<ToolResult>;
};

/** As much of the context `pi` hands a call and a handler as the extension uses. */
export type Context = {
  /** End `pi`. While the agent runs, `pi` waits until it is idle, so the closing message is written first. */
  readonly shutdown: () => void;
};

/** A message `pi` finished, whoever it was from. Only an assistant's is recorded. */
export type MessageEnd = { readonly type: "message_end"; readonly message: unknown };

/** As much of `pi`'s extension API as the three calls and the handlers need. */
export type Registrar = {
  readonly registerTool: (tool: ToolDefinition) => void;
  /**
   * Subscribe to an event.
   *
   * `pi` passes every handler the context as a second argument. It takes a
   * handler that answers nothing as one that objects to nothing, and one that
   * answers nothing at the end of a message as one that leaves the message as
   * it was.
   */
  readonly on: {
    (event: "tool_call", handler: (call: ToolCall) => Refusal | undefined): void;
    (event: "message_end", handler: (event: MessageEnd) => void): void;
    (
      event: "agent_settled" | "session_shutdown",
      handler: (event: unknown, ctx: Context) => void,
    ): void;
  };
};

/**
 * As much of a headline as a confirmation quotes.
 *
 * Every custom tool must bound what it answers with, because the answer is
 * spent in the reviewer's context. A confirmation carries the headline so the
 * reviewer can see which report landed, and a headline has no length this can
 * rely on.
 */
const HEADLINE_LIMIT = 120;

const findingParameters = {
  type: "object",
  properties: {
    scope: {
      type: "string",
      enum: ["line", "file", "change"],
      description:
        "line where a single line owns the defect, file where no line does, change where no file does.",
    },
    file: {
      type: "string",
      description: "The file the finding is anchored to. On a line and a file finding only.",
    },
    line: {
      type: "integer",
      description: "The line the finding is anchored to, which the change must have touched. On a line finding only.",
    },
    severity: { type: "string", enum: ["high", "medium", "low"] },
    headline: { type: "string", description: "The problem, named in one line." },
    reasoning: {
      type: "array",
      items: { type: "string" },
      description: "The points beneath the headline, one point each. They are read as bullets.",
    },
    suggestedFix: { type: "string", description: "What to do about it." },
    reference: {
      type: "string",
      description:
        "Optional: a convention quoted, or something you could not check. Leave it out where there is none.",
    },
  },
  required: ["scope", "severity", "headline", "reasoning", "suggestedFix"],
};

const verdictParameters = {
  type: "object",
  properties: {
    thread: {
      type: "string",
      description: "The identifier the thread was handed to you under, copied exactly.",
    },
    verdict: {
      type: "string",
      enum: ["fixed", "withdrawn", "open"],
      description:
        "fixed where the defect is gone, withdrawn where there was none, open where it is still there.",
    },
  },
  required: ["thread", "verdict"],
};

const finishParameters = { type: "object", properties: {} };

/** The extension as `pi` loads it, reporting to the file the adapter named. */
export default function reportAsYouGo(pi: Registrar): void {
  reportInto(pi, process.env[REPORTS_VARIABLE]);
}

/**
 * Register the three calls and subscribe the handlers, recording into the
 * file at `reports`, or nowhere where it is not given.
 *
 * The threads already ruled on are held here, so that a second ruling on one
 * thread is refused while the reviewer can still decide which of the two it
 * meant. The usage the file refused is held until it can be written, and
 * whether the finish was recorded is held until the agent settles. Nothing
 * else is held: a report is answered and gone.
 */
export function reportInto(pi: Registrar, reports: string | undefined): void {
  const file = keepingLostUsage(reportFileAt(reports));
  const ruled = new Set<string>();
  let finished = false;

  // `pi` runs a tool the moment no handler objects, so a subscription that goes
  // missing takes the whole refusal with it and says nothing.
  pi.on("tool_call", (call) => {
    const refusal = refuse(call);
    if (refusal === undefined) return undefined;
    const unrecorded = failureOf(() =>
      file.record({ type: "refused", call: call.toolName, reason: refusal.reason, stopped: true }),
    );
    if (unrecorded === undefined) return refusal;
    return { block: true, reason: `${refusal.reason} ${unrecordedRefusal(unrecorded)}` };
  });

  pi.on("message_end", (event) => {
    const usage = usageOf(event.message);
    if (usage !== undefined) file.record(usage);
  });

  // The closing message arrives after the finish, so its usage has no later
  // line to be written ahead of. A throw here is shown like any other.
  pi.on("agent_settled", (_event, ctx) => {
    // `pi` settles after a finished review's closing message too.
    if (finished) return file.flush();
    try {
      file.record({ type: "unfinished" });
    } finally {
      ctx.shutdown();
    }
  });
  pi.on("session_shutdown", file.flush);

  pi.registerTool({
    name: REPORT_FINDING,
    label: "Report finding",
    description:
      "Report one finding, as soon as you have confirmed it. Call it once per finding. A finding you hold back until the end of the review is a finding that is lost if the review is cut short.",
    promptSnippet: "Report one confirmed finding",
    promptGuidelines: [
      `Use ${REPORT_FINDING} the moment a finding is confirmed, rather than collecting the findings for a final message.`,
    ],
    parameters: findingParameters,
    execute: async (_toolCallId, params) => {
      const finding = readFinding(params);
      if ("reason" in finding) {
        throw refusedReport(file, REPORT_FINDING, `the finding ${finding.reason}`);
      }
      recordReport(file, REPORT_FINDING, "the finding", finding.value);
      return {
        content: [{ type: "text", text: `Reported: ${excerptOf(finding.value.headline)}` }],
        details: finding.value,
      };
    },
  });

  pi.registerTool({
    name: REPORT_VERDICT,
    label: "Report verdict",
    description:
      "Rule on one thread you were handed. Call it once per thread, naming the thread by the identifier it was handed to you under.",
    promptSnippet: "Rule on one thread you were handed",
    promptGuidelines: [
      `Use ${REPORT_VERDICT} once for every thread handed over.`,
    ],
    parameters: verdictParameters,
    execute: async (_toolCallId, params) => {
      const verdict = readVerdict(params);
      if ("reason" in verdict) {
        throw refusedReport(file, REPORT_VERDICT, `the verdict ${verdict.reason}`);
      }
      const { thread } = verdict.value;
      if (ruled.has(thread)) {
        throw refusedReport(
          file,
          REPORT_VERDICT,
          `thread ${thread} was already ruled on, and one ruling stands per thread`,
        );
      }
      recordReport(file, REPORT_VERDICT, "the verdict", verdict.value);
      // Only once it is recorded, so that a ruling the file refused can be made again.
      ruled.add(thread);
      return {
        content: [{ type: "text", text: `Ruled ${verdict.value.verdict} on ${thread}` }],
        details: verdict.value,
      };
    },
  });

  pi.registerTool({
    name: FINISH_REVIEW,
    label: "Finish review",
    description:
      "End the review. Call it exactly once, after the last finding and the last verdict, and call it even where you found nothing. The review is over once you have called it, so report everything you have before it. A review that ends without it is a review that was cut short.",
    promptSnippet: "End the review",
    promptGuidelines: [
      `Use ${FINISH_REVIEW} as the last action of the review, including where there was nothing to report.`,
    ],
    parameters: finishParameters,
    execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
      const unrecorded = failureOf(() => file.record({ type: "finish" }));
      if (unrecorded !== undefined) {
        throw new Error(
          `the finish could not be recorded, so the review is not finished (${unrecorded}). Call ${FINISH_REVIEW} again.`,
        );
      }
      finished = true;
      ctx?.shutdown();
      return { content: [{ type: "text", text: "The review is complete." }], details: {} };
    },
  });
}

/**
 * The file, writing the usage it refused ahead of every later line.
 *
 * A later line is not written until the usage before it is, so every line
 * after a lost one fails with it, the finish included.
 */
function keepingLostUsage(file: ReportFile): ReportFile & { readonly flush: () => void } {
  const lost: Line[] = [];
  const flush = (): void => {
    while (lost[0] !== undefined) {
      file.record(lost[0]);
      lost.shift();
    }
  };
  return {
    record: (line) => {
      try {
        flush();
        file.record(line);
      } catch (cause) {
        if (line.type === "usage") lost.push(line);
        throw cause;
      }
    },
    flush,
  };
}

/** Record an accepted report, or throw the refusal the reviewer reads where it cannot be. */
function recordReport(file: ReportFile, call: string, named: string, value: unknown): void {
  const unrecorded = failureOf(() => file.record({ type: "report", call, value }));
  if (unrecorded === undefined) return;
  throw new Error(
    `${named} could not be recorded, so it was not reported (${unrecorded}). Report it again.`,
  );
}

/** The error a refused report is answered with, recorded before it is thrown. */
function refusedReport(file: ReportFile, call: string, reason: string): Error {
  const unrecorded = failureOf(() =>
    file.record({ type: "refused", call, reason, stopped: false }),
  );
  if (unrecorded === undefined) return new Error(reason);
  return new Error(`${reason}. ${unrecordedRefusal(unrecorded)}`);
}

function unrecordedRefusal(failure: string): string {
  return `The refusal could not be recorded (${failure}).`;
}

/** What went wrong running `act`, or `undefined` where nothing did. */
function failureOf(act: () => void): string | undefined {
  try {
    act();
    return undefined;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/**
 * The line an assistant message is recorded as, or `undefined` for anyone
 * else's message.
 *
 * Read structurally, because `pi`'s own message type is not something this
 * package may import. A field of a type this does not expect is left out
 * rather than guessed at.
 */
function usageOf(message: unknown): UsageLine | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const fields = message as Readonly<Record<string, unknown>>;
  if (fields["role"] !== "assistant") return undefined;
  const { stopReason, errorMessage, model, usage } = fields;
  return {
    type: "usage",
    ...(typeof stopReason === "string" ? { stopReason } : {}),
    ...(typeof errorMessage === "string" ? { errorMessage } : {}),
    ...(typeof model === "string" ? { model } : {}),
    ...(typeof usage === "object" && usage !== null ? { usage } : {}),
  };
}

/** As much of a headline as a confirmation carries. */
function excerptOf(headline: string): string {
  if (headline.length <= HEADLINE_LIMIT) return headline;
  return `${headline.slice(0, HEADLINE_LIMIT - 3)}...`;
}
