/**
 * Run the real reviewer once over one of the measured changes, outside the hook,
 * and summarise what it did.
 *
 *   node src/measure/review-once.ts <case> <charter-file> <out-directory>
 *
 * The round is the one the hook runs: the `pi` adapter, depth `read`, thinking
 * `medium`, and 480 seconds. It runs in a detached worktree at the change's
 * head, handed the change's diff and its description as they were, and no
 * threads. `pi` must be on `PATH` with a provider it can reach, and each run
 * spends real money.
 *
 * The out-directory gets `stream.jsonl`, `pi`'s own output as it arrived;
 * `round.json`, what the round returned; and `summary.json`, which is also
 * printed.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pi } from "../reviewers/pi/adapter.ts";
import { composePrompt } from "../reviewers/prompt.ts";
import { runRound } from "../reviewers/round.ts";
import { cases } from "./cases.ts";
import { summarise, type Run } from "./summary.ts";

const [caseName, charterArgument, outArgument] = process.argv.slice(2);
const measured = caseName === undefined ? undefined : cases[caseName];
if (measured === undefined || charterArgument === undefined || outArgument === undefined) {
  console.error(
    `usage: node src/measure/review-once.ts <${Object.keys(cases).join("|")}> <charter-file> <out-directory>`,
  );
  process.exit(2);
}

const root = fileURLToPath(new URL("../..", import.meta.url));
const charterFile = resolve(charterArgument);
const out = resolve(outArgument);
const tree = join(out, "tree");
const stream = join(out, "stream.jsonl");
mkdirSync(out, { recursive: true });

execFileSync("git", ["-C", root, "worktree", "add", "--detach", tree, measured.head], { stdio: "ignore" });
const diff = execFileSync("git", ["-C", tree, "diff", measured.base, measured.head], { encoding: "utf8" });
const description = readFileSync(new URL(`cases/${measured.description}`, import.meta.url), "utf8");

// A `pi` ahead of the real one on PATH, copying its stream to a file so that the
// tool calls can be counted. Appended, so a retried attempt keeps the first.
const bin = join(out, "bin");
mkdirSync(bin, { recursive: true });
const realPi = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
writeFileSync(join(bin, "pi"), `#!/bin/sh\n"${realPi}" "$@" | tee -a "${stream}"\n`);
chmodSync(join(bin, "pi"), 0o755);
writeFileSync(stream, "");
process.env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;

const pullRequest = {
  number: measured.number,
  nodeId: "PR_measure",
  baseRef: "main",
  headRef: measured.headRef,
  headSha: measured.head,
  description,
};

const started = Date.now();
const round = await runRound(
  pi,
  {
    directory: tree,
    charterFile,
    prompt: composePrompt({ pullRequest, diff, threads: [] }, { depth: "read", command: null }),
    sessionDirectory: ".squiz/measure/session",
    scratchDirectory: ".squiz/measure/scratch",
    depth: "read",
    thinking: "medium",
    roundSpace: undefined,
  },
  480,
);
const run: Run = { label: basename(out), tree, seconds: (Date.now() - started) / 1_000, round };

const summary = summarise(run, readFileSync(stream, "utf8"), diff);
writeFileSync(join(out, "round.json"), `${JSON.stringify(run, null, 2)}\n`);
writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
execFileSync("git", ["-C", root, "worktree", "remove", "--force", tree], { stdio: "ignore" });
