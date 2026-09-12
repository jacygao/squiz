import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { threadListing } from "./cli.ts";
import type { ReviewThread } from "./github/threads.ts";

const shim = fileURLToPath(new URL("../bin/squiz", import.meta.url));
const cliEntry = fileURLToPath(new URL("./cli.ts", import.meta.url));
const hookModule = new URL("./hook/hook.ts", import.meta.url).href;

// Anywhere that is not the plugin. The hook is given the session's directory,
// which is not even the worktree root, so every run here starts somewhere the
// entry point cannot be reached from by a relative path.
//
// Its HEAD is detached, which is the one shape of working directory the gate
// answers without asking GitHub anything. These tests are about the binary, and
// a fixture that reached the network would be about something else.
let elsewhere = "";

// A branch is checked out here, which is what the coding agent's commands need
// before they ask GitHub anything. The `gh` they reach is a fixture.
let onABranch = "";

const identity = ["-c", "user.email=squiz@example.invalid", "-c", "user.name=Squiz"];

before(async () => {
  elsewhere = await mkdtemp(join(tmpdir(), "squiz-elsewhere-"));
  git(["init", "--quiet", "--initial-branch", "main"]);
  git([...identity, "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "x"]);
  git(["checkout", "--quiet", "--detach"]);

  onABranch = await mkdtemp(join(tmpdir(), "squiz-branch-"));
  gitIn(onABranch, ["init", "--quiet", "--initial-branch", "main"]);
  gitIn(onABranch, [
    ...identity,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "x",
  ]);
});

after(async () => {
  await rm(elsewhere, { recursive: true, force: true });
  await rm(onABranch, { recursive: true, force: true });
});

function git(args: readonly string[]): void {
  gitIn(elsewhere, args);
}

function gitIn(directory: string, args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

type Run = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * Run `command` with `args` and collect everything it left behind.
 *
 * The exit code and the stream a line landed on are properties of a process,
 * and the shim is a process rather than a function: what it resolves, and
 * whether it resolves at all, cannot be observed from inside this one.
 */
async function run(
  command: string,
  args: readonly string[],
  options: { cwd: string; path?: string },
): Promise<Run> {
  return await new Promise<Run>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.path === undefined ? {} : { PATH: options.path }) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test("the shim resolves the entry point from a working directory that is not the plugin", async () => {
  const result = await run(shim, ["hook"], { cwd: elsewhere });

  assert.equal(result.code, 0, `the shim did not run: ${result.stderr}`);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("a round that finds nothing to say writes nothing", async () => {
  const result = await run(shim, ["hook"], { cwd: elsewhere });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "", "silence is what a clean review looks like");
  assert.equal(result.stdout, "", "the runtime reads the two streams differently");
});

test("the binary runs by name off PATH, through a symlink to the shim", async () => {
  // How a plugin's bin/ reaches an agent's PATH is the runtime's business, and
  // a directory of symlinks is one of the shapes it can take. `dirname $0` in
  // the shim would look for src/ beside the link.
  const directory = await mkdtemp(join(tmpdir(), "squiz-bin-"));
  try {
    await symlink(shim, join(directory, "squiz"));
    const result = await run("squiz", ["hook"], {
      cwd: elsewhere,
      // node has to stay reachable: the shim execs it.
      path: `${directory}:${process.env["PATH"] ?? ""}`,
    });

    assert.equal(result.code, 0, `squiz did not resolve or did not run: ${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a command the binary does not have is named on stderr, and still exits 0", async () => {
  const result = await run(shim, ["frobnicate"], { cwd: elsewhere });

  assert.equal(result.code, 0, "the binary is the hook entry point, and only exit 2 may block a turn");
  assert.equal(
    result.stderr,
    'squiz: no command "frobnicate". The commands are: hook, threads, reply\n',
    "the list backs the message, so a command the binary has must be on it",
  );
  assert.equal(result.stdout, "");
});

test("no command at all is reported the same way", async () => {
  const result = await run(shim, [], { cwd: elsewhere });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "squiz: no command. The commands are: hook, threads, reply\n");
  assert.equal(result.stdout, "");
});

test("a throw inside the hook body exits 0 with the failure pointer", async () => {
  // The entry point has to be under the trap, not merely near it. The fixture
  // swaps the hook body for one that throws, which is what the trap is there to
  // survive.
  //
  // It is loaded with --import rather than importing the entry point itself,
  // because the entry point dispatches only when it is the process's entry
  // point. Node evaluates an --import module first and its load hook is in
  // place by the time the entry point is read.
  const directory = await mkdtemp(join(tmpdir(), "squiz-cli-"));
  try {
    const fixture = join(directory, "throwing-hook.mjs");
    await writeFile(
      fixture,
      [
        'import { registerHooks } from "node:module";',
        "registerHooks({",
        "  load(url, context, nextLoad) {",
        `    if (url === ${JSON.stringify(hookModule)}) {`,
        "      return {",
        '        format: "module",',
        "        shortCircuit: true,",
        '        source: \'export function runHook() { throw new Error("the gate exploded"); }\',',
        "      };",
        "    }",
        "    return nextLoad(url, context);",
        "  },",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await run(
      process.execPath,
      ["--import", pathToFileURL(fixture).href, cliEntry, "hook"],
      { cwd: elsewhere },
    );

    assert.equal(result.code, 0, "a non-zero exit stops the coding agent finishing its turn");
    assert.equal(result.stderr, "squiz: the hook failed: Error: the gate exploded\n");
    assert.equal(result.stdout, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the shim is executable", async () => {
  // Tracked mode, not the mode on this disk. A shim committed without the bit
  // is on PATH and still cannot be run, and a hook whose command will not run
  // leaves the same empty transcript as a round with nothing to say.
  const result = await run("git", ["ls-files", "--stage", "--", "bin/squiz"], {
    cwd: dirname(dirname(shim)),
  });

  assert.equal(result.code, 0, `git could not report the tracked mode: ${result.stderr}`);
  assert.match(result.stdout, /^100755 /u, "bin/squiz is tracked without its execute bit");
});

/**
 * A thread as the reader hands one over, with `overrides` naming what the case
 * is about.
 *
 * `line` is already the line to report on: the reader puts `originalLine` in
 * its place when GitHub nulls the live one, so null here is a thread anchored
 * to no line at all.
 */
function thread(overrides: Partial<ReviewThread>): ReviewThread {
  return {
    id: "PRRT_kwDOUEd2qM6hqHeq",
    isResolved: false,
    isOutdated: false,
    path: "src/cli.ts",
    line: 7,
    comments: [],
    ...overrides,
  };
}

test("the listing names each open thread by its id and its file and line", () => {
  const printed = threadListing(80, [
    thread({ id: "PRRT_one", path: "scratch/target.txt", line: 7 }),
    thread({ id: "PRRT_two", path: "scratch/target.txt", line: 12 }),
  ]);

  assert.equal(
    printed,
    ["2 open threads on #80", "PRRT_one scratch/target.txt:7", "PRRT_two scratch/target.txt:12", ""].join(
      "\n",
    ),
  );
});

test("a resolved thread is not on the listing", () => {
  const printed = threadListing(80, [
    thread({ id: "PRRT_open", line: 7 }),
    thread({ id: "PRRT_closed", isResolved: true, line: 19 }),
  ]);

  assert.equal(
    printed,
    ["1 open thread on #80", "PRRT_open src/cli.ts:7", ""].join("\n"),
    "a closed thread listed as open sends the agent back to work the reviewer accepted",
  );
});

test("a pull request with nothing open says so in words", () => {
  const none = "no open threads on #80\n";

  assert.equal(threadListing(80, []), none, "printing nothing would read as a command that failed");
  assert.equal(threadListing(80, [thread({ isResolved: true })]), none);
});

test("a thread anchored to no line names the file instead of printing a null", () => {
  const printed = threadListing(80, [thread({ id: "PRRT_file", path: "scratch/target.txt", line: null })]);

  assert.equal(printed, ["1 open thread on #80", "PRRT_file scratch/target.txt (whole file)", ""].join("\n"));
  assert.doesNotMatch(printed, /null/u, "file:null names nothing a reader can open");
});

test("a thread whose anchored line was edited is listed on the line it was anchored to", () => {
  const printed = threadListing(80, [thread({ id: "PRRT_old", isOutdated: true, line: 12 })]);

  assert.match(printed, /^PRRT_old src\/cli\.ts:12$/mu);
});

test("the identifier is the whole of the first field, so it copies into squiz reply", () => {
  const ids = ["PRRT_kwDOUEd2qM6hqQd7", "PRRT_kwDOUEd2qM6hqQfm"];
  // The paths #80 carries: a space, so the location cannot be split on the
  // first field, and a path outside ASCII.
  const printed = threadListing(80, [
    thread({ id: ids[0], path: "scratch/a file with spaces.txt", line: 1 }),
    thread({ id: ids[1], path: "scratch/ünïcödé.txt", line: 1 }),
  ]);

  const listed = printed.trimEnd().split("\n").slice(1);
  assert.deepEqual(
    listed.map((line) => line.split(" ")[0]),
    ids,
    "an id that does not survive being copied leaves the agent unable to reply",
  );
  assert.deepEqual(listed, [
    `${ids[0]} scratch/a file with spaces.txt:1`,
    `${ids[1]} scratch/ünïcödé.txt:1`,
  ]);
});

test("squiz threads with no pull request for the branch says so and lists nothing", async () => {
  const result = await run(shim, ["threads"], { cwd: elsewhere });

  assert.equal(result.code, 0, "exit 2 is how a round blocks a turn, and this is not a round");
  assert.equal(
    result.stdout,
    "",
    "a listing GitHub never served must not be printed, empty or otherwise",
  );
  assert.equal(
    result.stderr,
    "squiz: no threads listed: HEAD is detached here, so no branch has a pull request\n",
  );
});

test("squiz reply with no pull request for the branch says so and posts nothing", async () => {
  const result = await run(shim, ["reply", "PRRT_kwDOUEd2qM6hqHeq", "a reply"], { cwd: elsewhere });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "squiz: nothing replied: HEAD is detached here, so no branch has a pull request\n",
  );
});

test("squiz reply with no text to post reports how it is called", () => {
  // Nothing is asked of git or GitHub first: the usage line arrives in a
  // directory that is no repository at all.
  const result = spawnSync(shim, ["reply", "PRRT_kwDOUEd2qM6hqHeq"], {
    cwd: tmpdir(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "squiz: nothing replied: squiz reply <id> <text>, where <id> is what squiz threads printed\n",
  );
});

/** What the fake `gh` answers the one API call a command makes. */
type ApiAnswer = {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly status?: number;
};

/**
 * A response as `gh api --include` writes one.
 *
 * The status line ends in a bare newline and the headers in CRLF, which is what
 * the boundary reads the body out of.
 */
function answered(value: unknown): ApiAnswer {
  const headers = "HTTP/2.0 200 OK\nContent-Type: application/json; charset=utf-8\r\n\r\n";
  return { stdout: `${headers}${JSON.stringify(value)}` };
}

/** The row `gh pr list` prints for the pull request a command then works on. */
const pullRequestRow = JSON.stringify([
  {
    number: 80,
    id: "PR_kwDOUEd2qM8AAAABDNPXSA",
    baseRefName: "main",
    headRefName: "main",
    headRefOid: "655997442d7a69aec2903665478883e71dac5da0",
    body: "",
  },
]);

/**
 * Run the binary's `args` where a branch is checked out, with a `gh` on PATH
 * that answers the pull request lookup with one pull request and the API call
 * with `api`.
 *
 * A fake binary rather than an injected runner, as the rest of the repository
 * tests `gh` with. The two calls are told apart by the `graphql` argument: the
 * lookup is `gh pr list`, which is not an API call and carries no status line.
 */
async function withFakeGh(args: readonly string[], api: ApiAnswer): Promise<Run> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-gh-"));
  try {
    await writeFile(join(directory, "list.out"), pullRequestRow, "utf8");
    await writeFile(join(directory, "api.out"), api.stdout ?? "", "utf8");
    await writeFile(join(directory, "api.err"), api.stderr ?? "", "utf8");
    await writeFile(join(directory, "api.status"), String(api.status ?? 0), "utf8");
    await writeFile(join(directory, "gh"), fakeGh(directory), "utf8");
    await chmod(join(directory, "gh"), 0o755);

    return await run(shim, args, {
      cwd: onABranch,
      // node and git have to stay reachable: the shim execs node, and the
      // commands resolve the branch with git.
      path: `${directory}:${process.env["PATH"] ?? ""}`,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function fakeGh(directory: string): string {
  const at = `'${directory.replaceAll("'", `'\\''`)}'`;
  return [
    "#!/bin/sh",
    // The request body arrives on stdin, and a gh that never read it would have
    // the caller fail on a broken pipe instead of on the answer below.
    "cat > /dev/null",
    'for arg in "$@"; do',
    '  if [ "$arg" = graphql ]; then',
    `    cat ${at}/api.out`,
    `    cat ${at}/api.err >&2`,
    `    exit "$(cat ${at}/api.status)"`,
    "  fi",
    "done",
    `cat ${at}/list.out`,
    "",
  ].join("\n");
}

const emptyListing = answered({
  data: { node: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } },
});

test("a listing GitHub answered unreadably is not printed as a pull request with nothing open", async () => {
  // An id naming something that is not a pull request answers with an empty
  // node, at HTTP 200 and with no errors array.
  const result = await withFakeGh(["threads"], answered({ data: { node: {} } }));

  assert.equal(
    result.stdout,
    "",
    "a listing read as empty has the agent finish its turn with findings open",
  );
  assert.equal(result.code, 0);
  assert.match(result.stderr, /^squiz: the threads on #80 could not be listed: /u);
});

test("a gh that failed is not printed as a pull request with nothing open", async () => {
  const result = await withFakeGh(["threads"], { status: 1, stderr: "gh: HTTP 502" });

  assert.equal(
    result.stdout,
    "",
    "a listing read as empty has the agent finish its turn with findings open",
  );
  assert.equal(result.code, 0);
  assert.equal(
    result.stderr,
    "squiz: the threads on #80 could not be listed: gh exited 1: gh: HTTP 502\n",
  );
});

test("a pull request GitHub says has no threads is the only thing that prints none", async () => {
  const result = await withFakeGh(["threads"], emptyListing);

  assert.equal(result.stdout, "no open threads on #80\n");
  assert.equal(result.stderr, "");
  assert.equal(result.code, 0);
});

test("a reply GitHub refused inside an HTTP 200 is not printed as a reply that landed", async () => {
  const refused = answered({
    errors: [{ message: "Could not resolve to a node with the global id of 'PRRT_nothing'." }],
  });
  const result = await withFakeGh(["reply", "PRRT_nothing", "a reply"], refused);

  assert.equal(result.stdout, "", "a reply reported as posted is a finding the agent answers twice");
  assert.equal(result.code, 0);
  assert.match(result.stderr, /^squiz: nothing replied in PRRT_nothing: GitHub reported a GraphQL /u);
});

test("a reply that landed names the thread that took it", async () => {
  const posted = answered({ data: { addPullRequestReviewThreadReply: { comment: {} } } });
  const result = await withFakeGh(["reply", "PRRT_somewhere", "a reply"], posted);

  assert.equal(result.stdout, "replied in PRRT_somewhere on #80\n");
  assert.equal(result.stderr, "");
  assert.equal(result.code, 0);
});
