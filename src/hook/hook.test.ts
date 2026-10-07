/**
 * What one firing of the hook does.
 *
 * A firing runs as a process. An exit code, the stream a line landed on, and
 * whether the process ended while the host it started still runs are properties
 * of a process, and none of them is observable from inside this one. The
 * fixtures run the hook without the top-level trap, so a throw that escapes the
 * hook fails the test instead of being turned into the exit 0 it expects.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { readState } from "../loop/episode-state.ts";
import { episodeAt } from "../loop/episode.ts";
import { standIn } from "../testing/stand-in.ts";

const hookModule = new URL("./hook.ts", import.meta.url).href;
const triggerModule = new URL("../host/trigger.ts", import.meta.url).href;
const episodeModule = new URL("../loop/episode.ts", import.meta.url).href;
const standInHost = fileURLToPath(new URL("../host/host-stand-in.ts", import.meta.url));

const NUMBER = 41;
const BRANCH = "feature-a";
const HEAD = "3f9c2e0a1b2c3d4e5f60718293a4b5c6d7e8f901";
const SESSION_ID = "60517e1f-e1dc-49b1-8e39-6fcbe686f3fb";
const AGENT_ID = "a1e3196c5ad0f2410";
const SOCKET = "/tmp/claude-code-messaging.sock";
const BOUND_MS = 10_000;

/** A firing as the runtime writes it to the hook's stdin, for a session in `cwd`. */
function stopPayload(cwd: string, over: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    session_id: SESSION_ID,
    cwd,
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "The change is on the branch.",
    ...over,
  });
}

function subagentStopPayload(cwd: string, over: Readonly<Record<string, unknown>> = {}): string {
  return stopPayload(cwd, { hook_event_name: "SubagentStop", agent_id: AGENT_ID, agent_type: "general-purpose", ...over });
}

/** A worktree on `BRANCH`, a `gh` answering for it, and a file for whatever reports back. */
type Place = {
  readonly worktree: string;
  readonly bin: string;
  /** Where the stand-in hosts write `took <pid>`, and a recording trigger its request. */
  readonly log: string;
};

/**
 * The fake `gh`. `gh pr list` prints `list.out` and exits with `list.status`.
 * Every GraphQL call is a threads listing with no threads. Each call's arguments
 * are appended to `calls.log`, one line per call.
 */
