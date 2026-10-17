/**
 * `squiz host` as a process, run in a linked worktree with nothing queued, so
 * that which `.squiz.json` it read is told from its stderr and its `host.log`
 * alone.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const binary = fileURLToPath(new URL("../../bin/squiz", import.meta.url));

/**
 * A main worktree holding `mainJson` as its `.squiz.json`, or none where it is
 * null, and a linked worktree holding `linkedJson`.
 */
function linkedPair(mainJson: string | null, linkedJson: string): { main: string; linked: string; base: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "squiz-host-command-")));
  const main = join(base, "main");
  const linked = join(base, "linked");
  mkdirSync(main);
  for (const args of [
    ["init", "--quiet"],
    ["commit", "--quiet", "--allow-empty", "-m", "first"],
    ["worktree", "add", "--quiet", "--detach", linked],
  ]) {
    const ran = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: main, encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
  }
  if (mainJson !== null) writeFileSync(join(main, ".squiz.json"), mainJson);
  writeFileSync(join(linked, ".squiz.json"), linkedJson);
  return { main, linked, base };
}

function host(directory: string): { status: number | null; stderr: string; log: string } {
  const ran = spawnSync(binary, ["host", "41"], { cwd: directory, encoding: "utf8", timeout: 30_000 });
  const logFile = join(directory, ".squiz", "41", "host.log");
  return { status: ran.status, stderr: ran.stderr, log: existsSync(logFile) ? readFileSync(logFile, "utf8") : "" };
}

test("#745: a round host in a linked worktree reads the main worktree's .squiz.json, never its own", () => {
  const pair = linkedPair('{"reviewer": "claude"}', '{"reviewer": "pi"}');
  try {
    const ran = host(pair.linked);

    assert.equal(ran.status, 0);
    assert.equal(
      ran.stderr,
      `squiz: no round host started: ${join(pair.main, ".squiz.json")}: "reviewer" is "claude", but it must be "pi" or "copilot"\n`,
    );
  } finally {
    rmSync(pair.base, { recursive: true, force: true });
  }
});

test("#745: a round host whose main worktree has no .squiz.json says in host.log that the defaults are in use", () => {
  const pair = linkedPair(null, '{"reviewer": "copilot"}');
  try {
    const ran = host(pair.linked);

    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stderr, "");
    assert.match(
      ran.log,
      new RegExp(`^\\S+ no \\.squiz\\.json was found in the main worktree, ${pair.main}, so the defaults are in use$`, "mu"),
      "the host must say it in host.log, and only there",
    );
  } finally {
    rmSync(pair.base, { recursive: true, force: true });
  }
});
