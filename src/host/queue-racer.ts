/**
 * A trigger's queueing, for the host tests, run as a process of its own from
 * inside a fake `gh` call.
 *
 * Its arguments are a worktree, a pull request number and a head commit. It
 * queues that state, with no activity, under the state lock, and refuses where
 * the episode's close is recorded, as a trigger does. It prints `queued` or
 * `closed`.
 */

import { deadlineIn } from "../reviewers/deadline.ts";
import { episodeAt } from "../loop/episode.ts";
import { putRecord } from "../loop/state-record.ts";
import { updateState } from "../loop/state-update.ts";

const [worktree = "", pullRequest = "0", head = ""] = process.argv.slice(2);

let queued = false;
const updated = updateState(
  episodeAt(worktree, Number(pullRequest)),
  (state) => {
    if (state.closeReported === true) return state;
    queued = true;
    return { ...state, records: putRecord(state.records ?? [], { head, activity: null, status: "queued" }) };
  },
  { until: deadlineIn(10_000) },
);
if (updated.outcome === "failed") {
  process.stderr.write(`${updated.reason}\n`);
  process.exit(1);
}
process.stdout.write(queued ? "queued\n" : "closed\n");
