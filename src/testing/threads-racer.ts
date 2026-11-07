/**
 * One writer in the local record's tests, run as a process of its own.
 *
 * Its arguments are a worktree's directory, a mode, a label, a count and a
 * moment in epoch milliseconds. It waits for that moment by spinning, so that
 * every writer starts within the same millisecond, then:
 *
 * - `open-and-reply`: opens `count` threads and adds `count` replies to T1,
 *   alternately, each body naming the label and the step.
 * - `toggle`: resolves and re-opens T1, `count` times each.
 *
 * It prints how many writes failed.
 */

import { deadlineIn } from "../reviewers/deadline.ts";
import { addReply, openThread, setResolved } from "../venues/local/record.ts";

// Far longer than another writer holds the lock, however loaded the machine.
const LONG_MS = 120_000;

const [directory = "", mode = "", label = "", count = "0", at = "0"] = process.argv.slice(2);

while (Date.now() < Number(at));
let failed = 0;
const note = (outcome: { readonly outcome: string; readonly reason?: string }): void => {
  if (outcome.outcome === "failed") {
    process.stderr.write(`${outcome.reason}\n`);
    failed += 1;
  }
};
for (let step = 0; step < Number(count); step += 1) {
  const options = { until: deadlineIn(LONG_MS) };
  if (mode === "open-and-reply") {
    note(openThread(directory, "src/a.ts", { at: "line", line: step + 1 }, `${label}-open-${step}`, options));
    note(addReply(directory, "T1", `${label}-reply-${step}`, options));
  } else {
    note(setResolved(directory, "T1", true, options));
    note(setResolved(directory, "T1", false, options));
  }
}
process.stdout.write(`${failed}\n`);
