/**
 * Run the real reviewer once over one of the measured changes, outside the hook,
 * and summarise what it did.
 *
 *   node src/measure/review-once.ts <case> <pi|copilot> <read|deep> <charter-file> <out-directory>
 *   node src/measure/review-once.ts prepare
 *
 * The round is the one the round host runs: the adapter named, at the depth
 * named, thinking `medium`, 900 seconds, in a snapshot of the change's head made
 * as a round makes it, handed the change's diff and its description and no
 * threads. At `deep`, `run_tests` runs the case's own test command. The depth
 * is handed to the round directly, as the round host hands it over, so nothing
 * here reads `.squiz.json`.
 *
 * The reviewer's CLI must be on `PATH` and signed in, and each run spends real
 * money. `MEASURE_MODEL` names the model, which goes on the CLI's command line;
 * without it the CLI's own default is used. `MEASURE_CACHE` is where the cases
 * on other projects are cloned, the temporary directory by default. `prepare`
 * clones every case once, which has to happen before runs go side by side.
 *
 * The out-directory gets `stream.jsonl`, the CLI's JSON events as they arrived;
 * `granted.txt`, the CLI's arguments and `SQUIZ_ROUND`; `round.json`, what the
 * round returned; and `summary.json`, which is also printed.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import type { Adapter } from "../reviewers/adapter.ts";
import { copilot } from "../reviewers/copilot/adapter.ts";
import { deadlineIn } from "../reviewers/deadline.ts";
import { discardRoundSpace, makeRoundSpace } from "../reviewers/groups.ts";
import { pi } from "../reviewers/pi/adapter.ts";
import { composePrompt } from "../reviewers/prompt.ts";
import { runRound } from "../reviewers/round.ts";
import { addSnapshot, removeSnapshot } from "../worktree/snapshot.ts";
import { prepareCase } from "./case-repository.ts";
import { cases } from "./cases.ts";
import { summarise, type Run } from "./summary.ts";

const SECONDS = 900;
const patches = new URL("cases/", import.meta.url).pathname;
const cache = process.env["MEASURE_CACHE"] ?? join(tmpdir(), "squiz-measure-cases");

const [caseName, reviewerName, depthName, charterArgument, outArgument] = process.argv.slice(2);

if (caseName === "prepare") {
  for (const [name, measured] of Object.entries(cases)) {
    const prepared = prepareCase(name, measured.source, patches, cache);
    console.log(prepared.outcome === "prepared" ? `${name} ${prepared.head}` : `${name} ${prepared.reason}`);
  }
  process.exit(0);
}

const measured = caseName === undefined ? undefined : cases[caseName];
const adapters: Readonly<Record<string, { adapter: Adapter; cli: string; jsonFlags: readonly string[] }>> = {
  pi: { adapter: pi, cli: "pi", jsonFlags: ["--mode", "json"] },
  copilot: { adapter: copilot, cli: "copilot", jsonFlags: ["--output-format", "json"] },
};
const reviewer = reviewerName === undefined ? undefined : adapters[reviewerName];
const depth = depthName === "read" || depthName === "deep" ? depthName : undefined;
if (
  measured === undefined ||
  reviewer === undefined ||
  depth === undefined ||
  charterArgument === undefined ||
  outArgument === undefined
) {
  console.error(
    `usage: node src/measure/review-once.ts <${Object.keys(cases).join("|")}> <pi|copilot> <read|deep> <charter-file> <out-directory>`,
  );
  process.exit(2);
}

const prepared = prepareCase(caseName as string, measured.source, patches, cache);
if (prepared.outcome === "failed") {
  console.error(prepared.reason);
  process.exit(1);
}

const charterFile = resolve(charterArgument);
const out = resolve(outArgument);
const own = join(out, "round");
const stream = join(out, "stream.jsonl");
mkdirSync(join(own, "session"), { recursive: true });

// The CLI ahead of the real one on PATH, asking for its JSON events and copying
// them to a file so that the tool calls and their answers can be read back.
// Appended, so a retried attempt keeps the first.
const bin = join(out, "bin");
mkdirSync(bin, { recursive: true });
const real = execFileSync("which", [reviewer.cli], { encoding: "utf8" }).trim();
const model = process.env["MEASURE_MODEL"];
const flags = [...reviewer.jsonFlags, ...(model === undefined ? [] : ["--model", model])].map((flag) => `'${flag}'`);
// It also records the command line and the round's variable, which show the
// grant and whether the `deep` tools were handed a round to run in.
const granted = join(out, "granted.txt");
writeFileSync(
  join(bin, reviewer.cli),
  [
    "#!/bin/bash",
    "set -o pipefail",
    `printf '%s\\n' "$@" >> "${granted}"`,
    `printf 'SQUIZ_ROUND=%s\\n' "$SQUIZ_ROUND" >> "${granted}"`,
    `"${real}" ${flags.join(" ")} "$@" | tee -a "${stream}"`,
    "",
  ].join("\n"),
);
chmodSync(join(bin, reviewer.cli), 0o755);
writeFileSync(stream, "");
process.env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;

// Each run's own snapshot, so that runs of one case side by side do not meet.
const snapshot = addSnapshot(
  prepared.repository,
  { pullRequest: measured.number, round: process.pid, commit: prepared.head },
  deadlineIn(120_000),
);
if (snapshot.outcome === "failed") {
  console.error(snapshot.reason);
  process.exit(1);
}
const tree = snapshot.path;

const space = depth === "deep" ? makeRoundSpace(own) : undefined;
if (space !== undefined && space.outcome === "failed") {
  console.error(space.reason);
  process.exit(1);
}
const roundSpace = space?.space;

const pullRequest = {
  number: measured.number,
  nodeId: "PR_measure",
  baseRef: "main",
  headRef: measured.headRef,
  headSha: prepared.head,
  description: readFileSync(join(patches, measured.description), "utf8"),
};

const started = Date.now();
const round = await runRound(
  reviewer.adapter,
  {
    directory: tree,
    charterFile,
    prompt: composePrompt({ pullRequest, diff: prepared.diff, threads: [] }, { depth, command: measured.test }),
    sessionDirectory: join(own, "session"),
    promptFile: join(own, "prompt.md"),
    reportsFile: join(own, "reports.jsonl"),
    scratchDirectory: join(own, "scratch"),
    githubConfigDirectory: join(own, "gh"),
    depth,
    test: measured.test,
    thinking: "medium",
    roundSpace,
    terminal: "none",
  },
  SECONDS,
  { name: `measure-${basename(out)}` },
);
const run: Run = { label: basename(out), tree, seconds: (Date.now() - started) / 1_000, round };
if (roundSpace !== undefined) discardRoundSpace(roundSpace);

const summary = {
  case: caseName,
  reviewer: reviewerName,
  depth,
  model: model ?? "the CLI's default",
  ...summarise(run, readFileSync(stream, "utf8"), prepared.diff),
};
writeFileSync(join(out, "round.json"), `${JSON.stringify(run, null, 2)}\n`);
writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
removeSnapshot(tree);
