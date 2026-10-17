/**
 * The permission rules `squiz init` adds to Claude Code's user settings, so the
 * coding agent runs its three `squiz` commands without asking in any project.
 *
 * The file is the person's own. A file squiz cannot read as a settings object
 * is left exactly as it is, and only rules that are missing are added.
 */

import { lstatSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { failureLine } from "../hook/report.ts";

const RULES = ["Bash(squiz review *)", "Bash(squiz threads)", "Bash(squiz reply *)"];

export type AllowPrinted = { readonly stdout: string; readonly stderr: string };

export type ClaudeEnvironment = { readonly HOME?: string | undefined; readonly CLAUDE_CONFIG_DIR?: string | undefined };

/**
 * Add the missing rules to the `settings.json` Claude Code reads, or say why
 * none were added. Never creates the configuration directory, and never throws.
 */
export function allowSquizCommands(environment: ClaudeEnvironment): AllowPrinted {
  const found = configDirectory(environment);
  if (found.outcome === "unset") return { stdout: "", stderr: failureLine(`allowed nothing: ${found.reason}`) };
  // A person without Claude Code has no use for its settings, so none are created.
  if (!isDirectory(found.directory)) {
    return { stdout: `squiz: allowed nothing: Claude Code's configuration was not found at ${found.directory}\n`, stderr: "" };
  }
  const file = join(found.directory, "settings.json");
  const refuse = (why: string): AllowPrinted => ({ stdout: "", stderr: failureLine(`allowed nothing in ${file}: ${why}`) });

  let text: string | undefined;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    // A link to a missing file is the person's, and writing here would replace it.
    if (!isMissing(error) || exists(file)) return refuse(`it could not be read: ${describe(error)}`);
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

  const permissions = "permissions" in settings ? settings["permissions"] : {};
  if (!isObject(permissions)) return refuse("its permissions is not an object");
  const allow = "allow" in permissions ? permissions["allow"] : [];
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
    // No file yet: it is created in the directory the caller found.
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

/**
 * The directory Claude Code reads its user settings from: `CLAUDE_CONFIG_DIR`
 * where it is set, and `~/.claude` otherwise. An empty value counts as unset.
 */
function configDirectory(
  environment: ClaudeEnvironment,
): { readonly outcome: "found"; readonly directory: string } | { readonly outcome: "unset"; readonly reason: string } {
  const configured = environment.CLAUDE_CONFIG_DIR;
  if (configured !== undefined && configured !== "") {
    if (!isAbsolute(configured)) {
      return { outcome: "unset", reason: `CLAUDE_CONFIG_DIR is ${JSON.stringify(configured)}, which is not an absolute path` };
    }
    return { outcome: "found", directory: configured };
  }
  const home = environment.HOME;
  if (home === undefined || !isAbsolute(home)) {
    return { outcome: "unset", reason: "neither CLAUDE_CONFIG_DIR nor HOME is set, so Claude Code's configuration cannot be found" };
  }
  return { outcome: "found", directory: join(home, ".claude") };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Whether anything is at `path` itself, a link included whatever it points at. */
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
