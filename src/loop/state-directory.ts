/**
 * The one way an episode's directory is made, so that `.squiz/` keeps itself
 * out of git.
 *
 * `.squiz/` holds a `.gitignore` reading `*`, which ignores the directory and
 * everything in it with no line in the project's own `.gitignore`. Every writer
 * that makes an episode's directory comes through here, so a `.squiz/` that
 * lost the file, or predates it, gains it on the next write.
 *
 * Two writers can make the directory at once: a hook queueing a state and the
 * round host it started. The file is written whole under a name of this
 * process's own and linked into place, so no reader sees it part written and
 * neither writer fails for having lost the race.
 */

import { linkSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Episode } from "./episode.ts";

const IGNORE_EVERYTHING = "*\n";

/**
 * Make `episode`'s directory, and the `.gitignore` in the `.squiz/` above it
 * where that is missing.
 *
 * A `.gitignore` already there is left as it is, whatever it holds, because
 * someone other than squiz may have written it. Throws what the filesystem
 * throws.
 */
export function makeEpisodeDirectory(episode: Episode): void {
  const states = dirname(episode.directory);
  mkdirSync(episode.directory, { recursive: true });
  const ignore = join(states, ".gitignore");
  if (present(ignore)) return;

  const draft = join(states, `.gitignore.${process.pid}.${Math.random().toString(16).slice(2)}.writing`);
  try {
    writeFileSync(draft, IGNORE_EVERYTHING, { flag: "wx" });
    try {
      linkSync(draft, ignore);
    } catch (error) {
      // Another writer linked its own first, and it says the same.
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  } finally {
    rmSync(draft, { force: true });
  }
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
