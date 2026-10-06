/**
 * The link `squiz init` makes so that any coding agent's shell runs `squiz` by
 * name: `<dir>/squiz`, pointing at this squiz's `bin/squiz` by its real path.
 *
 * One person may run several coding agents on one machine, and what Claude Code
 * uses is the first choice for the rest. So nothing named `squiz` that is not
 * this squiz is ever replaced or shadowed. The one exception is a link to an
 * earlier version of the same plugin-cache install, which is this squiz before
 * an update rather than another one.
 */

import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { failureLine } from "../hook/report.ts";

export type LinkEnvironment = { readonly PATH?: string | undefined; readonly HOME?: string | undefined };

export type LinkPrinted = { readonly stdout: string; readonly stderr: string; readonly exit: 0 | 1 };

/** The real path of the `bin/squiz` in the plugin this module belongs to. */
export function thisSquiz(): string {
  return realpathSync.native(fileURLToPath(new URL("../../bin/squiz", import.meta.url)));
}

/** What one `squiz` on `PATH` is, measured against the squiz being linked. */
export type Found =
  | { readonly kind: "this"; readonly entry: string }
  | { readonly kind: "earlier"; readonly entry: string; readonly final: string }
  | { readonly kind: "conflict"; readonly entry: string; readonly reason: string };

/**
 * Every `squiz` in a directory on `PATH`, in `PATH` order, with what each is.
 *
 * This squiz's own `bin/` on `PATH` is left out. Claude Code puts it there for
 * its own shell alone, so it says nothing about what another agent's shell
 * runs.
 */
export function squizzesOnPath(target: string, environment: LinkEnvironment, directory: string): Found[] {
  const found: Found[] = [];
  for (const searched of searchedDirectories(environment, directory)) {
    // Joined as text: path.join would fold `..` before the system follows the
    // symlink ahead of it.
    const entry = `${searched}/squiz`;
    let stat;
    try {
      stat = lstatSync(entry);
    } catch {
      continue;
    }

    const { final, exists } = followLinks(entry);
    if (!stat.isSymbolicLink()) {
      if (final === target) continue;
      found.push(
        isSquiz(final)
          ? conflict(
              entry,
              `${searched} is another squiz's bin/ on PATH, the way Claude Code puts an enabled plugin's there. Run squiz init by name in that session, so the link points at the squiz it uses`,
            )
          : conflict(entry, `${entry} is not squiz, and squiz leaves it alone. Move it off PATH, then run squiz init again`),
      );
      continue;
    }

    if (final === target) {
      found.push({ kind: "this", entry });
    } else if (isEarlierVersion(final, target)) {
      found.push({ kind: "earlier", entry, final });
    } else if (!exists) {
      found.push(
        conflict(entry, `${entry} links to ${final}, which does not exist. Remove ${entry}, then run squiz init again`),
      );
    } else if (isSquiz(final)) {
      found.push(
        conflict(
          entry,
          `${entry} links to another squiz, ${final}. To use this one instead, remove ${entry} and run squiz init again`,
        ),
      );
    } else {
      found.push(
        conflict(
          entry,
          `${entry} links to ${final}, which is not squiz, and squiz leaves it alone. Move it off PATH, then run squiz init again`,
        ),
      );
    }
  }
  return found;
}

/**
 * Link `target` into a directory on `PATH`, or say why no link was made.
 *
 * `directory` is the working directory, which a relative or empty `PATH` entry
 * names. Exits 1 where no link to `target` is on `PATH` afterwards. Never
 * throws.
 */
export function linkOntoPath(
  target: string,
  environment: LinkEnvironment,
  directory: string = process.cwd(),
): LinkPrinted {
  const found = squizzesOnPath(target, environment, directory);

  const blocking = found.find((each) => each.kind === "conflict");
  if (blocking !== undefined) return madeNone(blocking.reason);

  // Every one is moved, since one left ahead of a link to this version is the
  // squiz that runs.
  const lines: string[] = [];
  for (const earlier of found) {
    if (earlier.kind !== "earlier") continue;
    // A link made beside the old one and renamed over it, so there is no moment
    // with no squiz on PATH.
    const beside = `${earlier.entry}.squiz-${process.pid}`;
    try {
      symlinkSync(target, beside);
      renameSync(beside, earlier.entry);
    } catch (error) {
      return madeNone(`${earlier.entry} could not be moved to ${target}: ${describe(error)}`);
    }
    lines.push(`linked ${earlier.entry} to ${target}, in place of ${earlier.final}, an earlier version of this install`);
  }
  if (lines.length > 0) return made(lines.join("\nsquiz: "));

  const linked = found.find((each) => each.kind === "this");
  if (linked !== undefined) return made(`${linked.entry} already links to this squiz; nothing changed`);

  const home = environment.HOME;
  if (home === undefined || !isAbsolute(home)) {
    return madeNone("HOME is not set, so there is no directory to link squiz into");
  }
  const choices = [join(home, ".local", "bin"), join(home, "bin")];
  // Only an entry that resolves counts: a shell cannot search through a missing
  // directory, whatever its text folds to.
  const onPath = new Set(absoluteDirectories(environment).map(realOrUndefined));
  const chosen = choices.find((choice) => {
    const real = realOrUndefined(choice);
    return real !== undefined && onPath.has(real) && isWritableDirectory(choice);
  });
  if (chosen === undefined) {
    return madeNone(
      `neither ${choices[0]} nor ${choices[1]} is a directory on PATH that you can write to. Add ${choices[0]} to PATH, creating it if it does not exist, then run squiz init again`,
    );
  }

  const link = join(chosen, "squiz");
  try {
    // An absolute target, because a relative one resolves from the link's
    // directory rather than from where it was made.
    symlinkSync(target, link);
  } catch (error) {
    return madeNone(`${link} could not be made: ${describe(error)}`);
  }
  return made(`linked ${link} to ${target}`);
}

