/**
 * Fake commands for tests, written so that no test writes a new executable.
 *
 * macOS checks a new executable the first time it runs, one file at a time
 * across the machine. That costs about a tenth of a second when the machine is
 * idle and about a second under load, and a fake first run inside a bound has
 * the bound spent on the check. So each fake is a plain script beside a link to
 * one executable per process, and that executable is run once as soon as it is
 * written, before any test's bound is counting.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What runs the script: sh, or node for CommonJS. */
export type Runner = "sh" | "node";

/**
 * Make `name` in `directory` a command that runs `script`, and return its path.
 *
 * The script is written as `name.sh` or `name.cjs` beside the link, and runs with
 * `$0` naming that file, so a fake that finds its fixtures beside itself finds
 * them in `directory`. Node runs a `.cjs` as CommonJS wherever it sits, which it
 * does not do for an extensionless file.
 */
export function standIn(directory: string, name: string, script: string, runner: Runner = "sh"): string {
  writeFileSync(join(directory, `${name}.${runner === "sh" ? "sh" : "cjs"}`), script, "utf8");
  const command = join(directory, name);
  symlinkSync(shared(), command);
  return command;
}

let shim: string | undefined;

function shared(): string {
  if (shim !== undefined) return shim;
  const directory = mkdtempSync(join(tmpdir(), "squiz-stand-in-"));
  process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "stand-in");
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      `if [ -f "$0.cjs" ]; then exec ${quoted(process.execPath)} "$0.cjs" "$@"; fi`,
      'exec /bin/sh "$0.sh" "$@"',
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(file, 0o755);
  // Nothing sits beside it, so it fails. Running it is the point.
  const warmed = spawnSync(file, { stdio: "ignore" });
  if (warmed.error !== undefined) throw warmed.error;
  shim = file;
  return file;
}

function quoted(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}
