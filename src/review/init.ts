/**
 * `squiz init`: add the review section to the `AGENTS.md` at the repository's
 * root, for coding agents that read their instructions there rather than from
 * the plugin's skill, and link `squiz` onto `PATH` for the shells of coding
 * agents that do not put the plugin's `bin/` there.
 *
 * The file is only ever appended to. What it held before is left byte for byte
 * as it was, because it is the host project's and squiz has no say in it.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { failureLine } from "../hook/report.ts";
import { deadlineIn } from "../reviewers/deadline.ts";
import { worktreeToplevel } from "../worktree/toplevel.ts";
import { linkOntoPath, type LinkEnvironment } from "./path-link.ts";

const GIT_BOUND_MS = 10_000;

export const REVIEW_SECTION = `## Review

After you open a pull request, and after every push to it, run
\`squiz review <number>\` from the worktree its branch is checked out in. It runs a
review and waits for it, which takes several minutes, so give the command your
shell tool's longest timeout. If the command is moved to the background anyway,
wait for it to finish and read its output before you do anything else.

- **Exit 0:** nothing is open. You are done.
- **Exit 2:** threads are open, and the command prints them. Its first line names
  a file holding the whole output. Where what you were shown is cut short, read
  that file. Fix what applies, reply on each thread with \`squiz reply <id> <text>\`
  to say what you changed or why you disagree, commit and push what you changed,
  and run \`squiz review <number>\` again. A reply is reviewed even with no new
  commit.
- **Exit 3:** the review closed with threads still open. Do not run it again. Say
  in your report which threads are open.
- **Exit 4:** squiz is still reviewing. Run \`squiz review <number>\` again.
- **Exit 1, or anything else:** the review could not run, or it failed. Put the
  lines it printed in your report, and do not run it again.
`;

export type InitPrinted = { readonly stdout: string; readonly stderr: string; readonly exit: 0 | 1 };

/**
 * Add the section for the repository holding `directory`, and link `target`
 * onto `PATH`.
 *
 * Each is done whether or not the other could be. Exits 1 where either could
 * not, with what each did in its own line.
 */
export function squizInit(directory: string, environment: LinkEnvironment, target: string): InitPrinted {
  const section = addReviewSection(directory);
  const link = linkOntoPath(target, environment, directory);
  return {
    stdout: section.stdout + link.stdout,
    stderr: section.stderr + link.stderr,
    exit: section.exit === 0 && link.exit === 0 ? 0 : 1,
  };
}

/**
 * Add the section to the `AGENTS.md` of the repository holding `directory`,
 * creating the file where there is none.
 *
 * Exits 1, with one line on stderr and nothing written, where there is no
 * repository or the file cannot be read or written. A person runs this, so the
 * exit says whether it worked. Never throws.
 */
export function addReviewSection(directory: string): InitPrinted {
  const toplevel = worktreeToplevel(directory, deadlineIn(GIT_BOUND_MS));
  if (toplevel.outcome === "failed") {
    return failed(`the repository's root could not be found: ${toplevel.reason}`);
  }
  const path = join(toplevel.path, "AGENTS.md");

  let existing: string;
  try {
    existing = readFileSync(path, "utf8");
  } catch (error) {
    if (!isMissing(error)) return failed(`AGENTS.md could not be read: ${describe(error)}`);
    existing = "";
  }

  if (hasSection(existing)) {
    return { stdout: "squiz: AGENTS.md already has the review section; nothing changed\n", stderr: "", exit: 0 };
  }

  try {
    appendFileSync(path, separatorAfter(existing) + REVIEW_SECTION, "utf8");
  } catch (error) {
    return failed(`AGENTS.md could not be written: ${describe(error)}`);
  }
  return { stdout: "squiz: added the review section to AGENTS.md\n", stderr: "", exit: 0 };
}

/**
 * Whether the whole section is in `text`, starting a line.
 *
 * A `## Review` heading or a mention of `squiz review` is not enough: the
 * project may have either for reasons of its own, and its agents would then
 * never be told what each exit means. A section someone has since reworded is
 * not found, and gets a second copy.
 */
function hasSection(text: string): boolean {
  // Wrapped in newlines so the section can open the file, or end it with no
  // newline after its last line.
  const wrapped = `\n${text}\n`;
  return wrapped.includes(`\n${REVIEW_SECTION}`);
}

/** What to write before the section so that one blank line sits above it. */
function separatorAfter(text: string): string {
  if (text === "" || text.endsWith("\n\n")) return "";
  return text.endsWith("\n") ? "\n" : "\n\n";
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failed(reason: string): InitPrinted {
  return { stdout: "", stderr: failureLine(`nothing changed: ${reason}`), exit: 1 };
}
