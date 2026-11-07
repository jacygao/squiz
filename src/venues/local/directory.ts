/**
 * The directory each worktree the local venue reviews has in `SQUIZ_LOCAL`,
 * which is its episode's.
 *
 * The name folds every `/` to `-`, so two worktrees can be given one name.
 * The `worktree` file inside says which of them the directory belongs to, and
 * the other is refused rather than reading or writing that worktree's record.
 */

import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

import type { Failed } from "../venue.ts";

const WORKTREE_FILE = "worktree";

export type WorktreeDirectory =
  | { readonly outcome: "claimed"; readonly directory: string }
  /** The directory belongs to another worktree: the line `squiz review` exits 1 with. */
  | { readonly outcome: "refused"; readonly reason: string }
  | Failed;

/** The name of `worktree`'s directory: its path, with the leading `/` dropped and every other made `-`. */
export function directoryName(worktree: string): string {
  return worktree.slice(1).replaceAll("/", "-");
}

/**
 * The directory of `worktree` in `local`, made where it is missing, `local`
 * with it.
 *
 * A directory made here holds a `worktree` file naming the path it was made
 * for. A directory whose file names another worktree is refused, and nothing
 * in it is changed. Never throws.
 */
export function claimDirectory(local: string, worktree: string): WorktreeDirectory {
  // Only a toplevel's own spelling is taken. `/..` would name `local`'s parent,
  // and `/work/squiz/` a second directory for `/work/squiz`.
  if (!isAbsolute(worktree) || normalize(worktree) !== worktree || worktree === "/" || worktree.endsWith("/")) {
    return failed(`${JSON.stringify(worktree)} is not a worktree's absolute path`);
  }
  const directory = join(local, directoryName(worktree));
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    return failed(`${directory} could not be made: ${messageOf(error)}`);
  }

  const file = join(directory, WORKTREE_FILE);
  const placed = place(file, worktree);
  if (placed !== "exists") return placed === "placed" ? { outcome: "claimed", directory } : failed(placed.reason);

  let recorded: string;
  try {
    recorded = readFileSync(file, "utf8");
  } catch (error) {
    return failed(`${file} could not be read: ${messageOf(error)}`);
  }
  if (recorded !== worktree) {
    return { outcome: "refused", reason: `${directory} holds the review of ${recorded}, not ${worktree}` };
  }
  return { outcome: "claimed", directory };
}

/**
 * Link `path` into being holding `text`, unless something has that name.
 *
 * Two worktrees that fold to one name can claim it at once. A link fails where
 * the name exists, so exactly one of them writes the file, and neither can read
 * it half-written.
 */
function place(path: string, text: string): "placed" | "exists" | Failed {
  const draft = `${path}.${process.pid}.${randomUUID()}.writing`;
  try {
    writeFileSync(draft, text, { flag: "wx" });
    linkSync(draft, path);
    return "placed";
  } catch (error) {
    if (codeOf(error) === "EEXIST") return "exists";
    return failed(`${path} could not be written: ${messageOf(error)}`);
  } finally {
    try {
      rmSync(draft, { force: true });
    } catch {
      // A draft left behind is litter: nothing reads one by its name.
    }
  }
}

function failed(reason: string): Failed {
  return { outcome: "failed", reason };
}

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
