/**
 * Every tool call outside the review's grant, refused inside `pi` by name
 * before it runs.
 *
 * `pi` offers every tool call to a handler before it executes it, and executes
 * nothing the handler blocks. The reviewer reads the refusal as that call's own
 * error while it is still there to choose something else. A handler that throws
 * refuses the call too: the throw comes back as the call's error result, and the
 * run carries on.
 *
 * While `--tools` carries the grant, `pi` offers the model nothing else and no
 * refusal fires. This is what holds if the grant ever stops being passed, when
 * `pi` falls back to its own default tools, a shell and two writers among them.
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

/**
 * The variable the adapter hands the grant to the extension in, as the names
 * `--tools` carries, joined the same way.
 */
export const GRANT_VARIABLE = "SQUIZ_GRANT";

/**
 * The grant as the variable carries it.
 *
 * A variable that is unset or empty is no grant at all, so every call is
 * refused: a command line that lost it is as wrong as one that lost `--tools`.
 */
export function grantIn(value: string | undefined): readonly string[] {
  return value === undefined || value === "" ? [] : Object.freeze(value.split(","));
}

/**
 * What every refusal opens with, so the reviewer can tell a call refused here
 * from a tool that failed on its own.
 */
const REFUSED = "squiz refused this call: ";

/**
 * Refuse a call to any tool `grant` does not name, or let it through.
 *
 * `undefined` is a call nothing here objects to, which is what `pi` needs to run
 * it. Only the name is read, never what the call was given. Never throws; a
 * throw would refuse the call as well, but it would refuse a call this was going
 * to allow.
 */
export function refuse(call: ToolCall, grant: readonly string[]): Refusal | undefined {
  if (grant.includes(call.toolName)) return undefined;
  return refusal(`\`${call.toolName}\` is not a tool this review grants.`);
}

/** One refusal, opened with the marker. */
export function refusal(said: string): Refusal {
  return { block: true, reason: `${REFUSED}${said}` };
}
