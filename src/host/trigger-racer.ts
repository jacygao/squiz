/**
 * One trigger in the trigger tests, run as a process of its own.
 *
 * Its one argument is JSON: the directory to trigger in, the episode's
 * directory and the file the stand-in host appends to, a moment in epoch
 * milliseconds, and whether to linger. It waits for that moment by spinning, so
 * that two racers trigger within the same millisecond, then triggers as a hook
 * would with the stand-in as the host. It prints what the trigger returned as
 * one line of JSON, and with `linger` keeps running until it is killed.
 */

import { fileURLToPath } from "node:url";

import { deadlineIn } from "../reviewers/deadline.ts";
import { trigger } from "./trigger.ts";

type Spec = {
  readonly directory: string;
  readonly episodeDirectory: string;
  readonly hostLog: string;
  readonly at: number;
  readonly linger: boolean;
};

const spec = JSON.parse(process.argv[2] ?? "{}") as Spec;
const standIn = fileURLToPath(new URL("host-stand-in.ts", import.meta.url));

while (Date.now() < spec.at);
const triggered = trigger({
  directory: spec.directory,
  trigger: "hook",
  environment: {},
  until: deadlineIn(60_000),
  host: () => ({ command: process.execPath, args: [standIn, spec.episodeDirectory, spec.hostLog] }),
});
process.stdout.write(`${JSON.stringify(triggered)}\n`);
if (spec.linger) setInterval(() => {}, 1_000);
