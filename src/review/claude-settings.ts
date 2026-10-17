/**
 * The permission rules `squiz init` adds to Claude Code's user settings, so the
 * coding agent runs its three `squiz` commands without asking in any project.
 *
 * The file is the person's own. A file squiz cannot read as a settings object
 * is left exactly as it is, and only rules that are missing are added.
 */

import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { failureLine } from "../hook/report.ts";

const RULES = ["Bash(squiz review *)", "Bash(squiz threads)", "Bash(squiz reply *)"];

export type AllowPrinted = { readonly stdout: string; readonly stderr: string };

/** Add the missing rules to `<home>/.claude/settings.json`, or say why none were added. Never throws. */
export function allowSquizCommands(home: string | undefined): AllowPrinted {
  if (home === undefined || !isAbsolute(home)) {
    return { stdout: "", stderr: failureLine("allowed nothing: HOME is not set, so there is no ~/.claude/settings.json to write") };
  }
  const file = join(home, ".claude", "settings.json");
  const refuse = (why: string): AllowPrinted => ({ stdout: "", stderr: failureLine(`allowed nothing in ${file}: ${why}`) });

  let text: string | undefined;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (!isMissing(error)) return refuse(`it could not be read: ${describe(error)}`);
  }

  let settings: Record<string, unknown> = {};
  if (text !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return refuse(`it is not JSON (${describe(error)})`);
    }
    if (!isObject(parsed)) return refuse(`it holds ${kindOf(parsed)}, not an object`);
    settings = parsed;
  }

  const permissions = settings["permissions"] ?? {};
  if (!isObject(permissions)) return refuse("its permissions is not an object");
  const allow = permissions["allow"] ?? [];
  if (!Array.isArray(allow)) return refuse("its permissions.allow is not a list");

  const missing = RULES.filter((rule) => !allow.includes(rule));
  if (missing.length === 0) return { stdout: `squiz: ${file} already allows ${listed(RULES)}; nothing changed\n`, stderr: "" };

  settings["permissions"] = { ...permissions, allow: [...allow, ...missing] };
  try {
    write(file, `${JSON.stringify(settings, null, 2)}\n`);
  } catch (error) {
    return refuse(`it could not be written: ${describe(error)}`);
  }
  return { stdout: `squiz: allowed ${listed(missing)} in ${file}\n`, stderr: "" };
}

/**
 * Write `text` to `file` through a file beside it renamed over it, so that no
 * moment leaves Claude Code reading half a settings file. A symlinked file is
 * written at its target, so the link a person keeps their dotfiles through
 * stays a link.
 */
function write(file: string, text: string): void {
  let real = file;
  let mode = 0o644;
  try {
    real = realpathSync.native(file);
    mode = statSync(real).mode & 0o777;
  } catch {
    mkdirSync(dirname(file), { recursive: true });
  }
  const beside = `${real}.squiz-${process.pid}`;
  writeFileSync(beside, text, { encoding: "utf8", mode });
  renameSync(beside, real);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a JSON array";
  return `a JSON ${typeof value}`;
}

function listed(rules: readonly string[]): string {
  return rules.length === 1 ? rules[0] ?? "" : `${rules.slice(0, -1).join(", ")} and ${rules.at(-1) ?? ""}`;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
