/**
 * The reviewer's calls that would change what the coding agent commits, refused
 * inside `pi` before the command runs.
 *
 * `pi` offers every tool call to a handler before it executes it, and executes
 * nothing the handler blocks. So a refused call never reaches a shell, and the
 * reviewer reads the refusal as that call's own error while it is still there to
 * choose something else. A handler that throws refuses the call too: the throw
 * comes back as the call's error result, and the run carries on.
 *
 * Two kinds are refused. The tools a review has no use for go by name, which
 * needs no reading of what they were given. The commands go by what they would
 * do: the ones that move `HEAD` while leaving the worktree byte for byte as it
 * was, which is the change nothing downstream can see.
 *
 * **A command is matched as text, and matching is not a boundary.** It refuses a
 * reviewer that is not trying to get around the list. Quoting, a script file, an
 * encoded string and `sh -c` each defeat it, and a reviewer that means to commit
 * still can. What keeps that gap small is that the tools needing no matching go
 * by name, and that the list only has to cover the commands which move `HEAD`
 * without touching the tree.
 *
 * `pi` is not a dependency of this package and nothing here may make it one, so
 * the call and the answer are described structurally, as the extension's own
 * types are.
 */

/** One tool call, as `pi` offers it to a handler before running it. */
export type ToolCall = {
  readonly toolName: string;
  /** Whatever the tool takes. `bash` takes a `command`, and nothing else is read. */
  readonly input: unknown;
};

/** What stops the call. The reason is what the reviewer reads in its place. */
export type Refusal = {
  readonly block: true;
  readonly reason: string;
};

/**
 * The tools refused by name.
 *
 * A review reports through the calls and writes nothing, so a round that grants
 * either of these grants a write primitive for nothing. The grant withholds them
 * as well; this is what holds if a grant ever stops being passed.
 */
export const refusedTools: readonly string[] = Object.freeze(["edit", "write"]);

/**
 * The commands refused in `bash`: the ones that change the commit and leave the
 * worktree as it was.
 *
 * Matched as text, which the module comment says is not a boundary. `git commit`
 * already covers the amend, and the amend is listed anyway so that removing
 * either one still leaves the other refused.
 */
export const refusedCommands: readonly string[] = Object.freeze([
  "git commit",
  "git commit --amend",
  "git reset --soft",
  "git checkout -B",
  "git update-ref",
  "git push",
]);

/**
 * What every refusal opens with.
 *
 * It is the only thing that tells a call refused here from a tool that failed on
 * its own, and the round counts its refusals by it.
 */
const REFUSED = "squiz refused this call: ";

/** The tool whose command is read. Every other tool is refused or passed by name. */
const SHELL = "bash";

/**
 * Refuse the call, or let it through.
 *
 * `undefined` is a call nothing here objects to, which is what `pi` needs to run
 * it. Never throws; a throw would refuse the call as well, but it would refuse a
 * call this was going to allow.
 */
export function refuse(call: ToolCall): Refusal | undefined {
  if (refusedTools.includes(call.toolName)) {
    return refusal(
      `a review has no use for \`${call.toolName}\`, and it changes the code you are reviewing. Report what is wrong with the change instead.`,
    );
  }
  if (call.toolName !== SHELL) return undefined;

  const command = commandOf(call.input);
  // A shell call whose command cannot be read is refused rather than run. The
  // field is `pi`'s, and one it renames would otherwise leave every command
  // matching nothing and the list quietly doing nothing at all.
  if (command === null) {
    return refusal(
      `the command could not be read out of this \`${SHELL}\` call, so nothing here could check it.`,
    );
  }

  const matched = refusedCommands.find((refused) => spacedOut(command).includes(refused));
  if (matched === undefined) return undefined;
  return refusal(
    `\`${matched}\` changes what the coding agent commits. Report what is wrong with the change instead of changing it.`,
  );
}

/**
 * Whether the call this result answers was refused here.
 *
 * `pi` answers a blocked call with the reason as the result's only text, so the
 * opening of that text is what a reader of the stream has to go on.
 */
export function wasRefused(result: unknown): boolean {
  const content = fieldOf(result, "content");
  if (!Array.isArray(content)) return false;
  const blocks: readonly unknown[] = content;
  return blocks.some((block) => {
    const text = fieldOf(block, "text");
    return typeof text === "string" && text.startsWith(REFUSED);
  });
}

/** One refusal, opened with the marker the round counts by. */
function refusal(said: string): Refusal {
  return { block: true, reason: `${REFUSED}${said}` };
}

/**
 * The command the shell call was given, or `null` where there is none to read.
 *
 * Read structurally, because `pi`'s own type for it is not something this
 * package may import.
 */
function commandOf(input: unknown): string | null {
  const command = fieldOf(input, "command");
  return typeof command === "string" ? command : null;
}

/**
 * The command with every run of whitespace as one space.
 *
 * `git   commit` and a command split across two lines are the same command, and
 * a match against the text as it arrived would miss both.
 */
function spacedOut(command: string): string {
  return command.replace(/\s+/gu, " ");
}

/** One field of a value that may not be an object at all. */
function fieldOf(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Readonly<Record<string, unknown>>)[field];
}
