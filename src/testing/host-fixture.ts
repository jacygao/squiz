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

import { defaultConfig, type Config } from "../config/config.ts";
import type { Finding } from "../findings/finding.ts";
import { runHost } from "../host/host.ts";
import type { Adapter, ParsedRun, ThreadVerdict } from "../reviewers/adapter.ts";
import { adapterFor } from "../reviewers/adapters.ts";
import { githubVenue } from "../venues/github/venue.ts";
import { localVenue } from "../venues/local/venue.ts";

/** What one reviewer start reports, and how long it runs before it does. */
export type PlannedStart = {
  readonly findings: readonly Finding[];
  readonly verdicts: readonly ThreadVerdict[];
  readonly holdSeconds?: number;
  /** What the reviewer says on stderr before it exits 1 having completed no message, in place of a review. */
  readonly fails?: string;
};

export type Plan = {
  readonly charterFile: string;
  readonly starts: readonly PlannedStart[];
  /**
   * The round cap and token bound, where a test sets them. Every host reads the
   * plan afresh, so a test can lower one between runs.
   */
  readonly config?: Partial<Pick<Config, "rounds" | "tokens" | "fixer">>;
  /** The venue every host reviews in. The GitHub venue where not given. */
  readonly venue?: "local";
};

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
      args: ["-c", `sleep ${current.holdSeconds ?? 0}${current.fails === undefined ? "" : '; printf "%s\\n" "$0" >&2; exit 1'}`, current.fails ?? ""],
      directory: invocation.directory,
      stdin: "/dev/null",
      environment: {},
    };
  },
  parse: async (stdout): Promise<ParsedRun> => {
    for await (const chunk of stdout) void chunk;
    if (current.fails !== undefined) {
      return { cost: { dollars: 0, tokens: 0, messages: 0 }, result: { kind: "incomplete", reason: "the reviewer completed no message" } };
    }
    return {
      cost: { dollars: 0.01, tokens: 1200, messages: 1 },
      result: { kind: "reviewed", findings: current.findings, verdicts: current.verdicts },
    };
  },
  grants: ["read"],
  // Copilot's own reading of what a reviewer that failed said, against a default model it could otherwise blame.
  diagnose: adapterFor("copilot").diagnose,
  userModel: () => "gpt-6-astra",
};

await runHost({
  worktree: process.cwd(),
  key: number,
  round: { venue: plan.venue === "local" ? localVenue : githubVenue, config: { ...defaultConfig, timeout: 60, ...plan.config }, adapter, charterFile: plan.charterFile },
});
