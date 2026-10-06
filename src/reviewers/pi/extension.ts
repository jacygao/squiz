/**
 * The extension `pi` loads: the calls the reviewer reports each finding
 * through and the `deep` tools, registered through `pi`'s API, the handler that
 * refuses the calls which would change what the coding agent commits or read
 * outside the snapshot, and the end of the review.
 *
 * Nothing in the harness imports this. `pi` loads it from the path on the
 * command line, compiles it and the modules it imports, and runs the default
 * export once with its own API. So the types here describe as much of that API
 * as the tools and the handlers use, structurally: the package is
 * not a dependency of this one and nothing here may make it one.
 *
 * Every accepted report, every refusal, every assistant message's usage and the
 * finish go to the report file as they happen. Usage that cannot be recorded
 * throws, and `pi` shows the throw as the extension's error and carries on. The
 * run's end is the last attempt to write it.
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

import { deepTools } from "../deep-tools.ts";
import { reportCalls } from "../report-calls.ts";
import { reportFileAt, REPORTS_VARIABLE, type UsageLine } from "../report-file.ts";
import { FINISH_REVIEW, REPORT_FINDING, REPORT_VERDICT } from "../reporting.ts";
import { refuseRead } from "./reads.ts";
import { type Refusal, refuse, type ToolCall } from "./refusals.ts";

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

/** How `pi` shows each call: in its own listing, and in the system prompt. */
const shownInPi: Readonly<
  Record<string, Pick<ToolDefinition, "label" | "promptSnippet" | "promptGuidelines">>
> = {
  [REPORT_FINDING]: {
    label: "Report finding",
    promptSnippet: "Report one confirmed finding",
    promptGuidelines: [
      `Use ${REPORT_FINDING} the moment a finding is confirmed, rather than collecting the findings for a final message.`,
    ],
  },
  [REPORT_VERDICT]: {
    label: "Report verdict",
    promptSnippet: "Rule on one thread you were handed",
    promptGuidelines: [`Use ${REPORT_VERDICT} once for every thread handed over.`],
  },
  [FINISH_REVIEW]: {
    label: "Finish review",
    promptSnippet: "End the review",
    promptGuidelines: [
      `Use ${FINISH_REVIEW} as the last action of the review, including where there was nothing to report.`,
    ],
  },
};

/** How `pi` lists each `deep` tool. */
const deepLabels: Readonly<Record<string, string>> = {
  run_tests: "Run tests",
  git_log_search: "Search history",
  git_blame: "Blame line",
  git_show: "Show commit",
};

/**
 * The extension as `pi` loads it, reporting to the file the adapter named and
 * serving the `deep` tools in the round the round named.
 *
 * Both are registered at every depth. `--tools` drops whatever the depth does
 * not grant.
 */
export default function reportAsYouGo(pi: Registrar): void {
  reportInto(pi, process.env[REPORTS_VARIABLE], process.cwd());
  serveDeepTools(pi, process.env);
}

/**
 * Register the `deep` tools, run with `environment` as the reviewer's own.
 *
 * `pi`'s process environment is the reviewer's: the round's variables over its
 * host's, with no GitHub credential. `pi` adds only markers of its own to it.
 */
export function serveDeepTools(pi: Registrar, environment: Readonly<Record<string, string | undefined>>): void {
  for (const tool of deepTools(environment)) {
    const label = deepLabels[tool.name];
    if (label === undefined) throw new Error(`${tool.name} has no label to show in pi`);
    pi.registerTool({
      name: tool.name,
      label,
      description: tool.description,
      parameters: tool.parameters,
      execute: async (_toolCallId, params, signal) => {
        const { text, failed } = await tool.call(params, signal);
        // `pi` reads a call's answer as an error only where `execute` throws.
        if (failed) throw new Error(text);
        return { content: [{ type: "text", text }] };
      },
    });
  }
}

/**
 * Register the three calls and subscribe the handlers, recording into the
 * file at `reports`, or nowhere where it is not given, and refusing a read
 * outside `snapshot`, which is where `pi` runs.
 */
export function reportInto(pi: Registrar, reports: string | undefined, snapshot: string): void {
  const reporting = reportCalls(reportFileAt(reports));

  // `pi` runs a tool the moment no handler objects, so a subscription that goes
  // missing takes the whole refusal with it and says nothing.
  pi.on("tool_call", (call) => {
    const refusal = refuse(call) ?? refuseRead(call, snapshot);
    if (refusal === undefined) return undefined;
    return { ...refusal, reason: reporting.stopped(call.toolName, refusal.reason) };
  });

  pi.on("message_end", (event) => {
    const usage = usageOf(event.message);
    if (usage !== undefined) reporting.record(usage);
  });

  // The closing message arrives after the finish, so its usage has no later
  // line to be written ahead of. A throw here is shown like any other.
  pi.on("agent_settled", (_event, ctx) => {
    // `pi` settles after a finished review's closing message too.
    if (reporting.finished()) return reporting.flush();
    try {
      reporting.record({ type: "unfinished" });
    } finally {
      ctx.shutdown();
    }
  });
  pi.on("session_shutdown", reporting.flush);

  for (const call of reporting.calls) {
    const shown = shownInPi[call.name];
    if (shown === undefined) throw new Error(`${call.name} has no label to show in pi`);
    pi.registerTool({
      name: call.name,
      ...shown,
      description: call.description,
      parameters: call.parameters,
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const { text, details } = call.answer(params);
        if (call.name === FINISH_REVIEW) ctx?.shutdown();
        return { content: [{ type: "text", text }], details };
      },
    });
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
