/**
 * The script the rig puts ahead of the reviewer's CLI on `PATH`.
 *
 * It adds the flags that make the CLI write its JSON events, copies those events
 * to a file, and records the CLI's arguments, which show the grant.
 */

export type Shim = {
  /** The real CLI, by absolute path. */
  readonly real: string;
  /** Put before the arguments the adapter gives. */
  readonly flags: readonly string[];
  /**
   * The argument only the review's own call carries. Any other call, such as an
   * adapter's check that the model exists, runs the real CLI untouched, because
   * its output is read.
   */
  readonly review: string;
  readonly granted: string;
  /** Appended to, so a retried attempt keeps the first. */
  readonly stream: string;
};

export function shimScript(shim: Shim): string {
  const granted = quoted(shim.granted);
  return [
    "#!/bin/bash",
    "set -o pipefail",
    `case " $* " in *${quoted(` ${shim.review} `)}*) ;; *) exec ${quoted(shim.real)} "$@" ;; esac`,
    `printf '%s\\n' "$@" >> ${granted}`,
    `${[shim.real, ...shim.flags].map(quoted).join(" ")} "$@" | tee -a ${quoted(shim.stream)}`,
    "",
  ].join("\n");
}

/** `text` as one word to the shell, expanding nothing. */
function quoted(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}
