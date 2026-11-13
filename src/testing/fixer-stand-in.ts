/**
 * A fixer for the end-to-end tests, run by a `claude` or `copilot` stand-in on
 * the round host's PATH, in the worktree the host started it in.
 *
 * It does what a fixer's run does as squiz sees it: it changes the working
 * tree, and its stop fires the trigger, as the plugin's `Stop` hook would. Its
 * round host is `host-fixture.ts` on the same plan, whose `fixes` say what each
 * run does, in order.
 *
 * Its arguments are the host fixture's plan file and a file to append to, then
 * the arguments the fixer was started with. It appends one line per stop: the
 * prompt it was given, then how the trigger went.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readState } from "../loop/episode-state.ts";
import { episodeAt } from "../loop/episode.ts";
import { trigger } from "../host/trigger.ts";
import { deadlineIn } from "../reviewers/deadline.ts";
import { LOCAL_KEY, localVenue } from "../venues/local/venue.ts";
import type { Plan } from "./host-fixture.ts";

const hostFixture = fileURLToPath(new URL("host-fixture.ts", import.meta.url));
const [planFile = "", log = "", , prompt = ""] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planFile, "utf8")) as Plan;
const countFile = `${planFile}.fixed`;
const run = existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) : 0;
writeFileSync(countFile, String(run + 1), "utf8");
const fix = plan.fixes?.[run] ?? "changes";

function stop(): void {
  const triggered = trigger({
    directory: process.cwd(),
    trigger: "hook",
    owner: { sessionId: `fixer-${process.pid}` },
    environment: process.env,
    until: deadlineIn(10_000),
    host: (key) => ({ command: process.execPath, args: [hostFixture, key, planFile] }),
  });
  const how = triggered.outcome === "decided" ? `${triggered.decision.outcome}, queued ${String(triggered.queued)}` : triggered.outcome;
  appendFileSync(log, `${JSON.stringify({ prompt, triggered: how })}\n`, "utf8");
}

/** Block until the local episode records `count` reviewed states, or 60 seconds pass. */
function awaitReviewed(count: number): void {
  const named = episodeAt(localVenue, process.cwd(), LOCAL_KEY);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; waited < 60_000; waited += 100) {
    const read = named.outcome === "found" ? readState(named.episode) : undefined;
    const records = read?.outcome === "read" ? (read.state.records ?? []) : [];
    if (records.filter((record) => record.status === "reviewed").length >= count) return;
    Atomics.wait(pause, 0, 0, 100);
  }
}

if (fix !== "changes nothing") appendFileSync("fixed.txt", `a fix by process ${process.pid}\n`, "utf8");
stop();
if (fix === "stops twice") {
  // The stop above stands for a subagent's, which queued the change. The run's
  // own last stop finds that change reviewed, and queues nothing.
  awaitReviewed(2);
  stop();
}
