/**
 * A fixer for the end-to-end tests, run by a `claude` or `copilot` stand-in on
 * the round host's PATH, in the worktree the host started it in.
 *
 * It does what a fixer's run does as squiz sees it: it changes the working
 * tree, and its stop fires the trigger, as the plugin's `Stop` hook would. Its
 * round host is `host-fixture.ts` on the same plan.
 *
 * Its arguments are the host fixture's plan file and a file to append to, then
 * the arguments the fixer was started with. It appends one line per run: the
 * prompt it was given, then how the trigger went.
 */

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { trigger } from "../host/trigger.ts";
import { deadlineIn } from "../reviewers/deadline.ts";

const hostFixture = fileURLToPath(new URL("host-fixture.ts", import.meta.url));
const [planFile = "", log = "", , prompt = ""] = process.argv.slice(2);

appendFileSync("fixed.txt", `a fix by process ${process.pid}\n`, "utf8");
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
