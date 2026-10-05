/**
 * One writer in the state file tests' races, run as a process of its own.
 *
 * Its arguments are a worktree, a pull request number, a label, a count, a record status
 * and a moment in epoch milliseconds. It waits for that moment by spinning, so
 * that every writer starts within the same millisecond, then puts `count`
 * records into the episode's state file one update at a time, each for a state
 * no other writer names. It prints how many updates failed.
 */

import { deadlineIn } from "../reviewers/deadline.ts";
import { identityOf } from "../sessions/process.ts";
import { episodeAt } from "./episode.ts";
import { putRecord, type StateRecord } from "./state-record.ts";
import { updateState } from "./state-update.ts";

// Far longer than another writer holds the lock, however loaded the machine.
const LONG_MS = 120_000;

const [worktree = "", pullRequest = "0", label = "", count = "0", status = "queued", at = "0"] = process.argv.slice(2);
const episode = episodeAt(worktree, Number(pullRequest));

const read = identityOf(process.pid, 5_000);
if (read.outcome !== "read") {
  process.stderr.write(`own identity not read: ${JSON.stringify(read)}\n`);
  process.exit(1);
}
const self = read.identity;

function recordFor(index: number): StateRecord {
  const state = { head: `${label}-${index}`, activity: null };
  return status === "reviewing" ? { ...state, status: "reviewing", host: self } : { ...state, status: "queued" };
}

while (Date.now() < Number(at));
let failed = 0;
for (let index = 0; index < Number(count); index += 1) {
  const record = recordFor(index);
  const updated = updateState(
    episode,
    (state) => ({ ...state, records: putRecord(state.records ?? [], record) }),
    { until: deadlineIn(LONG_MS), self },
  );
  if (updated.outcome !== "written") {
    process.stderr.write(`${updated.reason}\n`);
    failed += 1;
  }
}
process.stdout.write(`${failed}\n`);
