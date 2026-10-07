/**
 * Run the real reviewer once over one of the measured changes, outside the hook,
 * and summarise what it did.
 *
 *   node src/measure/review-once.ts <case> <pi|copilot> <charter-file> <out-directory>
 *   node src/measure/review-once.ts prepare
 *
 * The round is the one the round host runs: the adapter named, with the one
 * grant every round has, thinking `medium`, 900 seconds, in a snapshot of the
 * change's head made as a round makes it, handed the change's diff and its
 * description and no threads. The model is handed to the round directly, as the
 * round host hands it over, so nothing here reads `.squiz.json`.
 *
 * The reviewer's CLI must be on `PATH` and signed in, and each run spends real
 * money. `MEASURE_MODEL` names the model in the CLI's own spelling, as
 * `model` in `.squiz.json` would; without it the CLI's own default is used. `MEASURE_CACHE` is where the cases
 * on other projects are cloned, the temporary directory by default. `prepare`
 * clones every case once, which has to happen before runs go side by side.
 *
 * The out-directory gets `stream.jsonl`, the CLI's JSON events as they arrived;
 * `granted.txt`, the CLI's arguments; `round.json`, what the
 * round returned; and `summary.json`, which is also printed.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Reviewer } from "../config/config.ts";
import { adapterFor } from "../reviewers/adapters.ts";
import { deadlineIn } from "../reviewers/deadline.ts";
import { composePrompt } from "../reviewers/prompt.ts";
import { runRound } from "../reviewers/round.ts";
import { addSnapshot, removeSnapshot } from "../worktree/snapshot.ts";
import { prepareCase } from "./case-repository.ts";
import { cases } from "./cases.ts";
import { shimScript } from "./shim.ts";
import { summarise, type Run } from "./summary.ts";

const SECONDS = 900;
const patches = fileURLToPath(new URL("cases/", import.meta.url));
const cache = process.env["MEASURE_CACHE"] ?? join(tmpdir(), "squiz-measure-cases");

const [caseName, reviewerName, charterArgument, outArgument] = process.argv.slice(2);

if (caseName === "prepare") {
  let failed = 0;
  for (const [name, measured] of Object.entries(cases)) {
    const prepared = prepareCase(name, measured.source, patches, cache);
    if (prepared.outcome === "prepared") {
      console.log(`${name} ${prepared.head}`);
    } else {
      failed += 1;
      console.error(prepared.reason);
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

const measured = caseName === undefined ? undefined : cases[caseName];
const clis: Readonly<Record<Reviewer, { cli: string; jsonFlags: readonly string[]; review: string }>> = {
  pi: { cli: "pi", jsonFlags: ["--mode", "json"], review: "--print" },
  copilot: { cli: "copilot", jsonFlags: ["--output-format", "json"], review: "-p" },
};
const reviewer = reviewerName === "pi" || reviewerName === "copilot" ? clis[reviewerName] : undefined;
if (
  measured === undefined ||
  reviewer === undefined ||
  charterArgument === undefined ||
  outArgument === undefined
) {
  console.error(
    `usage: node src/measure/review-once.ts <${Object.keys(cases).join("|")}> <pi|copilot> <charter-file> <out-directory>`,
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

const bin = join(out, "bin");
mkdirSync(bin, { recursive: true });
const model = process.env["MEASURE_MODEL"];
writeFileSync(
  join(bin, reviewer.cli),
  shimScript({
    real: execFileSync("which", [reviewer.cli], { encoding: "utf8" }).trim(),
    flags: reviewer.jsonFlags,
    review: reviewer.review,
    granted: join(out, "granted.txt"),
    stream,
  }),
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
  adapterFor(reviewerName as Reviewer),
  {
    directory: tree,
    charterFile,
    prompt: composePrompt({ pullRequest, diff: prepared.diff, threads: [] }),
    sessionDirectory: join(own, "session"),
    promptFile: join(own, "prompt.md"),
    reportsFile: join(own, "reports.jsonl"),
    githubConfigDirectory: join(own, "gh"),
    model: model ?? null,
    thinking: "medium",
    terminal: "none",
  },
  SECONDS,
  { name: `measure-${basename(out)}` },
);
const run: Run = { label: basename(out), tree, seconds: (Date.now() - started) / 1_000, round };

const summary = {
  case: caseName,
  reviewer: reviewerName,
  model: model ?? "the CLI's default",
  ...summarise(run, readFileSync(stream, "utf8"), prepared.diff),
};
writeFileSync(join(out, "round.json"), `${JSON.stringify(run, null, 2)}\n`);
writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
removeSnapshot(tree);
