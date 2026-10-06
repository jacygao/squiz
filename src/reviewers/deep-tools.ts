/**
 * The four `deep` tools as any adapter serves them, and the one variable that
 * carries the round's own values to wherever they run.
 *
 * The tools run inside the reviewer's CLI, in a process the round did not start
 * and cannot hand arguments to. So the round puts the snapshot, the test
 * command, the scratch space and the moment the round ends into one variable on
 * the reviewer's environment, and the tools read them from there rather than
 * from the directory or the clock of wherever they happen to run.
 *
 * **A round that handed nothing over gets tools that run nothing.** A
 * `run_tests` with no deadline would run unbounded, so every tool answers with
 * its error instead.
 *
 * Nothing here throws. Every outcome is a value the reviewer reads.
 */

import { deadlineAt } from "./deadline.ts";
import { historyTools } from "./git-tools.ts";
import { describeTestsRun, runTestsTool } from "./run-tests.ts";

/** The variable the round's own values reach the tools in. */
export const ROUND_VARIABLE = "SQUIZ_ROUND";

/** What the tools need of the round, which only the round can say. */
export type DeepRound = {
  /** The root of the round's snapshot of the head commit. */
  readonly snapshot: string;
  /** The round's scratch space, which `TMPDIR` names for the test command. */
  readonly scratch: string;
  /** The configured test command, or `null` where none is configured. */
  readonly test: string | null;
  /** The moment the round ends, in milliseconds since the epoch. */
  readonly endsAt: number;
};

/** What a call answers with. `failed` marks `text` as the call's error rather than its result. */
export type DeepResult = { readonly text: string; readonly failed: boolean };

/** One tool, as an adapter registers it. `parameters` is the JSON Schema it is served under. */
export type DeepTool = {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly call: (params: unknown, signal?: AbortSignal) => Promise<DeepResult>;
};

/** The names the `deep` grant adds, in the order the tools are served. */
export const deepToolNames: readonly string[] = Object.freeze([
  runTestsTool.name,
  ...historyTools.map((tool) => tool.name),
]);

/** The round's values as the variable to put on the reviewer's environment. */
export function roundVariable(round: DeepRound): Readonly<Record<string, string>> {
  return { [ROUND_VARIABLE]: JSON.stringify(round) };
}

/**
 * The four tools, bound to the round named in `environment`.
 *
 * `environment` is the reviewer's own, and the test command runs with it. It
 * carries no GitHub credential, because the round set those empty before the
 * reviewer started.
 */
export function deepTools(environment: Readonly<Record<string, string | undefined>>): readonly DeepTool[] {
  const round = roundIn(environment[ROUND_VARIABLE]);
  const unhanded = (name: string): DeepResult => ({
    text: `${name} could not run: ${round as string}`,
    failed: true,
  });

  const runTests: DeepTool = {
    name: runTestsTool.name,
    description: runTestsTool.description,
    parameters: runTestsTool.parameters,
    call: async () => {
      if (typeof round === "string") return unhanded(runTestsTool.name);
      const run = await runTestsTool.run({
        snapshot: round.snapshot,
        command: round.test,
        scratch: round.scratch,
        deadline: deadlineAt(round.endsAt),
        environment: definedIn(environment),
      });
      const { text, isError } = describeTestsRun(run);
      return { text, failed: isError };
    },
  };

  const history = historyTools.map(
    (tool): DeepTool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      call: async (params, signal) =>
        typeof round === "string" ? unhanded(tool.name) : tool.run(round.snapshot, params, signal),
    }),
  );

  return [runTests, ...history];
}

/** The round the variable names, or why there is none to read. */
function roundIn(value: string | undefined): DeepRound | string {
  if (value === undefined || value === "") return `the round set no ${ROUND_VARIABLE}, so it has no snapshot or deadline to run in`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return `${ROUND_VARIABLE} is not JSON, so the round's snapshot and deadline cannot be read`;
  }
  const fields = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const { snapshot, scratch, test, endsAt } = fields;
  if (
    typeof snapshot !== "string" ||
    typeof scratch !== "string" ||
    (typeof test !== "string" && test !== null) ||
    typeof endsAt !== "number" ||
    !Number.isFinite(endsAt)
  ) {
    return `${ROUND_VARIABLE} does not carry a snapshot, a scratch space, a test command and a deadline`;
  }
  return { snapshot, scratch, test, endsAt };
}

function definedIn(environment: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const defined: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined) defined[name] = value;
  }
  return defined;
}
