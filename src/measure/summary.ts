/**
 * What one measured review did: its cost, its time, its findings, and how much
 * of its looking went outside the diff.
 *
 * A look is a `read`, `grep`, `find` or `ls`. It is inside the diff only when it
 * is a `read` or a `grep` of a file the diff changes. A `grep` of the whole tree
 * or of a directory is outside it even where a changed file is among what it
 * searched, because it is the reviewer going looking rather than reading the
 * change.
 */

import { isAbsolute, normalize, relative } from "node:path";

import type { Finding } from "../findings/finding.ts";
import type { Round } from "../reviewers/round.ts";

/** One run as `review-once.ts` records it. */
export type Run = {
  readonly label: string;
  /** The detached worktree the reviewer ran in, which an absolute path is read against. */
  readonly tree: string;
  readonly seconds: number;
  readonly round: Pick<Round, "outcome" | "cost" | "findings">;
};

export type Summary = {
  readonly label: string;
  readonly outcome: Round["outcome"];
  readonly messages: number;
  readonly tokens: number;
  /** Whole seconds of wall clock. */
  readonly seconds: number;
  /** US dollars, to the cent. */
  readonly dollars: number;
  readonly toolCalls: number;
  readonly looks: number;
  /** Each look outside the diff, as its tool and its arguments. */
  readonly outside: readonly string[];
  /** Each finding as its severity, where it is anchored, and its headline. */
  readonly findings: readonly string[];
};

const LOOKING_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

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
  const outside = looks.filter((call) => !insideTheDiff(call, changed, run.tree));
  const { cost } = run.round;
  return {
    label: run.label,
    outcome: run.round.outcome,
    messages: cost.messages,
    tokens: cost.tokens,
    seconds: Math.round(run.seconds),
    dollars: Math.round(cost.dollars * 100) / 100,
    toolCalls: calls.length,
    looks: looks.length,
    outside: outside.map((call) => `${call.tool} ${JSON.stringify(call.args)}`),
    findings: run.round.findings.map(described),
  };
}

type ToolCall = { readonly tool: string; readonly args: Record<string, unknown> };

/**
 * Every tool call the stream records, in order.
 *
 * A line that is not an event is passed over: the stream is `pi`'s own output
 * copied as it arrived, and a run killed mid-line leaves half of one at the end.
 */
function toolCalls(stream: string): readonly ToolCall[] {
  const calls: ToolCall[] = [];
  for (const line of stream.split("\n")) {
    if (line.trim() === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event) || event["type"] !== "tool_execution_start") continue;
    const tool = event["toolName"];
    const args = event["args"];
    if (typeof tool !== "string") continue;
    calls.push({ tool, args: isRecord(args) ? args : {} });
  }
  return calls;
}

function insideTheDiff(call: ToolCall, changed: ReadonlySet<string>, tree: string): boolean {
  if (call.tool !== "read" && call.tool !== "grep") return false;
  const path = call.args["path"];
  if (typeof path !== "string") return false;
  const fromRoot = isAbsolute(path) ? relative(tree, path) : normalize(path);
  return changed.has(fromRoot);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
