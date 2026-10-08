import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { episodeAt } from "./episode.ts";
import { makeEpisodeDirectory } from "./state-directory.ts";

function worktreeFor(t: TestContext): string {
  const worktree = mkdtempSync(join(tmpdir(), "squiz-state-directory-"));
  t.after(() => rmSync(worktree, { recursive: true, force: true }));
  return worktree;
}

test("making an episode's directory leaves .squiz/.gitignore holding * and nothing else beside the episode", (t) => {
  const worktree = worktreeFor(t);

  makeEpisodeDirectory(episodeAt(worktree, 41));

  assert.equal(readFileSync(join(worktree, ".squiz", ".gitignore"), "utf8"), "*\n");
  assert.deepEqual(readdirSync(join(worktree, ".squiz")).sort(), [".gitignore", "41"]);
});

test("a .squiz/ made before squiz ignored it itself gains the .gitignore on the next episode's directory", (t) => {
  const worktree = worktreeFor(t);
  mkdirSync(join(worktree, ".squiz", "38"), { recursive: true });

  makeEpisodeDirectory(episodeAt(worktree, 38));

  assert.equal(readFileSync(join(worktree, ".squiz", ".gitignore"), "utf8"), "*\n");
});

test("a .gitignore in .squiz/ that someone else wrote is left as it is", (t) => {
  const worktree = worktreeFor(t);
  mkdirSync(join(worktree, ".squiz"));
  writeFileSync(join(worktree, ".squiz", ".gitignore"), "*\n!keep.md\n");

  makeEpisodeDirectory(episodeAt(worktree, 41));

  assert.equal(readFileSync(join(worktree, ".squiz", ".gitignore"), "utf8"), "*\n!keep.md\n");
});

/**
 * Each racer makes an episode's directory in every worktree it is given, each at
 * a moment of its own that every racer spins toward, so they all reach the same
 * worktree within the same millisecond. It prints one line per failure.
 */
function racer(worktrees: readonly string[], pullRequest: number, at: number): Promise<string> {
  const module = pathToFileURL(join(import.meta.dirname, "state-directory.ts")).href;
  const episodes = pathToFileURL(join(import.meta.dirname, "episode.ts")).href;
  const script = [
    `import { makeEpisodeDirectory } from ${JSON.stringify(module)};`,
    `import { episodeAt } from ${JSON.stringify(episodes)};`,
    `const worktrees = ${JSON.stringify(worktrees)};`,
    `for (const [index, worktree] of worktrees.entries()) {`,
    `  while (Date.now() < ${at} + index * 20);`,
    `  try { makeEpisodeDirectory(episodeAt(worktree, ${pullRequest})); }`,
    `  catch (error) { process.stdout.write(worktree + ": " + error.message + "\\n"); }`,
    `}`,
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  let printed = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (printed += chunk));
  return new Promise((resolve) => child.once("exit", (code) => resolve(`exit ${code}${printed === "" ? "" : `\n${printed}`}`)));
}

test("writers making .squiz/ in the same worktree at once all succeed, and leave one .gitignore holding *", { timeout: 60_000 }, async (t) => {
  const worktrees = Array.from({ length: 30 }, () => worktreeFor(t));
  // Far enough ahead that every racer has loaded and is spinning toward it.
  const at = Date.now() + 1_500;

  const ended = await Promise.all([41, 41, 42, 43].map((pullRequest) => racer(worktrees, pullRequest, at)));

  assert.deepEqual(ended, ["exit 0", "exit 0", "exit 0", "exit 0"]);
  for (const worktree of worktrees) {
    const states = join(worktree, ".squiz");
    assert.equal(readFileSync(join(states, ".gitignore"), "utf8"), "*\n", `${states}/.gitignore`);
    assert.deepEqual(readdirSync(states).sort(), [".gitignore", "41", "42", "43"], `${states} holds something no writer meant to leave`);
  }
});
