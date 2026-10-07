/**
 * What one measured review did: its cost, its time, its findings, how much of
 * its looking went outside the diff, and each `deep` tool it called with what
 * that tool answered.
 *
 * The stream is either reviewer's own JSON output: `pi`'s `--mode json` events
 * or Copilot's `--output-format json` events. Copilot names a tool its reporting
 * server serves with the server's prefix, which is dropped so that both read
 * alike.
 *
 * A look is a read, a grep, a find, a listing or a glob. It is inside the diff
 * only when it reads or greps a file the diff changes. A grep of the whole tree
 * or of a directory is outside it even where a changed file is among what it
 * searched, because it is the reviewer going looking rather than reading the
 * change.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, normalize, relative } from "node:path";

import type { Finding } from "../findings/finding.ts";
import { deepToolNames } from "../reviewers/deep-tools.ts";
import type { Round } from "../reviewers/round.ts";

/** One run as `review-once.ts` records it. */
export type Run = {
  readonly label: string;
  /** The snapshot the reviewer ran in, which an absolute path is read against. */
  readonly tree: string;
  readonly seconds: number;
  readonly round: Pick<Round, "outcome" | "cost" | "findings">;
};

/** A `deep` tool's call, and the end of what it answered. */
export type DeepCall = {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /** `undefined` where the run ended before the call answered. */
  readonly failed: boolean | undefined;
  /** The last `ANSWER_KEPT` characters of the answer, where there was one. */
  readonly answered: string | undefined;
};

export type Summary = {
  readonly label: string;
  readonly outcome: Round["outcome"];
  readonly messages: number;
  readonly tokens: number;
  /** Whole seconds of wall clock. */
  readonly seconds: number;
  /** US dollars, to the cent. Copilot prices a run in credits and reports none. */
  readonly dollars: number;
  /** Copilot's AI credits, where the run reported them. */
  readonly credits: number | undefined;
  readonly toolCalls: number;
  readonly looks: number;
  /** Each look outside the diff, as its tool and its arguments. */
  readonly outside: readonly string[];
  readonly deepCalls: readonly DeepCall[];
  /** Each finding as its severity, where it is anchored, and its headline. */
  readonly findings: readonly string[];
};

// A failing suite says what failed at the end of its output, so the end is kept.
const ANSWER_KEPT = 2_000;

const LOOKING_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls", "view", "glob"]);
const READING_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "view"]);
const DEEP_TOOLS: ReadonlySet<string> = new Set(deepToolNames);
const COPILOT_SERVER_PREFIX = "squiz-";

/** The files a unified diff changes, each under the name it has after the change. */
export function changedFiles(diff: string): readonly string[] {
  const files: string[] = [];
  for (const line of diff.split("\n")) {
    // The header names both sides, and a path may hold spaces, so the new name
    // is read from the last " b/" rather than split on whitespace.
    if (!line.startsWith("diff --git a/")) continue;
    const at = line.lastIndexOf(" b/");
    if (at !== -1) files.push(line.slice(at + 3));
  }
  return files;
}

export function summarise(run: Run, stream: string, diff: string): Summary {
  const calls = toolCalls(stream);
  const changed = new Set(changedFiles(diff));
  const looks = calls.filter((call) => LOOKING_TOOLS.has(call.tool));
  const roots = [run.tree, resolvedOr(run.tree)];
  const outside = looks.filter((call) => !insideTheDiff(call, changed, roots));
  const { cost } = run.round;
  return {
    label: run.label,
    outcome: run.round.outcome,
    messages: cost?.messages ?? 0,
    tokens: cost?.tokens ?? 0,
    seconds: Math.round(run.seconds),
    dollars: Math.round((cost?.dollars ?? 0) * 100) / 100,
    credits: cost?.credits,
    toolCalls: calls.length,
    looks: looks.length,
    outside: outside.map((call) => `${call.tool} ${JSON.stringify(call.args)}`),
    deepCalls: calls
      .filter((call) => DEEP_TOOLS.has(call.tool))
      .map((call) => ({
        tool: call.tool,
        args: call.args,
        failed: call.failed,
        answered: call.answered === undefined ? undefined : call.answered.slice(-ANSWER_KEPT),
      })),
    findings: run.round.findings.map(described),
  };
}

type ToolCall = {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  failed: boolean | undefined;
  answered: string | undefined;
};

/**
 * Every tool call the stream records, in order, each with its answer where one
 * came.
 *
 * A line that is not an event is passed over: the stream is the reviewer's own
 * output copied as it arrived, and a run killed mid-line leaves half of one at
 * the end.
 */
function toolCalls(stream: string): readonly ToolCall[] {
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  for (const line of stream.split("\n")) {
    const event = eventOf(line);
    if (event === undefined) continue;
    const type = event["type"];
    if (type === "tool_execution_start" || type === "tool.execution_start") {
      const fields = type === "tool_execution_start" ? event : recordOr(event["data"]);
      const tool = fields["toolName"];
      if (typeof tool !== "string") continue;
      const call: ToolCall = {
        tool: tool.startsWith(COPILOT_SERVER_PREFIX) ? tool.slice(COPILOT_SERVER_PREFIX.length) : tool,
        args: recordOr(fields[type === "tool_execution_start" ? "args" : "arguments"]),
        failed: undefined,
        answered: undefined,
      };
      calls.push(call);
      const id = fields["toolCallId"];
      if (typeof id === "string") byId.set(id, call);
    } else if (type === "tool_execution_end") {
      const call = byId.get(String(event["toolCallId"]));
      if (call === undefined) continue;
      call.failed = event["isError"] === true;
      call.answered = piText(event["result"]);
    } else if (type === "tool.execution_complete") {
      const data = recordOr(event["data"]);
      const call = byId.get(String(data["toolCallId"]));
      if (call === undefined) continue;
      call.failed = data["success"] !== true;
      // A failed call answers with its error's message, and carries no result.
      const content = recordOr(data["result"])["content"];
      const message = recordOr(data["error"])["message"];
      call.answered =
        typeof content === "string" ? content : typeof message === "string" ? message : JSON.stringify(content ?? null);
    }
  }
  return calls;
}

function eventOf(line: string): Record<string, unknown> | undefined {
  if (line.trim() === "") return undefined;
  try {
    const event: unknown = JSON.parse(line);
    return isRecord(event) ? event : undefined;
  } catch {
    return undefined;
  }
}

/** The text blocks of a `pi` tool result, joined. */
function piText(result: unknown): string {
  const content = recordOr(result)["content"];
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) => {
      const text = recordOr(block)["text"];
      return typeof text === "string" ? text : "";
    })
    .join("");
}

/** `roots` is the snapshot as the round named it and with its links resolved, which is how a reviewer may report it. */
function insideTheDiff(call: ToolCall, changed: ReadonlySet<string>, roots: readonly string[]): boolean {
  if (!READING_TOOLS.has(call.tool)) return false;
  const path = call.args["path"];
  if (typeof path !== "string") return false;
  if (!isAbsolute(path)) return changed.has(normalize(path));
  return roots.some((root) => changed.has(relative(root, path)));
}

function resolvedOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function described(finding: Finding): string {
  const where =
    finding.scope === "line"
      ? `${finding.file}:${finding.line}`
      : finding.scope === "file"
        ? finding.file
        : "(change)";
  return `${finding.severity} ${where} ${finding.headline}`;
}

function recordOr(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
