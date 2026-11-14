import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";

import { defaultConfig } from "../config/config.ts";
import { runHost } from "../host/host.ts";
import { trigger } from "../host/trigger.ts";
import { runReview } from "../review/review.ts";
import { collectStatus } from "../review/status.ts";
import { deadlineIn } from "../reviewers/deadline.ts";
import { githubVenue } from "../venues/github/venue.ts";
import type { Change, Venue } from "../venues/venue.ts";
import { episodeAt, type Episode } from "./episode.ts";
import { readState } from "./episode-state.ts";

const worktree = join(sep, "worktrees", "feature-a");

function found(lookup: ReturnType<typeof episodeAt>): Episode {
  if (lookup.outcome !== "found") assert.fail(`no episode was found: ${lookup.reason}`);
  return lookup.episode;
}

test("everything an episode owns hangs off the directory the venue names for its key", () => {
  const directory = join(worktree, ".squiz", "41");
  assert.deepEqual(found(episodeAt(githubVenue, worktree, "41")), {
    worktree,
    key: "41",
    directory,
    stateFile: join(directory, "state.json"),
  });
});

test("a key the venue gives no directory is no episode, with the venue's reason", () => {
  assert.deepEqual(episodeAt(githubVenue, worktree, "../x"), {
    outcome: "failed",
    reason: `"../x" is not a pull request number`,
  });
});

test("two subagents' firings on one pull request open the same episode", () => {
  // Nothing about the subagent reaches the key, so a second one that stops on the
  // same pull request in the same worktree reads and writes the first one's state.
  assert.deepEqual(episodeAt(githubVenue, worktree, "41"), episodeAt(githubVenue, worktree, "41"));
});

test("two pull requests in one worktree hold their state apart", () => {
  const one = found(episodeAt(githubVenue, worktree, "41"));
  const other = found(episodeAt(githubVenue, worktree, "42"));
  assert.notEqual(one.directory, other.directory);
  assert.notEqual(one.stateFile, other.stateFile);
});

test("one pull request in two worktrees is two episodes", () => {
  const other = join(sep, "worktrees", "feature-b");
  assert.notEqual(found(episodeAt(githubVenue, worktree, "41")).directory, found(episodeAt(githubVenue, other, "41")).directory);
});

/**
 * A venue whose one key, `k41`, is no number, and whose episode directory is
 * one no caller could build from a number. A caller that named the directory
 * itself reaches somewhere else, or nowhere.
 */
function oneKeyVenue(tree: string, head: string, asked: { key: string; worktree: string }[]): Venue {
  const change: Change = {
    key: "k41",
    name: "the k41 change",
    rerun: "squiz review k41",
    summaryAt: "on the pull request",
    followUp: "Fix it.",
    fixerFollowUp: "Fix it.",
    base: head,
    head,
    description: "",
  };
  const refuse = (): { outcome: "failed"; reason: string } => ({ outcome: "failed", reason: "not asked of this venue" });
  return {
    recordStart: refuse,
    recordPrompt: refuse,
    readChange: () => ({ outcome: "found", change }),
    episodeDirectory: (where, key) => {
      asked.push({ key, worktree: where });
      return key === "k41" ? { outcome: "found", directory: join(where, ".squiz", "k41") } : { outcome: "failed", reason: `no ${key} here` };
    },
    provideCommits: () => ({ outcome: "ready", alternates: [] }),
    listThreads: () => ({ outcome: "listed", threads: [] }),
    openThread: refuse,
    openFileThread: refuse,
    reply: refuse,
    resolve: refuse,
    reopen: refuse,
    postSummary: refuse,
    postFailure: refuse,
  };
}

test("the hook's trigger, squiz review's wait, squiz status and the round host all reach the directory the venue names for one key (#792)", async () => {
  const tree = realpathSync(mkdtempSync(join(tmpdir(), "squiz-episode-")));
  try {
    const git = (...args: string[]): string => execFileSync("git", args, { cwd: tree, encoding: "utf8" }).trim();
    git("init", "--quiet");
    git("-c", "user.email=squiz@example.invalid", "-c", "user.name=Squiz", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "--message", "one");
    const head = git("rev-parse", "HEAD");
    const asked: { key: string; worktree: string }[] = [];
    const venue = oneKeyVenue(tree, head, asked);
    const directory = join(tree, ".squiz", "k41");
    const hostKeys: string[] = [];
    // A host that exits at once, so the state stays queued for the others to find.
    const host = (key: string) => {
      hostKeys.push(key);
      return { command: process.execPath, args: ["-e", ""] };
    };

    const hooked = trigger({ directory: tree, trigger: "hook", venue, environment: {}, until: deadlineIn(30_000), host });
    assert.equal(hooked.outcome, "decided", JSON.stringify(hooked));
    assert.equal(hooked.outcome === "decided" ? hooked.episode.directory : "", directory, "the hook queued somewhere else");
    assert.ok(existsSync(join(directory, "state.json")), "the hook wrote no state where the venue named");
    assert.deepEqual(hostKeys, ["k41"], "the host was not started for the key");

    const reviewed = await runReview({ directory: tree, key: "k41", venue, environment: {}, until: deadlineIn(1_500), pollMs: 50, host });
    assert.equal(reviewed.exit, 4, `${reviewed.stdout}${reviewed.stderr}`);
    assert.equal(
      reviewed.stdout.split("\n")[0],
      `Full output, to read where this is cut short: ${join(directory, "review.txt")}`,
      "squiz review waited on another directory",
    );
    assert.ok(existsSync(join(directory, "review.txt")));

    const status = collectStatus([tree], { main: tree, presence: () => ({ outcome: "gone" }), now: 0, venue });
    assert.deepEqual(status.problems, []);
    assert.deepEqual(status.episodes.map((episode) => episode.rows[0]?.row[0]), ["k41"], "squiz status did not list the episode");

    const hosted = await runHost({
      worktree: tree,
      key: "k41",
      round: {
        venue: { ...venue, readChange: () => ({ outcome: "none", reason: "the change has gone" }) },
        config: defaultConfig,
        adapter: { argv: () => assert.fail("no reviewer runs"), confine: () => assert.fail("no reviewer runs"), parse: () => assert.fail("no reviewer runs"), grants: [] },
        charterFile: join(tree, "charter.md"),
      },
    });
    assert.deepEqual(hosted, { outcome: "nothing queued" });
    assert.match(readFileSync(join(directory, "host.log"), "utf8"), /round 1: /u, "the host ran its round from another directory");
    const after = readState(found(episodeAt(venue, tree, "k41")));
    assert.ok(after.outcome === "read" && after.state.records?.[0]?.status === "failed", JSON.stringify(after));

    // squiz status asks about every entry in `.squiz/`, and `.gitignore` is one.
    const keys = asked.filter((call) => call.key !== ".gitignore").map((call) => `${call.worktree} ${call.key}`);
    assert.deepEqual(new Set(keys), new Set([`${tree} k41`]), "a caller asked for another key or worktree");
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});
