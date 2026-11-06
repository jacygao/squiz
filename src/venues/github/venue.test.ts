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
import { githubVenue } from "./venue.ts";

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
  followUp,
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
      assert.equal(change.followUp, followUp);
      assert.equal(change.base, BASE);
      assert.equal(change.head, HEAD);
      assert.equal(change.description, "## Intent\n\nWhat this is for.");
      assert.ok(gh.argumentsAt(1).includes("--head"), "the lookup names the branch as the head");
      assert.ok(gh.argumentsAt(1).includes("feature"));
      assert.equal(gh.directoryAt(1), worktree);
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

test("episodeDirectory is .squiz/<number>/ in the worktree the change was read in", async () => {
  await withRepository(async (worktree) => {
    await withFakeGh([pullRequestRow()], () => {
      assert.equal(githubVenue.episodeDirectory(readFound(worktree)), join(worktree, ".squiz", "142"));
    });
  });
});

test("episodeDirectory keeps a key that is no number inside .squiz/, where no episode reads it back", () => {
  const directory = githubVenue.episodeDirectory({ ...foreign, key: "../.." });
  assert.equal(directory, join(process.cwd(), ".squiz", "-%2E%2E%2F%2E%2E"));
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
    await withFakeGh([pullRequestRow(), page], (gh) => {
      const listed = githubVenue.listThreads(readFound(worktree), deadlineIn(10_000));
      assert.deepEqual(listed, { outcome: "listed", threads: [] });
      assert.equal(JSON.parse(gh.stdinAt(2)).variables.pullRequest, NODE_ID);
      assert.equal(gh.calls(), 2, "a change read here carries its node id, so none is looked up");
    });
  });
});

test("listThreads looks the node id up for a change it did not read", async () => {
  const page = api(200, { data: { node: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
  await withFakeGh([api(200, { node_id: NODE_ID }), page], (gh) => {
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
      commentId: 3993908108,
      url: created.html_url,
    });
    assert.ok(gh.argumentsAt(1).includes("repos/{owner}/{repo}/pulls/142/comments"));
    assert.deepEqual(JSON.parse(gh.stdinAt(1)), { body: "the finding", commit_id: HEAD, path: "a.ts", line: 7, side: "RIGHT" });
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
