import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { standIn } from "./testing/stand-in.ts";

const shim = fileURLToPath(new URL("../bin/squiz", import.meta.url));
const cliEntry = fileURLToPath(new URL("./cli.ts", import.meta.url));
const hookModule = new URL("./hook/hook.ts", import.meta.url).href;
const reviewModule = new URL("./review/review.ts", import.meta.url).href;
const initModule = new URL("./review/init.ts", import.meta.url).href;

// Anywhere that is not the plugin. A hook may run in the session's directory,
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

/** One firing in `elsewhere`, as the runtime writes it to the hook's stdin. */
function payload(): string {
  return JSON.stringify({
    hook_event_name: "SubagentStop",
    session_id: "60517e1f-e1dc-49b1-8e39-6fcbe686f3fb",
    cwd: realpathSync(elsewhere),
    agent_id: "a1e3196c5ad0f2410",
    stop_hook_active: false,
  });
}

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

/** The one line a firing in `elsewhere` writes, which says the entry point ran. */
function detachedHere(): string {
  const directory = realpathSync(elsewhere);
  return `squiz: no review ran: HEAD is detached in ${JSON.stringify(directory)}, so no pull request has it as its head\n`;
}

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
  options: { cwd: string; path?: string; home?: string; input?: string },
): Promise<Run> {
  return await new Promise<Run>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.path === undefined ? {} : { PATH: options.path }),
        ...(options.home === undefined ? {} : { HOME: options.home }),
      },
    });
    // A child that reads no stdin can exit before the write lands, and the
    // failed write belongs to the pipe rather than to the test.
    child.stdin.on("error", () => {});
    // Written and closed rather than left open. The hook reads its payload from
    // stdin, and a stdin nobody ends is a hook that never returns.
    child.stdin.end(options.input ?? "");
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

test("a child that reads no stdin is run rather than failed (#180)", async () => {
  // More than a pipe buffer, so the write cannot land before a child that reads
  // nothing has gone. Every other test here spawns something that exits on its
  // own schedule, and one that exits first used to fail the run with EPIPE.
  const result = await run(process.execPath, ["-e", "process.exit(0)"], {
    cwd: elsewhere,
    input: "x".repeat(10_000_000),
  });

  assert.equal(result.code, 0, `the child did not exit cleanly: ${result.stderr}`);
});

