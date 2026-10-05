/**
 * A round host for the `squiz review` tests, run as a process of its own in the
 * worktree it serves: the real host and the real round, with a reviewer that
 * reports what a plan file says.
 *
 * Its arguments are the pull request's number and the plan file. The plan names
 * the charter, and what each reviewer start reports, in order, across every
 * host the test starts. A count beside the plan says how many have started.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { defaultConfig } from "../config/config.ts";
import type { Finding } from "../findings/finding.ts";
import { runHost } from "../host/host.ts";
import type { Adapter, ParsedRun, ThreadVerdict } from "../reviewers/adapter.ts";

/** What one reviewer start reports, and how long it runs before it does. */
export type PlannedStart = {
  readonly findings: readonly Finding[];
  readonly verdicts: readonly ThreadVerdict[];
  readonly holdSeconds?: number;
};

export type Plan = { readonly charterFile: string; readonly starts: readonly PlannedStart[] };

const [number = "", planFile = ""] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planFile, "utf8")) as Plan;
const countFile = `${planFile}.started`;

let current: PlannedStart = { findings: [], verdicts: [] };
const adapter: Adapter = {
  confine: () => ({ outcome: "prepared", environment: {} }),
  argv: (invocation) => {
    const started = existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) : 0;
    writeFileSync(countFile, String(started + 1), "utf8");
    current = plan.starts[started] ?? { findings: [], verdicts: [] };
    return {
      command: "/bin/sh",
      args: ["-c", `sleep ${current.holdSeconds ?? 0}`],
      directory: invocation.directory,
      stdin: "/dev/null",
      environment: {},
    };
  },
  parse: async (stdout): Promise<ParsedRun> => {
    for await (const chunk of stdout) void chunk;
    return {
      cost: { dollars: 0.01, tokens: 1200, messages: 1 },
      result: { kind: "reviewed", findings: current.findings, verdicts: current.verdicts },
    };
  },
  grants: { read: ["read"], deep: ["read", "bash"] },
};

await runHost({
  worktree: process.cwd(),
  pullRequest: Number(number),
  round: { config: { ...defaultConfig, timeout: 60 }, adapter, charterFile: plan.charterFile },
});