/**
 * Every directory a shell searches for `squiz`, in order and each once. An empty
 * entry is the working directory, and a relative one is read from it. Each is
 * left as text for the system to resolve, since folding its `..` first would
 * name a different directory wherever a symlink precedes it.
 */
function searchedDirectories(environment: LinkEnvironment, directory: string): string[] {
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const entry of (environment.PATH ?? "").split(":")) {
    const searched = entry === "" ? directory : isAbsolute(entry) ? entry : `${directory}/${entry}`;
    // An entry that does not resolve holds nothing to find, and is not allowed
    // to stand for a directory that does.
    const key = realOrUndefined(searched);
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    directories.push(searched);
  }
  return directories;
}

/**
 * The absolute directories on `PATH`. A relative entry names a different
 * directory from each place a shell starts in, so no link goes there.
 */
function absoluteDirectories(environment: LinkEnvironment): string[] {
  return (environment.PATH ?? "").split(":").filter((entry) => isAbsolute(entry));
}

/**
 * Where `path` ends once every link is followed, and whether anything is there.
 *
 * A link whose target is gone ends at the target as its link names it, so the
 * missing path can be named and compared.
 */
function followLinks(path: string): { final: string; exists: boolean } {
  // The native call throughout this file, because the JavaScript one folds `..`
  // before it follows the links ahead of it.
  try {
    return { final: realpathSync.native(path), exists: true };
  } catch {
    // Followed by hand below, to name where the chain breaks.
  }
  let current = path;
  for (let hops = 0; hops < 40; hops += 1) {
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return { final: physicalOf(current), exists: false };
    }
    if (!stat.isSymbolicLink()) return { final: realpathSync.native(current), exists: true };
    const link = readlinkSync(current);
    current = isAbsolute(link) ? link : `${realOrUndefined(dirname(current)) ?? dirname(current)}/${link}`;
  }
  return { final: current, exists: false };
}

/**
 * `path`, for a file that is not there, with the longest part of it that exists
 * resolved by the system and the rest appended. A removed cache version is then
 * named under the same install as the version that replaced it.
 */
function physicalOf(path: string): string {
  const missing: string[] = [];
  let existing = path;
  while (dirname(existing) !== existing) {
    const real = realOrUndefined(existing);
    if (real !== undefined) return join(real, ...missing);
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  return path;
}

/** Whether `binary` is `bin/squiz` in a plugin whose manifest names it squiz. */
function isSquiz(binary: string): boolean {
  if (basename(binary) !== "squiz" || basename(dirname(binary)) !== "bin") return false;
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(join(dirname(dirname(binary)), ".claude-plugin", "plugin.json"), "utf8"),
    );
    return typeof manifest === "object" && manifest !== null && "name" in manifest && manifest.name === "squiz";
  } catch {
    return false;
  }
}

/**
 * Whether `other` is another version of `target`'s plugin-cache install.
 *
 * Claude Code installs a plugin at `plugins/cache/<marketplace>/<plugin>/<version>/`,
 * so two versions share everything above the version.
 */
function isEarlierVersion(other: string, target: string): boolean {
  const install = installOf(target);
  return install !== undefined && install === installOf(other) && other !== target;
}

function installOf(binary: string): string | undefined {
  if (basename(binary) !== "squiz" || basename(dirname(binary)) !== "bin") return undefined;
  const install = dirname(dirname(dirname(binary)));
  const cache = dirname(dirname(install));
  if (basename(cache) !== "cache" || basename(dirname(cache)) !== "plugins") return undefined;
  return install;
}

function isWritableDirectory(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function realOrUndefined(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

function conflict(entry: string, reason: string): Found {
  return { kind: "conflict", entry, reason };
}

function made(line: string): LinkPrinted {
  return { stdout: `squiz: ${line}\n`, stderr: "", exit: 0 };
}

function madeNone(reason: string): LinkPrinted {
  return { stdout: "", stderr: failureLine(`made no link: ${reason}`), exit: 1 };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
