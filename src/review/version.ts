/**
 * `squiz version`: the version of the squiz that answers, and the path of its
 * `bin/squiz`.
 *
 * Both are read from beside this module, never from the working directory or
 * `PATH`. Either would print a plausible version for a copy that is not the one
 * running.
 */

import { dirname } from "node:path";

import { failureLine } from "../hook/report.ts";
import { manifestOf } from "./doctor.ts";
import { thisSquiz, type LinkPrinted } from "./path-link.ts";

/** One line naming the version and `bin/squiz` of `target`'s install, or why its version could not be read. */
export function squizVersion(target: () => string = thisSquiz): LinkPrinted {
  const bin = target();
  const root = dirname(dirname(bin));
  const manifest = manifestOf(root);
  if (manifest.outcome === "read") return { stdout: `squiz ${manifest.version} ${bin}\n`, stderr: "", exit: 0 };
  const reason = manifest.outcome === "unreadable" ? manifest.reason : `${root} is not squiz`;
  return { stdout: "", stderr: failureLine(`the version of this squiz could not be read: ${reason}`), exit: 1 };
}
