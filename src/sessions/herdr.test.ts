import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { closeHerdrPane, insideHerdr, startInHerdrPane, type HerdrOptions, type PaneCommand } from "./herdr.ts";
import { identityOf, stillRunning } from "./process.ts";

const BOUND_MS = 10_000;

/** One answer a fake `herdr` gives: what it prints, and what it exits with. */
type Answer = {
  readonly stdout: string;
  readonly status?: number;
  readonly sleepSeconds?: number;
  /** Print it on stderr instead, as Herdr prints a refusal. */
  readonly onStderr?: boolean;
};

const json = (value: unknown): Answer => ({ stdout: `${JSON.stringify(value)}\n` });
const refusal = (code: string): Answer => ({
  stdout: `${JSON.stringify({ error: { code, message: `${code} said` }, id: "cli" })}\n`,
  status: 1,
  onStderr: true,
});
const tabCreated = (pane: string): Answer =>
  json({ id: "cli:tab:create", result: { root_pane: { pane_id: pane, tab_id: "w1:t9" }, type: "tab_created" } });
const agentStarted = (name: string, pane: string): Answer =>
  json({
    id: "cli:agent:start",
    result: { agent: { agent: "pi", name, pane_id: pane, interactive_ready: true }, type: "agent_started" },
  });
const processInfo = (pane: string, group: number, shell: number): Answer =>
  json({
    id: "cli:pane:process_info",
    result: {
      process_info: {
        foreground_process_group_id: group,
        foreground_processes: [{ name: "node", pid: group }],
        pane_id: pane,
        shell_pid: shell,
      },
      type: "pane_process_info",
    },
  });
const paneInfo = (pane: string): Answer =>
  json({ id: "cli:pane:get", result: { pane: { pane_id: pane }, type: "pane_info" } });
const closedOk: Answer = json({ id: "cli:pane:close", result: { type: "ok" } });

/**
 * A `herdr` on `PATH` that answers from `answers`, keyed by its first two
 * arguments joined with a dash, and records every call.
 *
 * A key's answers are given in turn, and the last one repeats. A call no key
 * names is refused as `unexpected_call`.
 */
type FakeHerdr = { readonly options: HerdrOptions; readonly calls: () => readonly string[] };

