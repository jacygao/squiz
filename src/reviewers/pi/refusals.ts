/**
 * The reviewer's tools that write, refused inside `pi` by name before they run.
 *
 * `pi` offers every tool call to a handler before it executes it, and executes
 * nothing the handler blocks. The reviewer reads the refusal as that call's own
 * error while it is still there to choose something else. A handler that throws
 * refuses the call too: the throw comes back as the call's error result, and the
 * run carries on.
 *
 * The grant already withholds every tool refused here, so while it is passed no
 * refusal fires. This is what holds if a grant ever stops being passed.
 *
 * `pi` is not a dependency of this package and nothing here may make it one, so
 * the call and the answer are described structurally, as the extension's own
 * types are.
 */

/** One tool call, as `pi` offers it to a handler before running it. */
export type ToolCall = {
  readonly toolName: string;
  /** Whatever the tool takes. */
  readonly input: unknown;
};

/** What stops the call. The reason is what the reviewer reads in its place. */
export type Refusal = {
  readonly block: true;
  readonly reason: string;
};

/** A review reports through the calls and writes nothing, so it has no use for these. */
export const refusedTools: readonly string[] = Object.freeze(["edit", "write"]);

/**
 * What every refusal opens with, so the reviewer can tell a call refused here
 * from a tool that failed on its own.
 */
const REFUSED = "squiz refused this call: ";

/**
 * Refuse the call, or let it through.
 *
 * `undefined` is a call nothing here objects to, which is what `pi` needs to run
 * it. Never throws; a throw would refuse the call as well, but it would refuse a
 * call this was going to allow.
 */
export function refuse(call: ToolCall): Refusal | undefined {
  if (!refusedTools.includes(call.toolName)) return undefined;
  return refusal(
    `a review has no use for \`${call.toolName}\`, and it changes the code you are reviewing. Report what is wrong with the change instead.`,
  );
}

/** One refusal, opened with the marker. */
export function refusal(said: string): Refusal {
  return { block: true, reason: `${REFUSED}${said}` };
}
