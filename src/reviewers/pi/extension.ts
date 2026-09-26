/**
 * The extension `pi` loads, which gives the reviewer a call to report each
 * finding through as it confirms it.
 *
 * Nothing in the harness imports this. `pi` loads it from the path on the
 * command line, compiles it and the modules it imports, and runs the default
 * export once with its own API. So the types here describe as much of that API
 * as the three calls use, structurally: the package is not a dependency of this
 * one and nothing here may make it one.
 *
 * A report that is not one the harness could compose a comment or a mutation
 * from is refused, and the refusal reaches the reviewer as the call's error
 * while it is still there to correct it. The round's other reports stand: one
 * malformed finding is one refusal.
 */

import { readFinding, readVerdict } from "../../findings/reported.ts";
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
  readonly execute: (toolCallId: string, params: unknown) => Promise<ToolResult>;
};

/** As much of `pi`'s extension API as registering these three calls needs. */
export type Registrar = {
  readonly registerTool: (tool: ToolDefinition) => void;
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

/**
 * Register the three calls.
 *
 * The threads already ruled on are held here, so that a second ruling on one
 * thread is refused while the reviewer can still decide which of the two it
 * meant. Nothing else is held: a report is answered and gone, and what the
 * round keeps it keeps from the stream.
 */
export default function reportAsYouGo(pi: Registrar): void {
  const ruled = new Set<string>();

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
      if ("reason" in finding) throw new Error(`the finding ${finding.reason}`);
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
      `Use ${REPORT_VERDICT} once for every thread handed over, from round 2 on.`,
    ],
    parameters: verdictParameters,
    execute: async (_toolCallId, params) => {
      const verdict = readVerdict(params);
      if ("reason" in verdict) throw new Error(`the verdict ${verdict.reason}`);
      const { thread } = verdict.value;
      if (ruled.has(thread)) {
        throw new Error(`thread ${thread} was already ruled on, and one ruling stands per thread`);
      }
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
    execute: async () => ({
      content: [{ type: "text", text: "The review is complete." }],
      details: {},
    }),
  });
}

/** As much of a headline as a confirmation carries. */
function excerptOf(headline: string): string {
  if (headline.length <= HEADLINE_LIMIT) return headline;
  return `${headline.slice(0, HEADLINE_LIMIT - 3)}...`;
}
