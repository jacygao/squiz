import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { deadlineIn } from "../../reviewers/deadline.ts";
import { standIn } from "../../testing/stand-in.ts";
import type { Change } from "../venue.ts";
import { FIXER_FOLLOW_UP, githubVenue } from "./venue.ts";

/** One answer of the fake `gh`: what it prints, and how it exits. */
type Answer = { readonly stdout?: string; readonly stderr?: string; readonly status?: number };

type Fake = {
  /** How many times `gh` ran. */
  readonly calls: () => number;
  /** The arguments the nth call was given, counting from one. */
  readonly argumentsAt: (nth: number) => readonly string[];
  /** What the nth call read on stdin. */
  readonly stdinAt: (nth: number) => string;
  /** Where the nth call ran. */
  readonly directoryAt: (nth: number) => string;
};

/**
 * Run `body` with a `gh` on `PATH` that gives `answers` in order, one a call.
 *
 * A call past the last answer fails loudly, so a member that makes one call too
 * many is seen doing it.
 */
async function withFakeGh<T>(answers: readonly Answer[], body: (gh: Fake) => Promise<T> | T): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-venue-gh-"));
  const previous = process.env["PATH"];
  try {
    for (const [index, answer] of answers.entries()) {
      const nth = index + 1;
      await writeFile(join(directory, `stdout.${nth}`), answer.stdout ?? "", "utf8");
      await writeFile(join(directory, `stderr.${nth}`), answer.stderr ?? "", "utf8");
      await writeFile(join(directory, `status.${nth}`), String(answer.status ?? 0), "utf8");
    }
    const at = quote(directory);
    standIn(
      directory,
      "gh",
      [
        "#!/bin/sh",
        `count=$(cat ${at}/count 2>/dev/null || echo 0)`,
        "count=$((count + 1))",
        `printf '%s' "$count" > ${at}/count`,
        `for argument in "$@"; do printf '%s\\n' "$argument" >> ${at}/arguments.$count; done`,
        `pwd -P > ${at}/cwd.$count`,
        `cat > ${at}/stdin.$count`,
        `if [ ! -f ${at}/stdout.$count ]; then echo "gh ran $count times, which the fixture has no answer for" >&2; exit 9; fi`,
        `cat ${at}/stdout.$count`,
        `cat ${at}/stderr.$count >&2`,
        `exit "$(cat ${at}/status.$count)"`,
        "",
      ].join("\n"),
    );
    process.env["PATH"] = `${directory}:${previous ?? ""}`;
    return await body({
      calls: () => Number.parseInt(read(join(directory, "count")) || "0", 10),
      argumentsAt: (nth) => read(join(directory, `arguments.${nth}`)).split("\n").filter((line) => line !== ""),
      stdinAt: (nth) => read(join(directory, `stdin.${nth}`)),
      directoryAt: (nth) => read(join(directory, `cwd.${nth}`)).trim(),
    });
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

function git(directory: string, ...args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A repository with one commit, on branch `feature`, and that commit's sha. */
async function withRepository<T>(body: (worktree: string, commit: string) => Promise<T> | T): Promise<T> {
  const worktree = await realpath(await mkdtemp(join(tmpdir(), "squiz-venue-repo-")));
  try {
    git(worktree, "init", "--quiet", "--initial-branch=feature");
    git(worktree, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "one");
    return await body(worktree, git(worktree, "rev-parse", "HEAD"));
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
}

const HEAD = "3a1937e729dbab0f618ef761c833a7e2d3675b80";
const BASE = "dd5609879f5cdef406c312f7398d387a85459139";
const NODE_ID = "PR_kwDOUEd2qM8AAAABDNPXSA";

/** A row of `gh pr list --json`, as the lookup asks for one. */
function pullRequestRow(fields: Readonly<Record<string, unknown>> = {}): Answer {
  const row = {
    number: 142,
    id: NODE_ID,
    baseRefName: "main",
    headRefName: "feature",
    headRefOid: HEAD,
    baseRefOid: BASE,
    body: "## Intent\n\nWhat this is for.",
    isDraft: false,
    ...fields,
  };
  return { stdout: `${JSON.stringify([row])}\n` };
}

/** A response as `gh api --include` writes one. */
function api(status: number, value: unknown): Answer {
  return { stdout: `HTTP/2.0 ${status} OK\nContent-Type: application/json\r\n\r\n${JSON.stringify(value)}` };
}

/** A `gh api` that exited on an HTTP error. */
function apiError(status: number, value: unknown, said: string): Answer {
  return { ...api(status, value), stderr: `gh: ${said} (HTTP ${status})\n`, status: 1 };
}

const followUp = [
  "Fix what applies, and reply on each thread with `squiz reply <id> <text>` to say",
  "what you changed or why you disagree. Commit and push what you changed, then run",
  "`squiz review 142` again.",
].join("\n");

/** The change `readChange` finds for the fixture's pull request, failing the test where it finds none. */
function readFound(worktree: string, asked: string | null = null): Change {
  const lookup = githubVenue.readChange(worktree, asked, deadlineIn(10_000));
  if (lookup.outcome !== "found") assert.fail(`no change was found: ${JSON.stringify(lookup)}`);
  return lookup.change;
}

/** A change this venue did not read, as a test or a caller might build one. */
const foreign: Change = {
  key: "142",
  name: "PR #142",
  rerun: "squiz review 142",
  summaryAt: "on the pull request",
  followUp,
  fixerFollowUp: FIXER_FOLLOW_UP,
  base: BASE,
  head: HEAD,
  description: "",
};

test("readChange finds the open pull request whose head the worktree has checked out", async () => {
  await withRepository(async (worktree) => {
    await withFakeGh([pullRequestRow()], (gh) => {
      const change = readFound(worktree);

      assert.equal(change.key, "142");
      assert.equal(change.name, "PR #142");
      assert.equal(change.rerun, "squiz review 142");
      // A note can reach a session in another worktree, and a G id names a thread only on this worktree's pull request (#889).
      assert.equal(
        change.followUp,
        [
          `Fix what applies in ${worktree}, and reply on each thread with`,
          `\`(cd '${worktree}' && squiz reply <id> <text>)\` to say what you changed or why`,
          "you disagree. Commit and push what you changed, then run `squiz review 142` again.",
        ].join("\n"),
      );
      assert.equal(change.fixerFollowUp, FIXER_FOLLOW_UP);
      assert.equal(change.base, BASE);
      assert.equal(change.head, HEAD);
      assert.equal(change.description, "## Intent\n\nWhat this is for.");
      assert.ok(gh.argumentsAt(1).includes("--head"), "the lookup names the branch as the head");
      assert.ok(gh.argumentsAt(1).includes("feature"));
      assert.equal(gh.directoryAt(1), worktree);
    });
  });
});

/** `body` with the fixture's repository given a remote it has pushed `feature` to, so that `@{push}` names its commit. */
async function withPushedRepository<T>(body: (worktree: string, pushed: string) => Promise<T> | T): Promise<T> {
  return withRepository(async (worktree, commit) => {
    const remote = `${worktree}.remote.git`;
    try {
      git(worktree, "init", "--quiet", "--bare", remote);
      git(worktree, "remote", "add", "origin", remote);
      git(worktree, "push", "--quiet", "--set-upstream", "origin", "feature");
      return await body(worktree, commit);
    } finally {
      await rm(remote, { recursive: true, force: true });
    }
  });
}

function commitIn(worktree: string, message: string): string {
  git(worktree, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", message);
  return git(worktree, "rev-parse", "HEAD");
}

test("#852: readChange names the commit the worktree pushed where the pull request's head is still the one before it", async () => {
  await withPushedRepository(async (worktree, reported) => {
    const pushed = commitIn(worktree, "two");
    git(worktree, "push", "--quiet");
    await withFakeGh([pullRequestRow({ headRefOid: reported })], () => {
      const change = readFound(worktree);

      assert.equal(change.head, reported);
      assert.equal(change.unreported, pushed);
    });
  });
});

test("#852: readChange names the commit a force-push left where the pull request's head is still the commit it replaced", async () => {
  await withPushedRepository(async (worktree, reported) => {
    git(worktree, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--amend", "--allow-empty", "-m", "one, again");
    const pushed = git(worktree, "rev-parse", "HEAD");
    git(worktree, "push", "--quiet", "--force");
    await withFakeGh([pullRequestRow({ headRefOid: reported })], () => {
      assert.equal(readFound(worktree).unreported, pushed);
    });
  });
});

const reportedAsItIs: readonly [string, (worktree: string, pushed: string) => string][] = [
  [
    "the worktree has commits it has not pushed",
    (worktree, pushed) => {
      commitIn(worktree, "not pushed");
      return pushed;
    },
  ],
  ["someone else pushed a commit this repository does not have", () => HEAD],
  [
    "the pull request's head is past the commit the worktree last pushed or fetched",
    (worktree) => {
      const later = commitIn(worktree, "pushed from elsewhere");
      git(worktree, "reset", "--quiet", "--hard", "HEAD~1");
      return later;
    },
  ],
];

for (const [when, arrange] of reportedAsItIs) {
  test(`#852: readChange names no unreported commit where ${when}`, async () => {
    await withPushedRepository(async (worktree, pushed) => {
      const reported = arrange(worktree, pushed);
      await withFakeGh([pullRequestRow({ headRefOid: reported })], () => {
        const change = readFound(worktree);

        assert.equal(change.head, reported);
        assert.equal("unreported" in change, false, `an unreported commit was named: ${JSON.stringify(change)}`);
      });
    });
  });
}

test("#852: readChange fails, rather than finding the head GitHub reports, where its deadline passes before the push is compared with it", async () => {
  await withPushedRepository(async (worktree, reported) => {
    commitIn(worktree, "two");
    git(worktree, "push", "--quiet");
    await withFakeGh([pullRequestRow({ headRefOid: reported })], (gh) => {
      const spent = (): boolean => gh.calls() > 0;
      const until = { ...deadlineIn(10_000), passed: spent, remaining: () => (spent() ? 0 : 10_000) };

      const lookup = githubVenue.readChange(worktree, null, until);

      assert.deepEqual(lookup, {
        outcome: "failed",
        reason: "whether PR #142's head has this worktree's push could not be told: git ran out of the time it was given",
      });
    });
  });
});

test("#852: readChange names no unreported commit for a branch that has no push destination", async () => {
  await withRepository(async (worktree) => {
    const reported = commitIn(worktree, "two");
    commitIn(worktree, "three");
    await withFakeGh([pullRequestRow({ headRefOid: reported })], () => {
      assert.equal("unreported" in readFound(worktree), false);
    });
  });
});

test("readChange finds the pull request asked for by its number", async () => {
  await withRepository(async (worktree) => {
    await withFakeGh([pullRequestRow()], () => {
      assert.equal(readFound(worktree, "142").key, "142");
    });
  });
});

test("readChange holds a draft, with the line squiz review prints for one", async () => {
  await withRepository(async (worktree) => {
    await withFakeGh([pullRequestRow({ isDraft: true })], () => {
      assert.deepEqual(githubVenue.readChange(worktree, null, deadlineIn(10_000)), {
        outcome: "held",
        line: "PR #142 is a draft. Squiz reviews it once it is marked ready for review, so there is nothing to wait for.",
      });
    });
  });
});

test("readChange is none where no open pull request has the branch as its head", async () => {
  await withRepository(async (worktree) => {
    await withFakeGh([{ stdout: "[]\n" }], () => {
      assert.deepEqual(githubVenue.readChange(worktree, null, deadlineIn(10_000)), {
        outcome: "none",
        reason: `no open pull request has "feature" as its head, in ${JSON.stringify(worktree)}`,
      });
    });
  });
});

test("readChange is none where the number asked for is not the branch's pull request", async () => {
  await withRepository(async (worktree) => {
    await withFakeGh([pullRequestRow()], () => {
      assert.deepEqual(githubVenue.readChange(worktree, "41", deadlineIn(10_000)), {
        outcome: "none",
        reason: `PR #41 is not the open pull request whose head is "feature", which ${JSON.stringify(worktree)} has checked out: that is PR #142`,
      });
    });
  });
});

test("readChange is none where the key asked for is no pull request number, and asks nothing of GitHub", async () => {
  await withRepository(async (worktree) => {
    await withFakeGh([], (gh) => {
      assert.deepEqual(githubVenue.readChange(worktree, "/work/squiz", deadlineIn(10_000)), {
        outcome: "none",
        reason: `"/work/squiz" is not a pull request number`,
      });
      assert.equal(gh.calls(), 0);
    });
  });
});

test("readChange is none on a detached HEAD", async () => {
  await withRepository(async (worktree, commit) => {
    git(worktree, "checkout", "--quiet", "--detach", commit);
    await withFakeGh([], (gh) => {
      assert.deepEqual(githubVenue.readChange(worktree, null, deadlineIn(10_000)), {
        outcome: "none",
        reason: `HEAD is detached in ${JSON.stringify(worktree)}, so no pull request has it as its head`,
      });
      assert.equal(gh.calls(), 0, "nothing is asked of GitHub for a detached HEAD");
    });
  });
});

test("readChange fails, with gh's reason, where the lookup could not be made", async () => {
  await withRepository(async (worktree) => {
    await withFakeGh([{ stderr: "HTTP 401: Bad credentials\n", status: 1 }], () => {
      assert.deepEqual(githubVenue.readChange(worktree, null, deadlineIn(10_000)), {
        outcome: "failed",
        reason: `the pull request for "feature" could not be looked up: gh exited 1: HTTP 401: Bad credentials`,
      });
    });
  });
});

test("readChange fails, with git's reason, where the branch could not be resolved", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "squiz-venue-norepo-")));
  try {
    await withFakeGh([], () => {
      const lookup = githubVenue.readChange(directory, null, deadlineIn(10_000));
      assert.equal(lookup.outcome, "failed");
      assert.match(
        lookup.outcome === "failed" ? lookup.reason : "",
        /^the current branch could not be resolved: git exited 128: fatal: not a git repository/u,
      );
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("episodeDirectory is .squiz/<key>/ in the worktree for a pull request's number, found before any change is read, and runs no gh", async () => {
  await withFakeGh([], (gh) => {
    assert.deepEqual(githubVenue.episodeDirectory("/work/squiz", "142"), {
      outcome: "found",
      directory: "/work/squiz/.squiz/142",
    });
    assert.equal(gh.calls(), 0, "naming the directory asked GitHub something");
  });
});

test("episodeDirectory fails for every key that is no pull request's number, makes nothing, and runs no gh", async () => {
  await withRepository(async (worktree) => {
    await withFakeGh([], (gh) => {
      for (const key of ["abc", "../x", "../..", "0", "041", "-1", "1e3", "4.2", "", " 41", "41/", "/work/squiz", "9007199254740993"]) {
        assert.deepEqual(
          githubVenue.episodeDirectory(worktree, key),
          { outcome: "failed", reason: `${JSON.stringify(key)} is not a pull request number` },
          `the key ${JSON.stringify(key)} was given a directory`,
        );
      }
      assert.equal(gh.calls(), 0);
      assert.equal(existsSync(join(worktree, ".squiz")), false, "a key that names no episode made .squiz/");
    });
  });
});

test("provideCommits is ready with no alternates where the repository has both commits", async () => {
  await withRepository(async (worktree, commit) => {
    await withFakeGh([pullRequestRow({ headRefOid: commit, baseRefOid: commit })], (gh) => {
      const change = readFound(worktree);
      assert.deepEqual(githubVenue.provideCommits(change, deadlineIn(10_000)), { outcome: "ready", alternates: [] });
      assert.equal(gh.calls(), 1, "providing commits the repository has asks nothing of GitHub");
    });
  });
});

test("provideCommits fails, saying why, where a missing commit could not be fetched", async () => {
  await withRepository(async (worktree, commit) => {
    await withFakeGh([pullRequestRow({ headRefOid: HEAD, baseRefOid: commit })], () => {
      const provided = githubVenue.provideCommits(readFound(worktree), deadlineIn(10_000));
      assert.equal(provided.outcome, "failed");
      assert.match(
        provided.outcome === "failed" ? provided.reason : "",
        new RegExp(`^${HEAD} could not be fetched: git exited 128: fatal: 'origin' does not appear to be a git repository`, "u"),
      );
    });
  });
});

test("provideCommits fails on a commit that is not a full sha", () => {
  const provided = githubVenue.provideCommits({ ...foreign, head: "main" }, deadlineIn(10_000));
  assert.deepEqual(provided, { outcome: "failed", reason: `"main" is not a full commit name` });
});

test("listThreads lists the pull request's threads by the node id it was read with", async () => {
  await withRepository(async (worktree) => {
    const page = api(200, { data: { node: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    await withFakeGh([pullRequestRow(), page, conversation([])], (gh) => {
      const listed = githubVenue.listThreads(readFound(worktree), deadlineIn(10_000));
      assert.deepEqual(listed, { outcome: "listed", threads: [] });
      assert.equal(JSON.parse(gh.stdinAt(2)).variables.pullRequest, NODE_ID);
      assert.equal(gh.calls(), 3, "a change read here carries its node id, so none is looked up");
    });
  });
});

test("listThreads looks the node id up for a change it did not read", async () => {
  const page = api(200, { data: { node: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
  await withFakeGh([api(200, { node_id: NODE_ID }), page, conversation([])], (gh) => {
    assert.deepEqual(githubVenue.listThreads(foreign, deadlineIn(10_000)), { outcome: "listed", threads: [] });
    assert.ok(gh.argumentsAt(1).includes("repos/{owner}/{repo}/pulls/142"));
    assert.equal(JSON.parse(gh.stdinAt(2)).variables.pullRequest, NODE_ID);
  });
});

test("listThreads fails, with gh's reason, where the threads could not be listed", async () => {
  await withRepository(async (worktree) => {
    await withFakeGh([pullRequestRow(), { stderr: "connection reset\n", status: 1 }], () => {
      assert.deepEqual(githubVenue.listThreads(readFound(worktree), deadlineIn(10_000)), {
        outcome: "failed",
        reason: "gh exited 1: connection reset",
      });
    });
  });
});

test("listThreads fails where GitHub's answer is not a list of threads", async () => {
  await withRepository(async (worktree) => {
    await withFakeGh([pullRequestRow(), api(200, { data: { node: null } })], () => {
      const listed = githubVenue.listThreads(readFound(worktree), deadlineIn(10_000));
      assert.equal(listed.outcome, "failed");
      assert.notEqual(listed.outcome === "failed" ? listed.reason : "", "");
    });
  });
});

test("listThreads fails, with the reason, where the node id of a change it did not read could not be found", async () => {
  await withFakeGh([apiError(404, { message: "Not Found" }, "Not Found")], () => {
    assert.deepEqual(githubVenue.listThreads(foreign, deadlineIn(10_000)), {
      outcome: "failed",
      reason: "gh exited 1 on HTTP 404: gh: Not Found (HTTP 404)",
    });
  });
});

const created = {
  id: 3993908108,
  node_id: "PRRC_kwDOUEd2qM7uDjOM",
  html_url: "https://github.com/jacygao/squiz/pull/142#discussion_r3993908108",
};
const threadFound = api(200, {
  data: {
    node: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: "x" },
          nodes: [{ id: "PRRT_kwDOUEd2qM6hqHeq", comments: { nodes: [{ databaseId: 3993908108 }] } }],
        },
      },
    },
  },
});

test("openThread posts on the pull request's head, on the line asked for", async () => {
  await withFakeGh([api(201, created), threadFound], (gh) => {
    const posted = githubVenue.openThread(foreign, { path: "a.ts", line: 7, side: "RIGHT" }, "the finding", deadlineIn(10_000));
    assert.deepEqual(posted, {
      outcome: "posted",
      threadId: "PRRT_kwDOUEd2qM6hqHeq",
      commentId: "3993908108",
      url: created.html_url,
    });
    assert.ok(gh.argumentsAt(1).includes("repos/{owner}/{repo}/pulls/142/comments"));
    assert.deepEqual(JSON.parse(gh.stdinAt(1)), { body: "the finding", commit_id: HEAD, path: "a.ts", line: 7, side: "RIGHT" });
  });
});

test("openThread returns a comment whose thread could not be read back as posted-without-thread-id, with a string comment id", async () => {
  const noThread = api(200, {
    data: { node: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: "x" }, nodes: [] } } } },
  });
  await withFakeGh([api(201, created), noThread], () => {
    assert.deepEqual(githubVenue.openThread(foreign, { path: "a.ts", line: 7, side: "RIGHT" }, "the finding", deadlineIn(10_000)), {
      outcome: "posted-without-thread-id",
      reason: "GitHub listed no thread that this comment opened",
      commentId: "3993908108",
      url: created.html_url,
    });
  });
});

test("openThread returns a refused anchor as anchor-refused, with GitHub's reason", async () => {
  const refused = apiError(
    422,
    { message: "Validation Failed", errors: [{ field: "pull_request_review_thread.line", message: "could not be resolved" }] },
    "Validation Failed",
  );
  await withFakeGh([refused], () => {
    assert.deepEqual(githubVenue.openThread(foreign, { path: "a.ts", line: 7, side: "RIGHT" }, "the finding", deadlineIn(10_000)), {
      outcome: "anchor-refused",
      reason: "GitHub would not anchor a comment to a.ts:7: line could not be resolved",
    });
  });
});

test("openFileThread posts on the file as a whole", async () => {
  await withFakeGh([api(201, created), threadFound], (gh) => {
    const posted = githubVenue.openFileThread(foreign, "a.ts", "the finding", deadlineIn(10_000));
    assert.equal(posted.outcome, "posted");
    assert.deepEqual(JSON.parse(gh.stdinAt(1)), { body: "the finding", commit_id: HEAD, path: "a.ts", subject_type: "file" });
  });
});

test("openFileThread fails, with gh's reason, where GitHub could not be reached", async () => {
  await withFakeGh([{ stderr: "connection reset\n", status: 1 }], () => {
    assert.deepEqual(githubVenue.openFileThread(foreign, "a.ts", "the finding", deadlineIn(10_000)), {
      outcome: "failed",
      reason: "gh exited 1: connection reset",
    });
  });
});

const resolvedAs = (field: string, isResolved: boolean): Answer => api(200, { data: { [field]: { thread: { isResolved } } } });

test("reply, resolve and reopen act on the thread their id names", async () => {
  await withFakeGh(
    [api(200, { data: { addPullRequestReviewThreadReply: { comment: { databaseId: 1 } } } }), resolvedAs("resolveReviewThread", true), resolvedAs("unresolveReviewThread", false)],
    (gh) => {
      const until = deadlineIn(10_000);
      assert.deepEqual(githubVenue.reply("PRRT_a", "fixed", until), { outcome: "acted" });
      assert.deepEqual(githubVenue.resolve("PRRT_a", until), { outcome: "acted" });
      assert.deepEqual(githubVenue.reopen("PRRT_a", until), { outcome: "acted" });
      for (const nth of [1, 2, 3]) assert.equal(JSON.parse(gh.stdinAt(nth)).variables.threadId, "PRRT_a");
      assert.equal(JSON.parse(gh.stdinAt(1)).variables.body, "fixed");
    },
  );
});

test("reply, resolve and reopen fail, each with its reason", async () => {
  await withFakeGh(
    [{ stderr: "connection reset\n", status: 1 }, resolvedAs("resolveReviewThread", false), resolvedAs("unresolveReviewThread", true)],
    () => {
      const until = deadlineIn(10_000);
      assert.deepEqual(githubVenue.reply("PRRT_a", "fixed", until), { outcome: "failed", reason: "gh exited 1: connection reset" });
      const resolved = githubVenue.resolve("PRRT_a", until);
      assert.equal(resolved.outcome, "failed");
      assert.match(resolved.outcome === "failed" ? resolved.reason : "", /^GitHub did not report the thread resolved: /u);
      const reopened = githubVenue.reopen("PRRT_a", until);
      assert.match(reopened.outcome === "failed" ? reopened.reason : "", /^GitHub did not report the thread open: /u);
    },
  );
});

test("postSummary and postFailure post an issue-level comment on the pull request", async () => {
  await withFakeGh([api(201, { id: 1 }), api(201, { id: 2 })], (gh) => {
    const until = deadlineIn(10_000);
    assert.deepEqual(githubVenue.postSummary(foreign, "the summary", until), { outcome: "posted" });
    assert.deepEqual(githubVenue.postFailure(foreign, "the failure", until), { outcome: "posted" });
    for (const nth of [1, 2]) assert.ok(gh.argumentsAt(nth).includes("repos/{owner}/{repo}/issues/142/comments"));
    assert.deepEqual(JSON.parse(gh.stdinAt(1)), { body: "the summary" });
    assert.deepEqual(JSON.parse(gh.stdinAt(2)), { body: "the failure" });
  });
});

test("postSummary and postFailure fail, each naming what was not posted", async () => {
  await withFakeGh([api(302, {}), api(302, {})], () => {
    const until = deadlineIn(10_000);
    assert.deepEqual(githubVenue.postSummary(foreign, "the summary", until), {
      outcome: "failed",
      reason: "gh answered HTTP 302 without posting the summary",
    });
    assert.deepEqual(githubVenue.postFailure(foreign, "the failure", until), {
      outcome: "failed",
      reason: "gh answered HTTP 302 without posting the failure",
    });
  });
});

test("a member whose key is no pull request number fails, and asks nothing of GitHub", async () => {
  const unnumbered: Change = { ...foreign, key: "/work/squiz" };
  await withFakeGh([], (gh) => {
    const until = deadlineIn(10_000);
    const reason = `"/work/squiz" is not a pull request number`;
    assert.deepEqual(githubVenue.listThreads(unnumbered, until), { outcome: "failed", reason });
    assert.deepEqual(githubVenue.openThread(unnumbered, { path: "a.ts", line: 1, side: "RIGHT" }, "x", until), { outcome: "failed", reason });
    assert.deepEqual(githubVenue.openFileThread(unnumbered, "a.ts", "x", until), { outcome: "failed", reason });
    assert.deepEqual(githubVenue.postSummary(unnumbered, "x", until), { outcome: "failed", reason });
    assert.deepEqual(githubVenue.postFailure(unnumbered, "x", until), { outcome: "failed", reason });
    assert.equal(gh.calls(), 0);
  });
});

test("no member makes a call once its deadline has nothing left, and each fails saying so", async () => {
  await withRepository(async (worktree) => {
    await withFakeGh([], (gh) => {
      const spent = deadlineIn(0);
      const anchor = { path: "a.ts", line: 1, side: "RIGHT" } as const;
      const outcomes = {
        readChange: githubVenue.readChange(worktree, null, spent),
        provideCommits: githubVenue.provideCommits(foreign, spent),
        listThreads: githubVenue.listThreads(foreign, spent),
        openThread: githubVenue.openThread(foreign, anchor, "x", spent),
        openFileThread: githubVenue.openFileThread(foreign, "a.ts", "x", spent),
        openGeneralThread: githubVenue.openGeneralThread(foreign, "x", spent),
        reply: githubVenue.reply("PRRT_a", "x", spent),
        resolve: githubVenue.resolve("PRRT_a", spent),
        reopen: githubVenue.reopen("PRRT_a", spent),
        postSummary: githubVenue.postSummary(foreign, "x", spent),
        postFailure: githubVenue.postFailure(foreign, "x", spent),
      };
      for (const [member, outcome] of Object.entries(outcomes)) {
        assert.equal(outcome.outcome, "failed", `${member} answered ${JSON.stringify(outcome)}`);
        const reason = "reason" in outcome ? outcome.reason : "";
        assert.match(reason, /ran out/u, `${member} gave ${JSON.stringify(reason)}`);
      }
      assert.equal(gh.calls(), 0);
    });
  });
});

/** One conversation comment on the pull request, as the general listing reads it back. */
function conversationComment(id: number, body: string, fields: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  const second = String(id % 60).padStart(2, "0");
  return { id: `IC_${id}`, databaseId: id, author: { login: "squiz-bot" }, body, createdAt: `2026-11-14T10:00:${second}Z`, isMinimized: false, ...fields };
}

/** A page of the pull request's conversation comments. */
function conversation(comments: readonly unknown[], next: string | null = null): Answer {
  return api(200, { data: { node: { comments: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes: comments } } } });
}

const NO_REVIEW_THREADS = api(200, { data: { node: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });

const G1_FINDING = "**Squiz reviewer · high — The change duplicates the scheduler**\n\n- Nothing calls the scheduler.";
const G1_POSTED = `${G1_FINDING}\n\n<sub>Squiz thread G1</sub> <!-- squiz:thread G1 -->`;
const G1_REPLY = "**Squiz coding agent**\n\nThe queue now runs on the scheduler.";
const G1_REPLY_POSTED = `${G1_REPLY}\n\n> In reply to G1: **Squiz reviewer · high — The change duplicates the scheduler** <!-- squiz:reply G1 -->`;

/** Run `body` with `worktree` as the process's directory, as `squiz reply` and the round host run. */
async function inDirectory<T>(worktree: string, body: () => Promise<T> | T): Promise<T> {
  const previous = process.cwd();
  process.chdir(worktree);
  try {
    return await body();
  } finally {
    process.chdir(previous);
  }
}

test("#889: listThreads reads a finding about the change as a whole, and the replies tied to it, as one thread after the review threads", async () => {
  await withRepository(async (worktree) => {
    const comments = conversation([
      conversationComment(1, "**Squiz review — 1 round, 1 finding**\n\nFixed 0"),
      conversationComment(2, G1_POSTED, { isMinimized: true }),
      conversationComment(3, "Why does this need a scheduler at all?"),
      conversationComment(4, G1_REPLY_POSTED),
      conversationComment(5, "**Squiz coding agent**\n\nOn a thread nobody opened.\n\n> In reply to G7: x <!-- squiz:reply G7 -->"),
    ]);
    await withFakeGh([pullRequestRow(), NO_REVIEW_THREADS, comments], (gh) => {
      const listed = githubVenue.listThreads(readFound(worktree), deadlineIn(10_000));
      assert.equal(listed.outcome, "listed", JSON.stringify(listed));
      const threads = listed.outcome === "listed" ? listed.threads : [];
      assert.deepEqual(
        threads.map((thread) => ({ id: thread.id, isResolved: thread.isResolved, isOutdated: thread.isOutdated, path: thread.path, anchor: thread.anchor })),
        [{ id: "G1", isResolved: true, isOutdated: false, path: "", anchor: { at: "change" } }],
        "the finding is not read as one thread, resolved because its comment is hidden",
      );
      assert.deepEqual(
        threads[0]?.comments.map((comment) => [comment.id, comment.body]),
        [["IC_2", G1_FINDING], ["IC_4", G1_REPLY]],
        "the thread does not carry its finding and its reply as they were handed over",
      );
      assert.equal(JSON.parse(gh.stdinAt(3)).variables.node, NODE_ID);
    });
  });
});

test("#889: a general thread's comments are listed back exactly as they were handed over, trailing whitespace included", async () => {
  await withRepository(async (worktree) => {
    const finding = `${G1_FINDING}  \n\n`;
    const reply = `${G1_REPLY}\n`;
    const comments = conversation([
      conversationComment(2, `${finding}\n\n<sub>Squiz thread G1</sub> <!-- squiz:thread G1 -->`),
      conversationComment(4, `${reply}\n\n> In reply to G1: x <!-- squiz:reply G1 -->`),
    ]);
    await withFakeGh([pullRequestRow(), NO_REVIEW_THREADS, comments], () => {
      const listed = githubVenue.listThreads(readFound(worktree), deadlineIn(10_000));
      const bodies = listed.outcome === "listed" ? listed.threads[0]?.comments.map((comment) => comment.body) : listed;
      assert.deepEqual(bodies, [finding, reply]);
    });
  });
});

// A general finding squiz fails to list back reads exactly like one that was fixed.
test("#889: listThreads fails where the pull request's conversation comments cannot all be listed", async () => {
  await withRepository(async (worktree) => {
    const firstPage = conversation([conversationComment(2, G1_POSTED)], "next");
    await withFakeGh([pullRequestRow(), NO_REVIEW_THREADS, firstPage, { stderr: "connection reset\n", status: 1 }], () => {
      assert.deepEqual(githubVenue.listThreads(readFound(worktree), deadlineIn(10_000)), {
        outcome: "failed",
        reason: "gh exited 1: connection reset",
      });
    });
  });
});

test("#889: listThreads fails where a conversation comment is not one it can read", async () => {
  await withRepository(async (worktree) => {
    await withFakeGh([pullRequestRow(), NO_REVIEW_THREADS, conversation([{ id: "IC_2", body: G1_POSTED }])], () => {
      const listed = githubVenue.listThreads(readFound(worktree), deadlineIn(10_000));
      assert.equal(listed.outcome, "failed", JSON.stringify(listed));
    });
  });
});

test("#889: openGeneralThread posts a conversation comment naming the next G id after those on the pull request", async () => {
  const onIt = conversation([conversationComment(2, G1_POSTED), conversationComment(6, G1_POSTED.replaceAll("G1", "G2"))]);
  const posted = api(201, { id: 77, node_id: "IC_77", html_url: "https://github.com/o/r/pull/142#issuecomment-77" });
  await withFakeGh([api(200, { node_id: NODE_ID }), onIt, posted], (gh) => {
    const opened = githubVenue.openGeneralThread(foreign, G1_FINDING, deadlineIn(10_000));
    assert.deepEqual(opened, { outcome: "posted", threadId: "G3", commentId: "77", url: "https://github.com/o/r/pull/142#issuecomment-77" });
    assert.ok(gh.argumentsAt(3).includes("repos/{owner}/{repo}/issues/142/comments"), "the finding is not posted as a conversation comment");
    assert.deepEqual(JSON.parse(gh.stdinAt(3)), { body: `${G1_FINDING}\n\n<sub>Squiz thread G3</sub> <!-- squiz:thread G3 -->` });
  });
});

test("#889: openGeneralThread fails, with gh's reason, where the comment could not be posted", async () => {
  await withFakeGh([api(200, { node_id: NODE_ID }), conversation([]), apiError(403, { message: "Forbidden" }, "Forbidden")], () => {
    const opened = githubVenue.openGeneralThread(foreign, G1_FINDING, deadlineIn(10_000));
    assert.deepEqual(opened, { outcome: "failed", reason: "gh exited 1 on HTTP 403: gh: Forbidden (HTTP 403)" });
  });
});

test("#889: a reply to a G id is a conversation comment tied to its finding, quoting the finding's first line", async () => {
  await withRepository(async (worktree) => {
    await withFakeGh([pullRequestRow(), conversation([conversationComment(2, G1_POSTED)]), api(201, { id: 78 })], async (gh) => {
      const replied = await inDirectory(worktree, () => githubVenue.reply("G1", G1_REPLY, deadlineIn(10_000)));
      assert.deepEqual(replied, { outcome: "acted" });
      assert.ok(gh.argumentsAt(3).includes("repos/{owner}/{repo}/issues/142/comments"));
      assert.deepEqual(JSON.parse(gh.stdinAt(3)), { body: G1_REPLY_POSTED });
    });
  });
});

test("#889: a reply to a G id the pull request holds no finding for is refused, naming the id", async () => {
  await withRepository(async (worktree) => {
    await withFakeGh([pullRequestRow(), conversation([conversationComment(2, G1_POSTED)])], async (gh) => {
      const replied = await inDirectory(worktree, () => githubVenue.reply("G9", G1_REPLY, deadlineIn(10_000)));
      assert.deepEqual(replied, { outcome: "failed", reason: `PR #142 holds no thread "G9"` });
      assert.equal(gh.calls(), 2, "something was posted for a thread that is not there");
    });
  });
});

test("#889: resolving a G id hides its finding's comment as resolved, and re-opening it shows the comment again", async () => {
  await withRepository(async (worktree) => {
    const onIt = conversation([conversationComment(2, G1_POSTED)]);
    const hidden = api(200, { data: { minimizeComment: { minimizedComment: { isMinimized: true } } } });
    const shown = api(200, { data: { unminimizeComment: { unminimizedComment: { isMinimized: false } } } });
    await withFakeGh([pullRequestRow(), onIt, hidden, pullRequestRow(), onIt, shown], async (gh) => {
      const until = deadlineIn(10_000);
      assert.deepEqual(await inDirectory(worktree, () => githubVenue.resolve("G1", until)), { outcome: "acted" });
      assert.deepEqual(await inDirectory(worktree, () => githubVenue.reopen("G1", until)), { outcome: "acted" });
      const resolving = JSON.parse(gh.stdinAt(3));
      assert.match(resolving.query, /minimizeComment\(input: \{ subjectId: \$comment, classifier: RESOLVED \}\)/u);
      assert.equal(resolving.variables.comment, "IC_2");
      const reopening = JSON.parse(gh.stdinAt(6));
      assert.match(reopening.query, /unminimizeComment/u);
      assert.equal(reopening.variables.comment, "IC_2");
    });
  });
});

test("#889: resolving a G id whose comment GitHub will not hide fails, with GitHub's reason", async () => {
  await withRepository(async (worktree) => {
    const refused = api(200, { data: { minimizeComment: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a node with the global id of 'IC_2'." }] });
    await withFakeGh([pullRequestRow(), conversation([conversationComment(2, G1_POSTED)]), refused], async () => {
      const resolved = await inDirectory(worktree, () => githubVenue.resolve("G1", deadlineIn(10_000)));
      assert.equal(resolved.outcome, "failed");
      assert.match(resolved.outcome === "failed" ? resolved.reason : "", /Could not resolve to a node/u);
    });
  });
});
