/**
 * One contender in the head tests' race, run as a process of its own, since a
 * build's index copy is named for its process.
 *
 * It takes a worktree, a base and a moment in epoch
 * milliseconds. It spins until that moment, so that every contender builds at
 * once, then builds the head and prints the outcome as JSON.
 */

import { deadlineIn } from "../reviewers/deadline.ts";
import { buildHead } from "../venues/local/head.ts";

const [worktree = "", base = "", at = "0"] = process.argv.slice(2);
while (Date.now() < Number(at));
process.stdout.write(`${JSON.stringify(buildHead(worktree, base, deadlineIn(30_000)))}\n`);