test("the shim resolves the entry point from a working directory that is not the plugin", async () => {
  const result = await run(shim, ["hook"], { cwd: elsewhere, input: payload() });

  assert.equal(result.code, 0, `the shim did not run: ${result.stderr}`);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, detachedHere());
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
      input: payload(),
      // node has to stay reachable: the shim execs it.
      path: `${directory}:${process.env["PATH"] ?? ""}`,
    });

    assert.equal(result.code, 0, `squiz did not resolve or did not run: ${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, detachedHere());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a command the binary does not have is named on stderr, and still exits 0", async () => {
  const result = await run(shim, ["frobnicate"], { cwd: elsewhere });

  assert.equal(result.code, 0, "the binary is the hook entry point, and only exit 2 may block a turn");
  assert.equal(
    result.stderr,
    'squiz: no command "frobnicate". The commands are: hook, threads, reply, status, host, review, init\n',
    "the list backs the message, so a command the binary has must be on it",
  );
  assert.equal(result.stdout, "");
});

test("no command at all is reported the same way", async () => {
  const result = await run(shim, [], { cwd: elsewhere });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "squiz: no command. The commands are: hook, threads, reply, status, host, review, init\n");
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

/** A run of the binary, and the request body the fake `gh` was sent last. */
type FakeRun = Run & { readonly sent: string };

/**
 * Run the binary's `args` where a branch is checked out, with a `gh` on PATH
 * that answers the pull request lookup with one pull request and the API call
 * with `api`.
 *
 * A fake binary rather than an injected runner, as the rest of the repository
 * tests `gh` with. The two calls are told apart by the `graphql` argument: the
 * lookup is `gh pr list`, which is not an API call and carries no status line.
 *
 * What the fake was sent on stdin is kept, so that a test can assert the body a
 * command composed rather than only what it printed about it.
 */
async function withFakeGh(args: readonly string[], api: ApiAnswer): Promise<FakeRun> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-gh-"));
  try {
    await writeFile(join(directory, "list.out"), pullRequestRow, "utf8");
    // Written empty first, so that a command that asked gh for nothing at all is
    // read back as a command that sent nothing rather than as a missing fixture.
    await writeFile(join(directory, "api.in"), "", "utf8");
    await writeFile(join(directory, "api.out"), api.stdout ?? "", "utf8");
    await writeFile(join(directory, "api.err"), api.stderr ?? "", "utf8");
    await writeFile(join(directory, "api.status"), String(api.status ?? 0), "utf8");
    standIn(directory, "gh", fakeGh(directory));

    const result = await run(shim, args, {
      cwd: onABranch,
      // node and git have to stay reachable: the shim execs node, and the
      // commands resolve the branch with git.
      path: `${directory}:${process.env["PATH"] ?? ""}`,
    });

    return { ...result, sent: await readFile(join(directory, "api.in"), "utf8") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function fakeGh(directory: string): string {
  const at = `'${directory.replaceAll("'", `'\\''`)}'`;
  return [
    "#!/bin/sh",
    // The request body arrives on stdin, and a gh that never read it would have
    // the caller fail on a broken pipe instead of on the answer below. It is
    // kept rather than dropped: the last call of a command wrote it, which is
    // the one whose body a test asserts.
    `cat > ${at}/api.in`,
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

/** The comment body inside the reply mutation the fake `gh` was sent. */
function replyBodySent(sent: string): unknown {
  const request = JSON.parse(sent) as { readonly variables?: { readonly body?: unknown } };
  return request.variables?.body;
}

test("a reply is posted under the coding agent's marker, not as the text alone (#194)", async () => {
  const posted = answered({ data: { addPullRequestReviewThreadReply: { comment: {} } } });
  const result = await withFakeGh(["reply", "PRRT_somewhere", "Fixed in befac71."], posted);

  assert.equal(result.stdout, "replied in PRRT_somewhere on #80\n");
  assert.equal(
    replyBodySent(result.sent),
    "**Squiz coding agent**\n\nFixed in befac71.",
    "an unmarked reply reads as a person's, and the thread it answers is reported as a finding nobody answered",
  );
});

test("squiz status lists the reviews of every worktree, and never runs gh", async () => {
  const fakes = await mkdtemp(join(tmpdir(), "squiz-no-gh-"));
  const linked = join(fakes, "squiz-linked");
  try {
    gitIn(onABranch, ["worktree", "add", "--quiet", "--detach", linked]);
    const episode = join(linked, ".squiz", "41");
    await mkdir(episode, { recursive: true });
    const record = { head: "8d21a4f0c3b2e1d4a5f6b7c8d9e0f1a2b3c4d5e6", activity: null, status: "queued" };
    const state = { rounds: [], spentOutsideRounds: { dollars: 0, tokens: 0, messages: 0 }, records: [record] };
    await writeFile(join(episode, "state.json"), JSON.stringify(state), "utf8");
    const called = join(fakes, "gh-was-called");
    standIn(fakes, "gh", `#!/bin/sh\ntouch '${called}'\nexit 1\n`);

    const result = await run(shim, ["status"], {
      cwd: onABranch,
      path: `${fakes}:${process.env["PATH"] ?? ""}`,
    });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^PR +Commit +Replies +State/u);
    assert.match(result.stdout, /\n#41 +8d21a4f +— +queued +— +— +— +— +\S*squiz-linked +—\n$/u);
    await assert.rejects(stat(called), "squiz status asks nothing of GitHub");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", linked], { cwd: onABranch });
    await rm(fakes, { recursive: true, force: true });
  }
});

test("squiz status names a state file that cannot be read on stderr, lists the rest, and never runs gh", async () => {
  const fakes = await mkdtemp(join(tmpdir(), "squiz-unread-"));
  const readable = join(fakes, "squiz-readable");
  const unreadable = join(fakes, "squiz-unreadable");
  try {
    gitIn(onABranch, ["worktree", "add", "--quiet", "--detach", readable]);
    gitIn(onABranch, ["worktree", "add", "--quiet", "--detach", unreadable]);
    await mkdir(join(readable, ".squiz", "41"), { recursive: true });
    const record = { head: "8d21a4f0c3b2e1d4a5f6b7c8d9e0f1a2b3c4d5e6", activity: null, status: "queued" };
    const state = { rounds: [], spentOutsideRounds: { dollars: 0, tokens: 0, messages: 0 }, records: [record] };
    await writeFile(join(readable, ".squiz", "41", "state.json"), JSON.stringify(state), "utf8");
    await mkdir(join(unreadable, ".squiz", "38"), { recursive: true });
    await writeFile(join(unreadable, ".squiz", "38", "state.json"), "{ not json", "utf8");
    const called = join(fakes, "gh-was-called");
    standIn(fakes, "gh", `#!/bin/sh\ntouch '${called}'\nexit 1\n`);

    const result = await run(shim, ["status"], {
      cwd: onABranch,
      path: `${fakes}:${process.env["PATH"] ?? ""}`,
    });

    assert.equal(result.code, 0);
    const [line, ...rest] = result.stderr.split("\n");
    assert.match(
      line ?? "",
      /^squiz: the reviews of #38 in \S*squiz-unreadable could not be read: \S*squiz-unreadable\/\.squiz\/38\/state\.json is not valid JSON: /u,
      "the line names the pull request, the worktree, the file and the parser's error",
    );
    assert.deepEqual(rest, [""], "one line, and nothing else");
    assert.match(result.stdout, /\n#41 +8d21a4f +— +queued +— +— +— +— +\S*squiz-readable +—\n$/u);
    assert.doesNotMatch(result.stdout, /#38/u);
    await assert.rejects(stat(called), "squiz status asks nothing of GitHub");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", readable], { cwd: onABranch });
    spawnSync("git", ["worktree", "remove", "--force", unreadable], { cwd: onABranch });
    await rm(fakes, { recursive: true, force: true });
  }
});

test("squiz host without a pull request's number reports how it is called, and starts nothing", async () => {
  const result = await run(shim, ["host", "forty-one"], { cwd: onABranch });

  assert.equal(result.code, 0);
  assert.equal(
    result.stderr,
    "squiz: no round host started: squiz host <number>, where <number> is the pull request's\n",
  );
  assert.equal(result.stdout, "");
  await assert.rejects(stat(join(onABranch, ".squiz")), "a host that never started made the episode's directory");
});

test("squiz host with nothing queued exits, and says so in host.log", async () => {
  try {
    const result = await run(shim, ["host", "41"], { cwd: onABranch });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    const log = await readFile(join(onABranch, ".squiz", "41", "host.log"), "utf8");
    assert.match(log, /exiting: nothing is left queued\n$/u);
  } finally {
    await rm(join(onABranch, ".squiz"), { recursive: true, force: true });
  }
});

test("squiz review without a pull request's number exits 1, reporting how it is called", async () => {
  const result = await run(shim, ["review"], { cwd: onABranch });

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "squiz: no review ran: squiz review <number>, where <number> is the pull request's\n");
  assert.equal(result.stdout, "");
});

test("squiz review on a detached HEAD exits 1 with the gate's line, and prints nothing on stdout", async () => {
  const result = await run(shim, ["review", "41"], { cwd: elsewhere });

  assert.equal(result.code, 1);
  assert.equal(result.stderr, `${detachedHere()}squiz: put these lines in your report rather than running squiz review again\n`);
  assert.equal(result.stdout, "");
});

test("a throw inside squiz review exits 1, which never reads as a result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "squiz-cli-"));
  try {
    const fixture = join(directory, "throwing-review.mjs");
    await writeFile(
      fixture,
      [
        'import { registerHooks } from "node:module";',
        "registerHooks({",
        "  load(url, context, nextLoad) {",
        `    if (url === ${JSON.stringify(reviewModule)}) {`,
        "      return {",
        '        format: "module",',
        "        shortCircuit: true,",
        '        source: \'export async function runReview() { throw new Error("the wait exploded"); }\',',
        "      };",
        "    }",
        "    return nextLoad(url, context);",
        "  },",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await run(process.execPath, ["--import", pathToFileURL(fixture).href, cliEntry, "review", "41"], {
      cwd: onABranch,
    });

    assert.equal(result.code, 1);
    assert.equal(result.stderr, "squiz: the review failed: Error: the wait exploded\n");
    assert.equal(result.stdout, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * A home of its own whose ~/.local/bin is on a PATH of its own, so that `squiz
 * init` links into neither the developer's home nor a directory their PATH
 * already has. Beyond the system's own directories, the PATH reaches `node`,
 * which the shim needs, through a link to it alone.
 */
async function initSandbox(): Promise<{ readonly home: string; readonly localBin: string; readonly path: string }> {
  const home = realpathSync(await mkdtemp(join(tmpdir(), "squiz-553-home-")));
  const localBin = join(home, ".local", "bin");
  await mkdir(localBin, { recursive: true });
  const tools = join(home, "tools");
  await mkdir(tools);
  await symlink(process.execPath, join(tools, "node"));
  return { home, localBin, path: `${localBin}:${tools}:/usr/bin:/bin` };
}

test("squiz init links squiz, prints the line that says so, and writes no AGENTS.md (#600)", async () => {
  const root = await mkdtemp(join(tmpdir(), "squiz-553-init-cli-"));
  const { home, localBin, path } = await initSandbox();
  try {
    gitIn(root, ["init", "--quiet", "--initial-branch", "main"]);

    const result = await run(shim, ["init"], { cwd: root, path, home });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `squiz: linked ${join(localBin, "squiz")} to ${realpathSync(shim)}\n`);
    assert.equal(result.stderr, "");
    await assert.rejects(stat(join(root, "AGENTS.md")));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("squiz init run by name through its own link finds the link already there", async () => {
  const root = await mkdtemp(join(tmpdir(), "squiz-553-init-cli-"));
  const { home, localBin, path } = await initSandbox();
  try {
    gitIn(root, ["init", "--quiet", "--initial-branch", "main"]);
    await run(shim, ["init"], { cwd: root, path, home });

    const result = await run("squiz", ["init"], { cwd: root, path, home });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.stdout,
      `squiz: ${join(localBin, "squiz")} already links to this squiz; nothing changed\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("a link squiz init cannot make exits 1, which is how the person running it learns it did nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "squiz-553-nolink-"));
  const { home, path } = await initSandbox();
  try {
    // The PATH without ~/.local/bin, so neither directory squiz init links into is on it.
    const result = await run(shim, ["init"], { cwd: root, path: path.split(":").slice(1).join(":"), home });

    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, /^squiz: made no link: [^\n]+\n$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("a throw inside squiz init exits 1, which never reads as the link made", async () => {
  const directory = await mkdtemp(join(tmpdir(), "squiz-cli-"));
  try {
    const fixture = join(directory, "throwing-init.mjs");
    await writeFile(
      fixture,
      [
        'import { registerHooks } from "node:module";',
        "registerHooks({",
        "  load(url, context, nextLoad) {",
        `    if (url === ${JSON.stringify(initModule)}) {`,
        "      return {",
        '        format: "module",',
        "        shortCircuit: true,",
        '        source: \'export function squizInit() { throw new Error("the link exploded"); }\',',
        "      };",
        "    }",
        "    return nextLoad(url, context);",
        "  },",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await run(process.execPath, ["--import", pathToFileURL(fixture).href, cliEntry, "init"], {
      cwd: onABranch,
    });

    assert.equal(result.code, 1);
    assert.equal(result.stderr, "squiz: squiz init failed: Error: the link exploded\n");
    assert.equal(result.stdout, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
