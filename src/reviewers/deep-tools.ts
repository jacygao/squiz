/**
 * The three `deep` tools as any adapter serves them, and the one variable that
 * carries the round's own values to wherever they run.
 *
 * The tools run inside the reviewer's CLI, in a process the round did not start
 * and cannot hand arguments to. So the round puts the snapshot and the moment
 * the round ends into one variable on the reviewer's environment, and the tools
 * read them from there rather than from the directory they happen to run in.
 *
 * **A round that handed nothing over gets tools that run nothing.** A tool with
 * no snapshot would read whatever directory it runs in, so every tool answers
 * with its error instead.
 *
 * Nothing here throws. Every outcome is a value the reviewer reads.
 */

import { historyTools } from "./git-tools.ts";

/** The variable the round's own values reach the tools in. */
export const ROUND_VARIABLE = "SQUIZ_ROUND";

/** What the tools need of the round, which only the round can say. */
export type DeepRound = {
  /** The root of the round's snapshot of the head commit. */
  readonly snapshot: string;
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
export const deepToolNames: readonly string[] = Object.freeze(historyTools.map((tool) => tool.name));

/** The round's values as the variable to put on the reviewer's environment. */
export function roundVariable(round: DeepRound): Readonly<Record<string, string>> {
  return { [ROUND_VARIABLE]: JSON.stringify(round) };
}

/** The three tools, bound to the round named in `environment`. */
export function deepTools(environment: Readonly<Record<string, string | undefined>>): readonly DeepTool[] {
  const round = roundIn(environment[ROUND_VARIABLE]);
  return historyTools.map(
    (tool): DeepTool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      call: async (params, signal) =>
        typeof round === "string"
          ? { text: `${tool.name} could not run: ${round}`, failed: true }
          : tool.run(round.snapshot, params, signal),
    }),
  );
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
  const { snapshot, endsAt } = fields;
  if (typeof snapshot !== "string" || typeof endsAt !== "number" || !Number.isFinite(endsAt)) {
    return `${ROUND_VARIABLE} does not carry a snapshot and a deadline`;
  }
  return { snapshot, endsAt };
}