function fakeGh(directory: string): string {
  const at = `'${directory.replaceAll("'", `'\\''`)}'`;
  const noThreads = JSON.stringify({
    data: { node: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
  });
  return [
    "#!/bin/sh",
    "cat > /dev/null",
    `printf '%s\\n' "$*" >> ${at}/calls.log`,
    'for arg in "$@"; do',
    '  if [ "$arg" = graphql ]; then',
    `    printf 'HTTP/2.0 200 OK\\nContent-Type: application/json; charset=utf-8\\r\\n\\r\\n%s' '${noThreads}'`,
    "    exit 0",
    "  fi",
    "done",
    `cat ${at}/list.out`,
    `exit "$(cat ${at}/list.status 2>/dev/null || echo 0)"`,
    "",
  ].join("\n");
}

function git(directory: string, ...args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

async function withPlace(body: (place: Place) => Promise<void>): Promise<void> {
  // Real paths, because git answers the toplevel with symlinks resolved.
  const worktree = realpathSync(await mkdtemp(join(tmpdir(), "squiz-hook-")));
  const bin = await mkdtemp(join(tmpdir(), "squiz-hook-gh-"));
  const place: Place = { worktree, bin, log: join(bin, "reported.log") };
  try {
    git(worktree, "init", "--quiet", "--initial-branch", BRANCH);
    git(worktree, "-c", "user.email=squiz@example.invalid", "-c", "user.name=Squiz", "-c", "commit.gpgsign=false",
      "commit", "--quiet", "--allow-empty", "--message", "a commit to hang a branch off");
    const row = { number: NUMBER, id: "PR_kwDOUEd2qM8AAAABDNPXSA", baseRefName: "main", headRefName: BRANCH, headRefOid: HEAD, body: "" };
    writeFileSync(join(bin, "list.out"), JSON.stringify([row]), "utf8");
    standIn(bin, "gh", fakeGh(bin));
    await body(place);
  } finally {
    for (const pid of hostsThatTook(place)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await rm(worktree, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  }
}

function reported(place: Place): string {
  return existsSync(place.log) ? readFileSync(place.log, "utf8") : "";
}

function hostsThatTook(place: Place): number[] {
  return reported(place).split("\n").filter((line) => line.startsWith("took ")).map((line) => Number(line.slice(5)));
}

/** Which trigger the firing calls, as source the child evaluates. */
type TriggerAs =
  /** The real one, with the stand-in host in place of `squiz host`. */
  | { readonly as: "real" }
  /** The real one, starting `command` as the host. */
  | { readonly as: "real"; readonly hostCommand: string }
  /** One that writes the request it was given to the log, and found no pull request. */
  | { readonly as: "recording" }
  | { readonly as: "throwing"; readonly message: string };

type HookFiring = {
  readonly payload: string;
  /**
   * The directory the hook process runs in. Not a git worktree where not given,
   * as under Copilot, which runs a plugin's hook in the plugin root.
   */
  readonly from?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly trigger?: TriggerAs;
};

type Fired = { readonly code: number | null; readonly stderr: string; readonly elapsedMs: number };

function triggerSource(place: Place, trigger: TriggerAs): string {
  const log = JSON.stringify(place.log);
  switch (trigger.as) {
    case "real": {
      const host =
        "hostCommand" in trigger
          ? `() => ({ command: ${JSON.stringify(trigger.hostCommand)}, args: [] })`
          : `(number) => ({ command: process.execPath, args: [${JSON.stringify(standInHost)}, episodeAt(${JSON.stringify(place.worktree)}, number).directory, ${log}] })`;
      return `(request) => trigger({ ...request, host: ${host} })`;
    }
    case "recording":
      return [
        "(request) => {",
        `  writeFileSync(${log}, JSON.stringify({ ...request, remainingMs: request.until.remaining() }));`,
        '  return { outcome: "no review", reason: "the recording trigger looked for nothing" };',
        "}",
      ].join("\n");
    case "throwing":
      return `() => { throw new Error(${JSON.stringify(trigger.message)}); }`;
  }
}

/** Fire the hook in `place` as a process of its own, and collect what it left behind. */
async function fire(place: Place, firing: HookFiring): Promise<Fired> {
  const source = join(place.bin, "fire.mjs");
  await writeFile(
    source,
    [
      `import { writeFileSync } from "node:fs";`,
      `import { Readable } from "node:stream";`,
      `import { runHook } from ${JSON.stringify(hookModule)};`,
      `import { trigger } from ${JSON.stringify(triggerModule)};`,
      `import { episodeAt } from ${JSON.stringify(episodeModule)};`,
      ``,
      `process.exitCode = await runHook({`,
      `  stdin: Readable.from([${JSON.stringify(firing.payload)}]),`,
      `  environment: ${JSON.stringify(firing.environment ?? {})},`,
      `  trigger: ${triggerSource(place, firing.trigger ?? { as: "real" })},`,
      `});`,
      ``,
    ].join("\n"),
    "utf8",
  );
  const started = Date.now();
  return await new Promise<Fired>((resolve, reject) => {
    // Pipes, which is how Claude Code runs the hook. A host that kept either
    // open would hold this until it exited.
    const child = spawn(process.execPath, [source], {
      cwd: firing.from ?? place.bin,
      env: { ...process.env, PATH: `${place.bin}:${process.env["PATH"] ?? ""}` },
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.resume();
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stderr, elapsedMs: Date.now() - started });
    });
  });
}

async function eventually(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + BOUND_MS;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`${what} did not happen within ${BOUND_MS}ms`);
    await sleep(50);
  }
}

function recordsIn(place: Place): readonly unknown[] {
  const read = readState(episodeAt(place.worktree, NUMBER));
  assert.equal(read.outcome, "read", `state read as ${JSON.stringify(read)}`);
  return read.outcome === "read" ? (read.state.records ?? []) : [];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a Stop firing queues the state, owned by the session and its socket, and says nothing", async () => {
  await withPlace(async (place) => {
    const fired = await fire(place, {
      payload: stopPayload(place.worktree),
      environment: { CLAUDE_CODE_MESSAGING_SOCKET: SOCKET, HERDR_WORKSPACE_ID: "w2" },
    });

    assert.deepEqual(fired, { code: 0, stderr: "", elapsedMs: fired.elapsedMs });
    assert.deepEqual(recordsIn(place), [
      {
        head: HEAD,
        activity: null,
        owner: { sessionId: SESSION_ID, messagingSocket: SOCKET },
        herdrWorkspace: "w2",
        status: "queued",
      },
    ]);
  });
});

test("a SubagentStop firing queues the state, owned by the parent session, its socket and the subagent", async () => {
  await withPlace(async (place) => {
    const fired = await fire(place, {
      payload: subagentStopPayload(place.worktree),
      environment: { CLAUDE_CODE_MESSAGING_SOCKET: SOCKET },
    });

    assert.deepEqual(fired, { code: 0, stderr: "", elapsedMs: fired.elapsedMs });
    assert.deepEqual(recordsIn(place), [
      {
        head: HEAD,
        activity: null,
        owner: { sessionId: SESSION_ID, subagent: AGENT_ID, messagingSocket: SOCKET },
        status: "queued",
      },
    ]);
  });
});

test("the hook returns while the host it started is still running", async () => {
  await withPlace(async (place) => {
    // The stand-in host holds the lock for a minute, as a host running a round would.
    const fired = await fire(place, { payload: stopPayload(place.worktree) });

    assert.equal(fired.code, 0);
    assert.ok(fired.elapsedMs < 30_000, `the hook took ${fired.elapsedMs}ms`);
    await eventually(() => hostsThatTook(place).length === 1, "a host taking the episode");
    const [host = 0] = hostsThatTook(place);
    assert.ok(alive(host), "the host had exited by the time the hook returned");
  });
});

test("the trigger is asked as a hook, from the payload's cwd, with its environment", async () => {
  await withPlace(async (place) => {
    const environment = { CLAUDE_CODE_MESSAGING_SOCKET: SOCKET, HERDR_WORKSPACE_ID: "w2" };
    await fire(place, { payload: subagentStopPayload(place.worktree), environment, trigger: { as: "recording" } });

    const request = JSON.parse(reported(place)) as Record<string, unknown>;
    assert.equal(request["trigger"], "hook");
    assert.equal(request["directory"], place.worktree);
    assert.deepEqual(request["environment"], environment);
    assert.equal(request["pullRequest"], undefined, "a hook names no pull request, and reviews the branch's");
    assert.ok(Number(request["remainingMs"]) > 0, "the trigger was given no time");
  });
});

test("a hook run in another repository queues for the payload's worktree, and writes nothing where it ran", async () => {
  await withPlace(async (place) => {
    // A plugin checkout on a branch of its own, as Copilot runs the plugin's hook in.
    const plugin = realpathSync(await mkdtemp(join(tmpdir(), "squiz-hook-plugin-")));
    try {
      git(plugin, "init", "--quiet", "--initial-branch", "plugin-main");
      git(plugin, "-c", "user.email=squiz@example.invalid", "-c", "user.name=Squiz", "-c", "commit.gpgsign=false",
        "commit", "--quiet", "--allow-empty", "--message", "the plugin");

      const fired = await fire(place, { payload: stopPayload(place.worktree), from: plugin });

      assert.deepEqual(fired, { code: 0, stderr: "", elapsedMs: fired.elapsedMs });
      assert.equal(recordsIn(place).length, 1, "nothing was queued for the payload's worktree");
      assert.equal(existsSync(join(plugin, ".squiz")), false, "state was written in the directory the hook ran in");
    } finally {
      await rm(plugin, { recursive: true, force: true });
    }
  });
});

test("Copilot's recorded SubagentStop, fired from outside any worktree, queues for the payload's worktree", async () => {
  await withPlace(async (place) => {
    const payload = JSON.stringify({
      hook_event_name: "SubagentStop",
      session_id: SESSION_ID,
      timestamp: "2026-10-06T05:34:55.034Z",
      cwd: place.worktree,
      transcript_path: `/copilot-home/session-state/${SESSION_ID}/events.jsonl`,
      agent_id: AGENT_ID,
      agent_type: "explore",
      agent_name: "explore",
      last_assistant_message: "PONG",
      stop_reason: "end_turn",
    });

    const fired = await fire(place, { payload, environment: { COPILOT_CLI: "1", CLAUDE_CODE_MESSAGING_SOCKET: SOCKET } });

    assert.deepEqual(fired, { code: 0, stderr: "", elapsedMs: fired.elapsedMs });
    assert.deepEqual(recordsIn(place), [
      { head: HEAD, activity: null, owner: { sessionId: SESSION_ID, subagent: AGENT_ID }, status: "queued" },
    ]);
  });
});

test("a payload's cwd in a subdirectory of the worktree queues at the worktree's root", async () => {
  await withPlace(async (place) => {
    const inside = join(place.worktree, "src", "deep");
    mkdirSync(inside, { recursive: true });

    const fired = await fire(place, { payload: stopPayload(inside) });

    assert.deepEqual(fired, { code: 0, stderr: "", elapsedMs: fired.elapsedMs });
    assert.equal(recordsIn(place).length, 1);
  });
});

test("a payload with no cwd asks the trigger nothing, exits 0, and says why in one line", async () => {
  await withPlace(async (place) => {
    // Fired from inside the worktree, where reading the hook's own directory would queue.
    const fired = await fire(place, {
      payload: stopPayload(place.worktree, { cwd: undefined }),
      from: place.worktree,
      trigger: { as: "recording" },
    });

    assert.equal(fired.code, 0);
    assert.match(fired.stderr, /^squiz: nothing was queued: [^\n]*"cwd"[^\n]*\n$/u);
    assert.equal(reported(place), "", "the trigger was asked");
  });
});

test("a payload whose cwd is no git worktree queues nothing, exits 0, and says why in one line", async () => {
  await withPlace(async (place) => {
    const fired = await fire(place, { payload: stopPayload(place.bin), from: place.worktree });

    assert.equal(fired.code, 0);
    assert.match(fired.stderr, /^squiz: nothing was queued: the worktree could not be resolved: [^\n]*\n$/u);
    assert.equal(existsSync(join(place.worktree, ".squiz")), false, "state was written in the directory the hook ran in");
    assert.equal(existsSync(join(place.bin, ".squiz")), false, "state was written in the payload's cwd");
  });
});

test("a trigger that throws exits 0 with one line naming what it threw", async () => {
  await withPlace(async (place) => {
    const fired = await fire(place, { payload: stopPayload(place.worktree), trigger: { as: "throwing", message: "the trigger exploded" } });

    assert.equal(fired.code, 0);
    assert.match(fired.stderr, /^squiz: [^\n]*the trigger exploded\n$/u);
  });
});

test("a SubagentStop with an empty agent_type asks the trigger nothing and says nothing", async () => {
  await withPlace(async (place) => {
    const fired = await fire(place, { payload: subagentStopPayload(place.worktree, { agent_type: "" }), trigger: { as: "recording" } });

    assert.deepEqual(fired, { code: 0, stderr: "", elapsedMs: fired.elapsedMs });
    assert.equal(reported(place), "", "the trigger was asked");
  });
});

// Copilot's firings name the parent's transcript, whichever turn ended.
const COPILOT_PARENT = "57444f75-0c1e-4d6b-9a2f-3b8e1d7c5a60";
const COPILOT_SUBAGENT = "829422d1-6f3a-4b9e-8c2d-7e1f0a5b4c39";

function copilotStopPayload(cwd: string, sessionId: string): string {
  return JSON.stringify({
    hook_event_name: "Stop",
    session_id: sessionId,
    timestamp: "2026-10-06T05:34:54.854Z",
    cwd,
    transcript_path: `/Users/someone/.copilot/session-state/${COPILOT_PARENT}/events.jsonl`,
    stop_reason: "end_turn",
    stop_hook_active: false,
  });
}

test("a Copilot Stop queues the state owned by the session, and records no socket its environment carries", async () => {
  await withPlace(async (place) => {
    const fired = await fire(place, {
      payload: copilotStopPayload(place.worktree, COPILOT_PARENT),
      environment: { COPILOT_CLI: "1", CLAUDE_CODE_MESSAGING_SOCKET: SOCKET },
    });

    assert.deepEqual(fired, { code: 0, stderr: "", elapsedMs: fired.elapsedMs });
    assert.deepEqual(recordsIn(place), [{ head: HEAD, activity: null, owner: { sessionId: COPILOT_PARENT }, status: "queued" }]);
  });
});

test("a Copilot Stop records the socket squiz's extension listens on beside the session's transcript", async () => {
  await withPlace(async (place) => {
    // Under /tmp, where a socket path stays inside the 104 bytes macOS allows.
    const home = await mkdtemp("/tmp/squiz-ch-");
    const directory = join(home, "session-state", COPILOT_PARENT);
    mkdirSync(directory, { recursive: true });
    const socket = join(directory, "squiz.sock");
    const extension = createServer((connection) => connection.resume());
    await new Promise<void>((resolve) => extension.listen(socket, resolve));
    try {
      const fields = JSON.parse(copilotStopPayload(place.worktree, COPILOT_PARENT)) as Record<string, unknown>;
      const payload = JSON.stringify({ ...fields, transcript_path: join(directory, "events.jsonl") });

      const fired = await fire(place, { payload, environment: { COPILOT_CLI: "1", CLAUDE_CODE_MESSAGING_SOCKET: SOCKET } });

      assert.deepEqual(fired, { code: 0, stderr: "", elapsedMs: fired.elapsedMs });
      assert.deepEqual(recordsIn(place), [
        { head: HEAD, activity: null, owner: { sessionId: COPILOT_PARENT, messagingSocket: socket }, status: "queued" },
      ]);
    } finally {
      await new Promise((resolve) => extension.close(resolve));
      await rm(home, { recursive: true, force: true });
    }
  });
});

test("a Copilot Stop for a subagent's turn asks the trigger nothing and says nothing", async () => {
  await withPlace(async (place) => {
    const fired = await fire(place, {
      payload: copilotStopPayload(place.worktree, COPILOT_SUBAGENT),
      environment: { COPILOT_CLI: "1" },
      trigger: { as: "recording" },
    });

    assert.deepEqual(fired, { code: 0, stderr: "", elapsedMs: fired.elapsedMs });
    assert.equal(reported(place), "", "the trigger was asked");
  });
});

test("a payload that cannot be read asks the trigger nothing, exits 0, and says why in one line", async () => {
  await withPlace(async (place) => {
    for (const payload of ["", "{not json", subagentStopPayload(place.worktree, { agent_id: "" })]) {
      const fired = await fire(place, { payload, trigger: { as: "recording" } });

      assert.equal(fired.code, 0);
      assert.match(fired.stderr, /^squiz: [^\n]+\n$/u, `for ${JSON.stringify(payload)}`);
      assert.equal(reported(place), "", `the trigger was asked for ${JSON.stringify(payload)}`);
    }
  });
});

test("a branch with no pull request writes the line naming the branch and the directory, and nothing else", async () => {
  await withPlace(async (place) => {
    writeFileSync(join(place.bin, "list.out"), "[]", "utf8");

    const fired = await fire(place, { payload: stopPayload(place.worktree) });

    assert.equal(fired.code, 0);
    assert.equal(
      fired.stderr,
      `squiz: no review ran: no open pull request has "${BRANCH}" as its head, in ${JSON.stringify(place.worktree)}\n`,
    );
    assert.equal(existsSync(join(place.worktree, ".squiz")), false, "a firing with no pull request wrote state");
  });
});

test("a trigger that could not read what it decides from says so in one line", async () => {
  await withPlace(async (place) => {
    writeFileSync(join(place.bin, "list.status"), "1", "utf8");

    const fired = await fire(place, { payload: stopPayload(place.worktree) });

    assert.equal(fired.code, 0);
    assert.match(fired.stderr, /^squiz: nothing was queued: the pull request for "feature-a" could not be looked up: [^\n]*\n$/u);
  });
});

test("a state file that cannot be read queues nothing, starts no host, posts no comment, and says why in one line", async () => {
  await withPlace(async (place) => {
    const episode = episodeAt(place.worktree, NUMBER);
    mkdirSync(episode.directory, { recursive: true });
    writeFileSync(episode.stateFile, "{ not json", "utf8");

    const fired = await fire(place, { payload: stopPayload(place.worktree) });

    assert.equal(fired.code, 0);
    assert.ok(
      fired.stderr.startsWith(`squiz: nothing was queued: ${episode.stateFile} is not valid JSON: `),
      `the line does not name the file and the parser's error: ${fired.stderr}`,
    );
    assert.equal(fired.stderr.split("\n").length, 2, "one line, and nothing else");
    assert.equal(readFileSync(episode.stateFile, "utf8"), "{ not json", "the hook wrote over the file it could not read");
    assert.deepEqual(hostsThatTook(place), [], "a host was started for a state nothing queued");
    const calls = readFileSync(join(place.bin, "calls.log"), "utf8");
    assert.match(calls, /^pr list /mu, "the stand-in gh was never reached");
    assert.doesNotMatch(calls, /\/comments/u, "a comment was posted on the pull request");
  });
});

test("a host that could not be started says so in one line, the state queued", async () => {
  await withPlace(async (place) => {
    const fired = await fire(place, {
      payload: stopPayload(place.worktree),
      trigger: { as: "real", hostCommand: join(place.bin, "no-such-host") },
    });

    assert.equal(fired.code, 0);
    assert.match(fired.stderr, new RegExp(`^squiz: the round host for PR #${NUMBER} could not be started: [^\\n]*\\n$`, "u"));
    assert.equal(recordsIn(place).length, 1);
  });
});