function withFakeHerdr<T>(answers: Record<string, readonly Answer[]>, body: (fake: FakeHerdr) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "squiz-sessions-herdr-"));
  try {
    for (const [key, list] of Object.entries(answers)) {
      list.forEach((answer, index) => {
        const names = [`${key}-${index + 1}`, ...(index === list.length - 1 ? [`${key}-last`] : [])];
        for (const name of names) {
          writeFileSync(join(directory, `answer-${name}.out`), answer.stdout, "utf8");
          writeFileSync(join(directory, `answer-${name}.status`), String(answer.status ?? 0), "utf8");
          if (answer.onStderr === true) writeFileSync(join(directory, `answer-${name}.stderr`), "", "utf8");
          if (answer.sleepSeconds !== undefined) {
            writeFileSync(join(directory, `answer-${name}.sleep`), String(answer.sleepSeconds), "utf8");
          }
        }
      });
    }
    const fake = join(directory, "herdr");
    writeFileSync(
      fake,
      [
        "#!/bin/sh",
        '[ "$1" = warm ] && exit 0',
        'dir=$(dirname "$0")',
        'printf "%s\\n" "$*" >> "$dir/calls"',
        'key="$1-$2"',
        'n=$(cat "$dir/count-$key" 2>/dev/null || echo 0)',
        "n=$((n + 1))",
        'echo "$n" > "$dir/count-$key"',
        'answer="$dir/answer-$key-$n"',
        '[ -f "$answer.out" ] || answer="$dir/answer-$key-last"',
        '[ -f "$answer.out" ] || { echo \'{"error":{"code":"unexpected_call","message":"no answer"}}\'; exit 1; }',
        '[ -f "$answer.sleep" ] && sleep "$(cat "$answer.sleep")"',
        'if [ -f "$answer.stderr" ]; then cat "$answer.out" >&2; else cat "$answer.out"; fi',
        'exit "$(cat "$answer.status")"',
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(fake, 0o755);
    // macOS checks a new executable the first time it runs, which under load can spend a bound.
    spawnSync(fake, ["warm"], { stdio: "ignore" });

    const calls = (): readonly string[] => {
      const path = join(directory, "calls");
      return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((line) => line !== "") : [];
    };
    return body({
      options: {
        environment: { PATH: `${directory}:/usr/bin:/bin`, HERDR_SOCKET_PATH: join(directory, "none.sock") },
        boundMs: BOUND_MS,
      },
      calls,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const command: PaneCommand = {
  directory: "/somewhere",
  name: "squiz-test",
  kind: "pi",
  arguments: ["--first", "two words"],
  readyWithinMs: 20_000,
};

test("only an environment with HERDR_SOCKET_PATH set is inside Herdr", () => {
  assert.equal(insideHerdr({ HERDR_SOCKET_PATH: "/run/herdr.sock" }), true);
  assert.equal(insideHerdr({ HERDR_SOCKET_PATH: "" }), false);
  assert.equal(insideHerdr({ TMUX: "/tmp/tmux" }), false);
});

test("a started command's leader is the pane's foreground group, read again by ps", () => {
  withFakeHerdr(
    {
      "tab-create": [tabCreated("w1:p7")],
      "agent-start": [agentStarted("squiz-test", "w1:p7")],
      "pane-process-info": [processInfo("w1:p7", process.pid, 1)],
    },
    ({ options, calls }) => {
      const own = identityOf(process.pid, BOUND_MS);
      assert.equal(own.outcome, "read");

      const started = startInHerdrPane(command, options);

      assert.deepEqual(started, {
        outcome: "started",
        pane: "w1:p7",
        leader: own.outcome === "read" ? own.identity : undefined,
      });
      assert.deepEqual(calls(), [
        "tab create --cwd /somewhere --label squiz-test --no-focus",
        "agent start squiz-test --kind pi --pane w1:p7 --timeout 20000 -- --first two words",
        "pane process-info --pane w1:p7",
        "pane process-info --pane w1:p7",
      ]);
    },
  );
});

test("a pane Herdr refuses to open is refused, and nothing more is asked of it", () => {
  withFakeHerdr({ "tab-create": [refusal("workspace_not_found")] }, ({ options, calls }) => {
    const started = startInHerdrPane(command, options);

    assert.equal(started.outcome, "refused", JSON.stringify(started));
    assert.match("reason" in started ? started.reason : "", /workspace_not_found/u);
    assert.equal(calls().length, 1);
  });
});

test("a command given a workspace opens its tab there", () => {
  withFakeHerdr(
    {
      "tab-create": [tabCreated("w2:p7")],
      "agent-start": [agentStarted("squiz-test", "w2:p7")],
      "pane-process-info": [processInfo("w2:p7", process.pid, 1)],
    },
    ({ options, calls }) => {
      const started = startInHerdrPane({ ...command, workspace: "w2" }, options);

      assert.equal(started.outcome, "started", JSON.stringify(started));
      assert.equal(calls()[0], "tab create --cwd /somewhere --label squiz-test --no-focus --workspace w2");
    },
  );
});

test("a workspace that is not Herdr's shape is refused, and herdr is never run with it", () => {
  for (const workspace of ["--focus", "", "w", "w1:p2", "W1", "w01", "w1 w2"]) {
    withFakeHerdr({ "tab-create": [tabCreated("w1:p7")] }, ({ options, calls }) => {
      const started = startInHerdrPane({ ...command, workspace }, options);

      assert.equal(started.outcome, "refused", `${JSON.stringify(workspace)} read as ${JSON.stringify(started)}`);
      assert.deepEqual(calls(), [], `herdr was run for ${JSON.stringify(workspace)}`);
    });
  }
});

test("a workspace Herdr no longer has opens the tab in the focused one instead", () => {
  withFakeHerdr(
    {
      "tab-create": [refusal("workspace_not_found"), tabCreated("w1:p7")],
      "agent-start": [agentStarted("squiz-test", "w1:p7")],
      "pane-process-info": [processInfo("w1:p7", process.pid, 1)],
    },
    ({ options, calls }) => {
      const started = startInHerdrPane({ ...command, workspace: "w2" }, options);

      assert.equal(started.outcome, "started", JSON.stringify(started));
      assert.deepEqual(calls().slice(0, 2), [
        "tab create --cwd /somewhere --label squiz-test --no-focus --workspace w2",
        "tab create --cwd /somewhere --label squiz-test --no-focus",
      ]);
    },
  );
});

test("a server with no workspace at all still refuses when one was named", () => {
  withFakeHerdr({ "tab-create": [refusal("workspace_not_found")] }, ({ options, calls }) => {
    const started = startInHerdrPane({ ...command, workspace: "w2" }, options);

    assert.equal(started.outcome, "refused", JSON.stringify(started));
    assert.equal(calls().length, 2);
  });
});

test("a herdr that is not on the path is refused", () => {
  const empty = mkdtempSync(join(tmpdir(), "squiz-sessions-herdr-path-"));
  try {
    const started = startInHerdrPane(command, {
      environment: { PATH: empty, HERDR_SOCKET_PATH: join(empty, "none.sock") },
      boundMs: BOUND_MS,
    });
    assert.equal(started.outcome, "refused", JSON.stringify(started));
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

// Every case below may have opened a pane, so none of them is a refusal the
// caller could fall back from by starting the command a second time.

test("a tab create whose answer cannot be read failed, and is not read as a pane", () => {
  for (const answer of [
    { stdout: "Created tab w1:t2\n" },
    { stdout: "Created tab w1:t2\n", status: 1 },
    json({ id: "cli:tab:create", result: { root_pane: { pane_id: 7 } } }),
    json({ id: "cli:tab:create", result: { root_pane: { pane_id: "" } } }),
    json({ id: "cli:tab:create", error: { code: "odd" }, result: { root_pane: { pane_id: "w1:p1" } } }),
    json([]),
  ]) {
    // Every later call is answered as if pane w1:p1 had opened, so a start that
    // made a pane up from this answer would come back started.
    const later = {
      "agent-start": [agentStarted("squiz-test", "w1:p1")],
      "pane-process-info": [processInfo("w1:p1", process.pid, 1)],
    };
    withFakeHerdr({ "tab-create": [answer], ...later }, ({ options, calls }) => {
      const started = startInHerdrPane(command, options);
      assert.equal(started.outcome, "failed", `${JSON.stringify(answer)} read as ${JSON.stringify(started)}`);
      assert.equal(calls().length, 1, `more was asked after ${JSON.stringify(answer)}: ${calls().join("; ")}`);
    });
  }
});

test("a tab create that does not answer within the bound failed, and is not waited out", () => {
  withFakeHerdr({ "tab-create": [{ ...tabCreated("w1:p7"), sleepSeconds: 30 }] }, ({ options }) => {
    const begun = Date.now();
    const started = startInHerdrPane(command, { ...options, boundMs: 300 });
    const elapsedMs = Date.now() - begun;

    assert.equal(started.outcome, "failed", JSON.stringify(started));
    assert.match("reason" in started ? started.reason : "", /300ms/u);
    assert.ok(elapsedMs < 5_000, `the herdr was waited on for ${elapsedMs}ms`);
  });
});

test("a command Herdr would not start failed, and its pane is closed", () => {
  withFakeHerdr(
    {
      "tab-create": [tabCreated("w1:p7")],
      "agent-start": [refusal("timeout")],
      "pane-close": [closedOk],
      "pane-get": [refusal("pane_not_found")],
    },
    ({ options, calls }) => {
      const started = startInHerdrPane(command, options);

      assert.equal(started.outcome, "failed", JSON.stringify(started));
      assert.match("reason" in started ? started.reason : "", /timeout/u);
      assert.equal("paneLeftOpen" in started, false, JSON.stringify(started));
      assert.deepEqual(calls().slice(2), ["pane close w1:p7", "pane get w1:p7"]);
    },
  );
});

test("a foreground group that is the shell's is never returned, and the pane is closed", () => {
  withFakeHerdr(
    {
      "tab-create": [tabCreated("w1:p7")],
      "agent-start": [agentStarted("squiz-test", "w1:p7")],
      "pane-process-info": [processInfo("w1:p7", 4242, 4242)],
      "pane-close": [closedOk],
      "pane-get": [refusal("pane_not_found")],
    },
    ({ options, calls }) => {
      const started = startInHerdrPane(command, options);

      assert.equal(started.outcome, "failed", JSON.stringify(started));
      assert.match("reason" in started ? started.reason : "", /shell/u);
      assert.deepEqual(calls().slice(-2), ["pane close w1:p7", "pane get w1:p7"]);
    },
  );
});

test("a foreground group that changes while its leader is read is never returned", () => {
  withFakeHerdr(
    {
      "tab-create": [tabCreated("w1:p7")],
      "agent-start": [agentStarted("squiz-test", "w1:p7")],
      "pane-process-info": [processInfo("w1:p7", process.pid, 1), processInfo("w1:p7", 1, 1)],
      "pane-close": [closedOk],
      "pane-get": [refusal("pane_not_found")],
    },
    ({ options }) => {
      const started = startInHerdrPane(command, options);
      assert.equal(started.outcome, "failed", JSON.stringify(started));
    },
  );
});

test("process info that cannot be read failed, and the pane is closed", () => {
  for (const answer of [
    json({ id: "cli:pane:process_info", result: { process_info: { shell_pid: 1 } } }),
    json({ id: "cli:pane:process_info", result: { process_info: { foreground_process_group_id: "9", shell_pid: 1 } } }),
    json({ id: "cli:pane:process_info", result: { process_info: { foreground_process_group_id: 9.5, shell_pid: 1 } } }),
    { stdout: "not json" },
  ]) {
    withFakeHerdr(
      {
        "tab-create": [tabCreated("w1:p7")],
        "agent-start": [agentStarted("squiz-test", "w1:p7")],
        "pane-process-info": [answer],
        "pane-close": [closedOk],
        "pane-get": [refusal("pane_not_found")],
      },
      ({ options, calls }) => {
        const started = startInHerdrPane(command, options);
        assert.equal(started.outcome, "failed", `${JSON.stringify(answer)} read as ${JSON.stringify(started)}`);
        assert.deepEqual(calls().slice(-2), ["pane close w1:p7", "pane get w1:p7"]);
      },
    );
  }
});

test("a pane that could not be confirmed closed after a failed start is named", () => {
  withFakeHerdr(
    {
      "tab-create": [tabCreated("w1:p7")],
      "agent-start": [refusal("agent_not_ready")],
      "pane-close": [closedOk],
      "pane-get": [paneInfo("w1:p7")],
    },
    ({ options }) => {
      const started = startInHerdrPane(command, options);
      assert.equal(started.outcome, "failed", JSON.stringify(started));
      assert.equal("paneLeftOpen" in started ? started.paneLeftOpen : undefined, "w1:p7");
    },
  );
});

test("a pane is closed only once Herdr no longer has it", () => {
  withFakeHerdr({ "pane-close": [closedOk], "pane-get": [refusal("pane_not_found")] }, ({ options, calls }) => {
    assert.deepEqual(closeHerdrPane("w1:p7", options), { outcome: "closed" });
    assert.deepEqual(calls(), ["pane close w1:p7", "pane get w1:p7"]);
  });

  for (const afterwards of [paneInfo("w1:p7"), refusal("server_not_running"), { stdout: "??" }]) {
    withFakeHerdr({ "pane-close": [closedOk], "pane-get": [afterwards] }, ({ options }) => {
      const closed = closeHerdrPane("w1:p7", options);
      assert.equal(closed.outcome, "failed", `${JSON.stringify(afterwards)} read as ${JSON.stringify(closed)}`);
    });
  }
});

test("a pane Herdr no longer has is closed, whatever the close said", () => {
  const answers = { "pane-close": [refusal("pane_not_found")], "pane-get": [refusal("pane_not_found")] };
  withFakeHerdr(answers, ({ options }) => {
    assert.deepEqual(closeHerdrPane("w1:p7", options), { outcome: "closed" });
  });
});

// Against a real Herdr. Every call here goes to a private server, under a home
// directory of its own, so neither the owner's server nor their configuration
// is touched.

const herdrInstalled = spawnSync("herdr", ["--version"], { stdio: "ignore" }).status === 0;

describe("against a private Herdr server", { skip: herdrInstalled ? false : "herdr is not installed" }, () => {
  // A Unix socket's path is short (104 bytes on macOS), and the socket sits
  // four directories below the home, so both names are kept short.
  const session = `sqt-${process.pid}`;
  let home = "";
  let server: ChildProcess | undefined;
  let options: HerdrOptions = { environment: {}, boundMs: BOUND_MS };
  let fakes = "";

  /** The environment every herdr here runs with, with nothing of the owner's Herdr in it. */
  const environmentFor = (extra: Record<string, string>): Record<string, string | undefined> => {
    const base = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("HERDR_") && name !== "ZDOTDIR"),
    );
    return { ...base, HOME: home, ...extra };
  };

  const herdr = (args: readonly string[]): { status: number | null; output: string } => {
    const result = spawnSync("herdr", args, {
      encoding: "utf8",
      env: options.environment as NodeJS.ProcessEnv,
      timeout: BOUND_MS,
    });
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  };

  before(async () => {
    home = mkdtempSync("/tmp/sqh-");
    fakes = join(home, "bin");
    mkdirSync(fakes);
    const herdrPath = spawnSync("/bin/sh", ["-c", "command -v herdr"], { encoding: "utf8" }).stdout.trim();
    // Stands in for the agent: it writes its pid, tells Herdr it is a ready
    // `pi`, and becomes a sleep of the given length with the same pid.
    writeFileSync(
      join(fakes, "pi"),
      [
        "#!/bin/sh",
        'echo "$$" > "$1"',
        `'${herdrPath}' pane report-agent --source squiz-test --agent pi --state idle "$HERDR_PANE_ID" >/dev/null 2>&1`,
        'exec sleep "$2"',
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(join(fakes, "pi"), 0o755);

    const socket = join(home, ".config", "herdr", "sessions", session, "herdr.sock");
    // The pane's shell reads this home's dotfiles, of which there are none, so
    // `pi` is the fake wherever the system's profile puts it on the path.
    server = spawn(herdrPath, ["--session", session, "server"], {
      env: environmentFor({ PATH: `${fakes}:/usr/bin:/bin` }) as NodeJS.ProcessEnv,
      stdio: "ignore",
    });
    for (let tries = 0; tries < 100 && !existsSync(socket); tries += 1) {
      await new Promise((settle) => setTimeout(settle, 100));
    }
    assert.ok(existsSync(socket), `the private Herdr server made no socket at ${socket}`);
    options = { environment: environmentFor({ HERDR_SOCKET_PATH: socket }), boundMs: BOUND_MS };
  });

  after(() => {
    if (home === "") return;
    const environment = environmentFor({}) as NodeJS.ProcessEnv;
    spawnSync("herdr", ["session", "stop", session], { env: environment, stdio: "ignore", timeout: BOUND_MS });
    spawnSync("herdr", ["session", "delete", session], { env: environment, stdio: "ignore", timeout: BOUND_MS });
    server?.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });

  const fakeCommand = (name: string, pidFile: string, seconds: number): PaneCommand => ({
    directory: home,
    name,
    kind: "pi",
    arguments: [pidFile, String(seconds)],
    readyWithinMs: 20_000,
  });

  test("a server with no workspace to open a tab in refuses, and opens nothing", () => {
    const started = startInHerdrPane(fakeCommand("squiz-none", join(home, "none.pid"), 30), options);

    assert.equal(started.outcome, "refused", JSON.stringify(started));
    assert.equal(existsSync(join(home, "none.pid")), false, "the command ran");
  });

  test("the leader is the process running the command, not the pane's shell", () => {
    const created = herdr(["workspace", "create", "--cwd", home, "--no-focus"]);
    assert.equal(created.status, 0, `no workspace was created: ${created.output}`);

    const pidFile = join(home, "running.pid");
    const started = startInHerdrPane(fakeCommand("squiz-running", pidFile, 60), options);
    assert.equal(started.outcome, "started", JSON.stringify(started));
    if (started.outcome !== "started") return;

    try {
      assert.equal(started.leader.pid, Number(readFileSync(pidFile, "utf8").trim()));
      const info = JSON.parse(herdr(["pane", "process-info", "--pane", started.pane]).output);
      assert.notEqual(started.leader.pid, info.result.process_info.shell_pid);
      assert.deepEqual(stillRunning(started.leader, BOUND_MS), { outcome: "running" });
    } finally {
      assert.deepEqual(closeHerdrPane(started.pane, options), { outcome: "closed" });
    }
  });

  test("a tab opens in the workspace it is given, and in the focused one otherwise", () => {
    const workspaces = (): { workspace_id: string; focused: boolean }[] =>
      JSON.parse(herdr(["workspace", "list"]).output).result.workspaces;
    // The first workspace a server has is focused, whatever it was created with.
    if (workspaces().length === 0) assert.equal(herdr(["workspace", "create", "--cwd", home]).status, 0);
    const created = herdr(["workspace", "create", "--cwd", home, "--no-focus"]);
    assert.equal(created.status, 0, `no workspace was created: ${created.output}`);
    const unfocused: unknown = JSON.parse(created.output).result.workspace.workspace_id;
    const listed = workspaces();
    const focused = listed.find((workspace) => workspace.focused)?.workspace_id;
    assert.ok(typeof unfocused === "string" && focused !== undefined && focused !== unfocused, JSON.stringify(listed));

    // A workspace Herdr never had stands for one that has since closed: Herdr does not reuse an id.
    for (const [given, expected] of [[unfocused, unfocused], [undefined, focused], ["w999", focused]] as const) {
      const name = `squiz-ws-${given ?? "none"}`;
      const started = startInHerdrPane(
        { ...fakeCommand(name, join(home, `${name}.pid`), 60), ...(given === undefined ? {} : { workspace: given }) },
        options,
      );
      assert.equal(started.outcome, "started", `given ${given}: ${JSON.stringify(started)}`);
      if (started.outcome !== "started") continue;
      try {
        const pane = JSON.parse(herdr(["pane", "get", started.pane]).output);
        assert.equal(pane.result.pane.workspace_id, expected, `given ${given}, the tab opened in ${pane.result.pane.workspace_id}`);
      } finally {
        assert.deepEqual(closeHerdrPane(started.pane, options), { outcome: "closed" });
      }
    }
  });

  test("once the command exits and the pane is back at its shell, the pane closes", async () => {
    const started = startInHerdrPane(fakeCommand("squiz-exits", join(home, "exits.pid"), 8), options);
    assert.equal(started.outcome, "started", JSON.stringify(started));
    if (started.outcome !== "started") return;

    let presence = stillRunning(started.leader, BOUND_MS);
    for (let tries = 0; tries < 200 && presence.outcome === "running"; tries += 1) {
      await new Promise((settle) => setTimeout(settle, 100));
      presence = stillRunning(started.leader, BOUND_MS);
    }
    assert.deepEqual(presence, { outcome: "gone" });
    const info = JSON.parse(herdr(["pane", "process-info", "--pane", started.pane]).output);
    assert.equal(info.result.process_info.foreground_process_group_id, info.result.process_info.shell_pid);

    assert.deepEqual(closeHerdrPane(started.pane, options), { outcome: "closed" });
    const afterwards = herdr(["pane", "get", started.pane]);
    assert.match(afterwards.output, /pane_not_found/u);
  });
});
