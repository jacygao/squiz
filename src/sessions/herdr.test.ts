import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { closeHerdrPane, insideHerdr, startInHerdrPane, type HerdrOptions, type PaneCommand } from "./herdr.ts";
import { identityOf, stillRunning } from "./process.ts";

const BOUND_MS = 10_000;

/** One answer the fake Herdr gives a call. */
type Answer = {
  /** What follows the request's `id` in the answer: a `result` or an `error`. */
  readonly answer?: Readonly<Record<string, unknown>>;
  /** A line sent as it is, in place of `answer`. */
  readonly raw?: string;
  /** How long to wait before answering. */
  readonly sleepMs?: number;
  /** Close the connection with no answer. */
  readonly hangUp?: true;
  /** For `layout.apply`: write this pid into the gate the pane's argv names, as the gate would. */
  readonly gatePid?: number;
  /** For `layout.apply`: run the pane's argv in the background, as Herdr would. */
  readonly runs?: true;
};

const result = (value: unknown): Answer => ({ answer: { result: value } });
const refusal = (code: string): Answer => ({ answer: { error: { code, message: `${code} said` } } });
const layoutApplied = (pane: string, gatePid?: number): Answer => ({
  ...result({ type: "layout_apply", layout: { workspace_id: "w1", tab_id: "w1:t9", root: { type: "pane", pane_id: pane } } }),
  ...(gatePid === undefined ? {} : { gatePid }),
});
const processInfo = (pane: string, group: number, shell: number): Answer =>
  result({
    process_info: {
      foreground_process_group_id: group,
      foreground_processes: [{ name: "sh", pid: shell }],
      pane_id: pane,
      shell_pid: shell,
    },
    type: "pane_process_info",
  });
const paneInfo = (pane: string): Answer => result({ pane: { pane_id: pane }, type: "pane_info" });
const closedOk: Answer = result({ type: "ok" });

/**
 * A Herdr server, in a process of its own, that answers from `answers`, keyed
 * by method, and records every request.
 *
 * A method's answers are given in turn, and the last one repeats. A method no
 * key names is refused as `unexpected_call`.
 */
const FAKE_SERVER = `
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const [dir, socket] = process.argv.slice(1);
const answers = JSON.parse(fs.readFileSync(path.join(dir, "answers.json"), "utf8"));
const counts = {};
require("node:net").createServer((connection) => {
  let buffer = "";
  connection.on("data", (chunk) => {
    buffer += chunk;
    const end = buffer.indexOf("\\n");
    if (end === -1) return;
    const request = JSON.parse(buffer.slice(0, end));
    fs.appendFileSync(path.join(dir, "calls"), JSON.stringify({ method: request.method, params: request.params }) + "\\n");
    const list = answers[request.method];
    if (list === undefined) {
      connection.end(JSON.stringify({ id: request.id, error: { code: "unexpected_call", message: "no answer" } }) + "\\n");
      return;
    }
    counts[request.method] = (counts[request.method] ?? 0) + 1;
    const answer = list[Math.min(counts[request.method], list.length) - 1];
    const argv = request.params?.root?.command ?? [];
    if (answer.gatePid !== undefined) {
      fs.appendFileSync(path.join(dir, "gates"), argv[3] + "\\n");
      fs.writeFileSync(path.join(argv[3], "pid"), String(answer.gatePid));
    }
    if (answer.runs === true) {
      fs.appendFileSync(path.join(dir, "gates"), argv[3] + "\\n");
      const env = { ...process.env, ...request.params.root.env };
      spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore", env }).unref();
    }
    const reply = () => {
      if (answer.hangUp === true) return connection.destroy();
      connection.end((answer.raw ?? JSON.stringify({ id: request.id, ...answer.answer })) + "\\n");
    };
    if (answer.sleepMs === undefined) reply();
    else setTimeout(reply, answer.sleepMs);
  });
}).listen(socket);
`;

type Call = { readonly method: string; readonly params: Record<string, unknown> };
type FakeHerdr = {
  readonly options: HerdrOptions;
  readonly calls: () => readonly Call[];
  /** Where `pi` is, on the only directory of the PATH the start is given. */
  readonly pi: string;
};

/** Each call as `<method> <pane_id>`, the pane left off where there is none. */
const named = (calls: readonly Call[]): string[] =>
  calls.map(({ method, params }) => (typeof params["pane_id"] === "string" ? `${method} ${params["pane_id"]}` : method));

async function withFakeHerdr<T>(answers: Record<string, readonly Answer[]>, body: (fake: FakeHerdr) => T): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "sqf-"));
  const socket = join(directory, "s.sock");
  let server: ChildProcess | undefined;
  try {
    writeFileSync(join(directory, "answers.json"), JSON.stringify(answers), "utf8");
    const pi = join(directory, "pi");
    writeFileSync(pi, "#!/bin/sh\n", { mode: 0o755 });
    server = spawn(process.execPath, ["-e", FAKE_SERVER, directory, socket], { stdio: "ignore" });
    for (let tries = 0; tries < 200 && !existsSync(socket); tries += 1) {
      await new Promise((settle) => setTimeout(settle, 25));
    }
    assert.ok(existsSync(socket), "the fake Herdr made no socket");
    const calls = (): readonly Call[] => {
      const path = join(directory, "calls");
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Call);
    };
    return body({ options: { environment: { HERDR_SOCKET_PATH: socket, PATH: directory }, boundMs: BOUND_MS }, calls, pi });
  } finally {
    server?.kill("SIGKILL");
    // A gate the fake wrote into had no command to remove it once opened.
    const gates = join(directory, "gates");
    if (existsSync(gates)) {
      for (const gate of readFileSync(gates, "utf8").split("\n").filter((line) => line !== "")) {
        rmSync(gate, { recursive: true, force: true });
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

const command: PaneCommand = {
  directory: "/somewhere",
  name: "squiz-test",
  program: "pi",
  arguments: ["--first", "two words"],
  startsWithinMs: 20_000,
};

/** The argv the pane was given, from the start's `layout.apply`. */
function paneArgv(calls: readonly Call[]): readonly string[] {
  const apply = calls.find((call) => call.method === "layout.apply");
  const root = apply?.params["root"] as { command?: string[] } | undefined;
  return root?.command ?? [];
}

test("only an environment with HERDR_SOCKET_PATH set is inside Herdr", () => {
  assert.equal(insideHerdr({ HERDR_SOCKET_PATH: "/run/herdr.sock" }), true);
  assert.equal(insideHerdr({ HERDR_SOCKET_PATH: "" }), false);
  assert.equal(insideHerdr({ TMUX: "/tmp/tmux" }), false);
});

test("a started command's leader is the pane's process, read again by ps", async () => {
  await withFakeHerdr(
    {
      "layout.apply": [layoutApplied("w1:p7", process.pid)],
      "pane.process_info": [processInfo("w1:p7", process.pid, process.pid)],
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
      assert.deepEqual(named(calls()), ["layout.apply", "pane.process_info w1:p7"]);
    },
  );
});

test("the tab is one layout.apply, whose pane execs the gate with no shell (#911)", async () => {
  await withFakeHerdr(
    {
      "layout.apply": [layoutApplied("w1:p7", process.pid)],
      "pane.process_info": [processInfo("w1:p7", process.pid, process.pid)],
    },
    ({ options, calls, pi }) => {
      const variables = { SESSION_MARK: "it's $HOME", GH_TOKEN: "" };
      const started = startInHerdrPane({ ...command, variables }, options);
      assert.equal(started.outcome, "started", JSON.stringify(started));

      const [apply] = calls();
      const { root, ...rest } = apply?.params ?? {};
      assert.equal(apply?.method, "layout.apply");
      assert.deepEqual(rest, { tab_label: "squiz-test", focus: false });
      const { command: argv, ...pane } = root as { command: string[] };
      assert.deepEqual(pane, { type: "pane", cwd: "/somewhere", env: variables, label: "squiz-test" });
      assert.deepEqual(argv.slice(0, 2), ["/bin/sh", "-c"]);
      assert.match(argv[3] ?? "", /squiz-gate-/u);
      assert.deepEqual(argv.slice(5), [pi, "--first", "two words"]);
    },
  );
});

test("every argument reaches the pane's argv as given, control characters too (#911)", async () => {
  const awkward = ["line one\nline two", "a\ttab", "it's $HOME; `id` a\\b \"c\" *", "", "ctrl\u0003c", "del\u007f"];
  await withFakeHerdr(
    {
      "layout.apply": [layoutApplied("w1:p7", process.pid)],
      "pane.process_info": [processInfo("w1:p7", process.pid, process.pid)],
    },
    ({ options, calls, pi }) => {
      const started = startInHerdrPane({ ...command, arguments: awkward }, options);
      assert.equal(started.outcome, "started", JSON.stringify(started));
      assert.deepEqual(paneArgv(calls()).slice(5), [pi, ...awkward]);
    },
  );
});

// The pane's process has the server's PATH, which may lack a directory the caller's has.
test("the program is found on the caller's PATH, or the PATH its variables give, and reaches Herdr absolute (#911)", async () => {
  const answers = {
    "layout.apply": [layoutApplied("w1:p7", process.pid)],
    "pane.process_info": [processInfo("w1:p7", process.pid, process.pid)],
  };
  await withFakeHerdr(answers, ({ options, calls, pi }) => {
    const started = startInHerdrPane({ ...command, variables: { PATH: `/nowhere:${join(pi, "..")}` } }, {
      ...options,
      environment: { ...options.environment, PATH: "/nowhere" },
    });
    assert.equal(started.outcome, "started", JSON.stringify(started));
    assert.equal(paneArgv(calls())[5], pi);
  });
});

test("a program on no directory of the PATH is refused, and Herdr is never called (#911)", async () => {
  await withFakeHerdr({ "layout.apply": [layoutApplied("w1:p7", process.pid)] }, ({ options, calls }) => {
    const started = startInHerdrPane({ ...command, program: "squiz-no-such-reviewer" }, options);
    assert.deepEqual(started, { outcome: "refused", reason: "there is no squiz-no-such-reviewer on the path" });
    assert.deepEqual(calls(), []);
  });
});

test("a gate that lets its command run leaves no directory behind (#453)", async () => {
  await withFakeHerdr(
    {
      "layout.apply": [layoutApplied("w1:p7", process.pid)],
      "pane.process_info": [processInfo("w1:p7", process.pid, process.pid)],
    },
    ({ options, calls }) => {
      const started = startInHerdrPane({ ...command, program: "/bin/sh", arguments: ["-c", "exit 0"] }, options);
      assert.equal(started.outcome, "started", JSON.stringify(started));
      const argv = paneArgv(calls());
      const gate = argv[3] ?? "";
      // The start opened the gate, so the argv runs the command at once, as Herdr would.
      const ran = spawnSync(argv[0] ?? "", argv.slice(1), { encoding: "utf8", timeout: BOUND_MS });
      assert.equal(ran.status, 0, ran.stderr);
      const left = existsSync(gate) ? readdirSync(gate) : [];
      assert.equal(existsSync(gate), false, `the gate still holds ${JSON.stringify(left)}`);
    },
  );
});

test("a pane Herdr refuses to open is refused, and nothing more is asked of it", async () => {
  await withFakeHerdr({ "layout.apply": [refusal("layout_apply_failed")] }, ({ options, calls }) => {
    const started = startInHerdrPane(command, options);

    assert.equal(started.outcome, "refused", JSON.stringify(started));
    assert.match("reason" in started ? started.reason : "", /layout_apply_failed/u);
    assert.equal(calls().length, 1);
  });
});

test("a command given a workspace opens its tab there", async () => {
  await withFakeHerdr(
    {
      "layout.apply": [layoutApplied("w2:p7", process.pid)],
      "pane.process_info": [processInfo("w2:p7", process.pid, process.pid)],
    },
    ({ options, calls }) => {
      const started = startInHerdrPane({ ...command, workspace: "w2" }, options);

      assert.equal(started.outcome, "started", JSON.stringify(started));
      assert.equal(calls()[0]?.params["workspace_id"], "w2");
    },
  );
});

test("a workspace that is not Herdr's shape is refused, and Herdr is never called with it", async () => {
  for (const workspace of ["--focus", "", "w", "w1:p2", "W1", "w01", "w1 w2"]) {
    await withFakeHerdr({ "layout.apply": [layoutApplied("w1:p7")] }, ({ options, calls }) => {
      const started = startInHerdrPane({ ...command, workspace }, options);

      assert.equal(started.outcome, "refused", `${JSON.stringify(workspace)} read as ${JSON.stringify(started)}`);
      assert.deepEqual(calls(), [], `Herdr was called for ${JSON.stringify(workspace)}`);
    });
  }
});

test("a workspace Herdr no longer has opens the tab in the focused one instead", async () => {
  await withFakeHerdr(
    {
      "layout.apply": [refusal("workspace_not_found"), layoutApplied("w1:p7", process.pid)],
      "pane.process_info": [processInfo("w1:p7", process.pid, process.pid)],
    },
    ({ options, calls }) => {
      const started = startInHerdrPane({ ...command, workspace: "w2" }, options);

      assert.equal(started.outcome, "started", JSON.stringify(started));
      const [first, second] = calls();
      assert.equal(first?.params["workspace_id"], "w2");
      assert.equal(second?.method, "layout.apply");
      assert.equal("workspace_id" in (second?.params ?? {}), false, JSON.stringify(second));
    },
  );
});

test("a server with no workspace at all still refuses when one was named", async () => {
  await withFakeHerdr({ "layout.apply": [refusal("workspace_not_found")] }, ({ options, calls }) => {
    const started = startInHerdrPane({ ...command, workspace: "w2" }, options);

    assert.equal(started.outcome, "refused", JSON.stringify(started));
    assert.equal(calls().length, 2);
  });
});

test("a socket no Herdr server answers on is refused", () => {
  const empty = mkdtempSync(join(tmpdir(), "squiz-sessions-herdr-none-"));
  try {
    const started = startInHerdrPane(command, {
      environment: { HERDR_SOCKET_PATH: join(empty, "none.sock") },
      boundMs: BOUND_MS,
    });
    assert.equal(started.outcome, "refused", JSON.stringify(started));
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

// Every case below may have opened a pane, so none of them is a refusal the
// caller could fall back from by starting the command a second time.

test("a layout.apply whose answer cannot be read failed, and is not read as a pane", async () => {
  for (const answer of [
    { raw: "Created tab w1:t2" },
    { raw: "" },
    { hangUp: true } as const,
    result({ layout: { root: { pane_id: 7 } } }),
    result({ layout: { root: { pane_id: "" } } }),
    result({ root_pane: { pane_id: "w1:p1" } }),
    { answer: { error: { code: "odd" }, result: layoutApplied("w1:p1").answer?.["result"] } },
    { raw: "[]" },
  ]) {
    // Every later call is answered as if pane w1:p1 had opened, so a start that
    // made a pane up from this answer would come back started.
    const later = { "pane.process_info": [processInfo("w1:p1", process.pid, process.pid)] };
    await withFakeHerdr({ "layout.apply": [{ ...answer, gatePid: process.pid }], ...later }, ({ options, calls }) => {
      const started = startInHerdrPane(command, options);
      assert.equal(started.outcome, "failed", `${JSON.stringify(answer)} read as ${JSON.stringify(started)}`);
      assert.equal(calls().length, 1, `more was asked after ${JSON.stringify(answer)}: ${named(calls()).join("; ")}`);
    });
  }
});

test("a layout.apply that does not answer within the bound failed, and is not waited out", async () => {
  await withFakeHerdr({ "layout.apply": [{ ...layoutApplied("w1:p7"), sleepMs: 30_000 }] }, ({ options }) => {
    const begun = Date.now();
    const started = startInHerdrPane(command, { ...options, boundMs: 300 });
    const elapsedMs = Date.now() - begun;

    assert.equal(started.outcome, "failed", JSON.stringify(started));
    assert.match("reason" in started ? started.reason : "", /300ms/u);
    assert.ok(elapsedMs < 5_000, `Herdr was waited on for ${elapsedMs}ms`);
  });
});

// A pane that opened and never ran the command would otherwise look like a
// reviewer still thinking. Only the gate's pid tells the two apart.
test("a pane that opens and never runs the command failed once its wait ran out, and its pane is closed", async () => {
  await withFakeHerdr(
    {
      "layout.apply": [layoutApplied("w1:p7")],
      "pane.process_info": [processInfo("w1:p7", 4242, 4242)],
      "pane.close": [closedOk],
      "pane.get": [refusal("pane_not_found")],
    },
    ({ options, calls }) => {
      const begun = Date.now();
      const started = startInHerdrPane({ ...command, startsWithinMs: 500 }, options);
      const elapsedMs = Date.now() - begun;

      assert.equal(started.outcome, "failed", JSON.stringify(started));
      assert.match("reason" in started ? started.reason : "", /did not start in the pane within 500ms/u);
      assert.ok(elapsedMs >= 500 && elapsedMs < 5_000, `the command was waited on for ${elapsedMs}ms`);
      assert.deepEqual(named(calls()), ["layout.apply", "pane.close w1:p7", "pane.get w1:p7"]);
    },
  );
});

// The gate is all that stands between a start that failed and a second
// reviewer, since Herdr runs the pane's argv as it opens the pane.
test("a start that fails once its gate is running never lets the command run", async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "squiz-sessions-herdr-gate-")), "ran");
  let gatePid = 0;
  try {
    await withFakeHerdr(
      {
        "layout.apply": [{ ...layoutApplied("w1:p7"), runs: true }],
        // The pane's process is never the gate, so the start fails after reading its pid.
        "pane.process_info": [processInfo("w1:p7", 4242, 4242)],
        "pane.close": [closedOk],
        "pane.get": [refusal("pane_not_found")],
      },
      ({ options }) => {
        const started = startInHerdrPane({ ...command, program: "/usr/bin/touch", arguments: [marker] }, {
          ...options,
          boundMs: 500,
        });
        assert.equal(started.outcome, "failed", JSON.stringify(started));
        const read = /not the command's ([0-9]+)/u.exec("reason" in started ? started.reason : "");
        assert.ok(read !== null, JSON.stringify(started));
        gatePid = Number(read[1]);
      },
    );
    // It gives up after four bounds, as it would in a pane that could not be closed.
    const until = Date.now() + 10_000;
    while (identityOf(gatePid, BOUND_MS).outcome === "read" && Date.now() < until) {
      await new Promise((settle) => setTimeout(settle, 100));
    }
    assert.equal(identityOf(gatePid, BOUND_MS).outcome, "gone", `the gate ${gatePid} is still waiting`);
    assert.equal(existsSync(marker), false, "the command ran after its start failed");
  } finally {
    rmSync(join(marker, ".."), { recursive: true, force: true });
  }
});

test("a pane whose process is not the gate is never returned, and the pane is closed", async () => {
  for (const [group, shell] of [[4242, 4242], [process.pid, 4242], [4242, process.pid]] as const) {
    await withFakeHerdr(
      {
        "layout.apply": [layoutApplied("w1:p7", process.pid)],
        "pane.process_info": [processInfo("w1:p7", group, shell)],
        "pane.close": [closedOk],
        "pane.get": [refusal("pane_not_found")],
      },
      ({ options, calls }) => {
        const started = startInHerdrPane(command, options);
        assert.equal(started.outcome, "failed", `${group}/${shell} read as ${JSON.stringify(started)}`);
        assert.match("reason" in started ? started.reason : "", /not the command's/u);
        assert.deepEqual(named(calls()).slice(-2), ["pane.close w1:p7", "pane.get w1:p7"]);
      },
    );
  }
});

test("process info that cannot be read failed, and the pane is closed", async () => {
  for (const answer of [
    result({ process_info: { shell_pid: 1 } }),
    result({ process_info: { foreground_process_group_id: "9", shell_pid: 9 } }),
    result({ process_info: { foreground_process_group_id: 9.5, shell_pid: 9 } }),
    refusal("pane_not_found"),
    { raw: "not json" },
  ]) {
    await withFakeHerdr(
      {
        "layout.apply": [layoutApplied("w1:p7", process.pid)],
        "pane.process_info": [answer],
        "pane.close": [closedOk],
        "pane.get": [refusal("pane_not_found")],
      },
      ({ options, calls }) => {
        const started = startInHerdrPane(command, options);
        assert.equal(started.outcome, "failed", `${JSON.stringify(answer)} read as ${JSON.stringify(started)}`);
        assert.deepEqual(named(calls()).slice(-2), ["pane.close w1:p7", "pane.get w1:p7"]);
      },
    );
  }
});

test("a pane that could not be confirmed closed after a failed start is named", async () => {
  await withFakeHerdr(
    {
      "layout.apply": [layoutApplied("w1:p7", process.pid)],
      "pane.process_info": [refusal("server_busy")],
      "pane.close": [closedOk],
      "pane.get": [paneInfo("w1:p7")],
    },
    ({ options }) => {
      const started = startInHerdrPane(command, options);
      assert.equal(started.outcome, "failed", JSON.stringify(started));
      assert.equal("paneLeftOpen" in started ? started.paneLeftOpen : undefined, "w1:p7");
    },
  );
});

test("a pane is closed only once Herdr no longer has it", async () => {
  await withFakeHerdr({ "pane.close": [closedOk], "pane.get": [refusal("pane_not_found")] }, ({ options, calls }) => {
    assert.deepEqual(closeHerdrPane("w1:p7", options), { outcome: "closed" });
    assert.deepEqual(named(calls()), ["pane.close w1:p7", "pane.get w1:p7"]);
  });

  for (const afterwards of [paneInfo("w1:p7"), refusal("server_not_running"), { raw: "??" }]) {
    await withFakeHerdr({ "pane.close": [closedOk], "pane.get": [afterwards] }, ({ options }) => {
      const closed = closeHerdrPane("w1:p7", options);
      assert.equal(closed.outcome, "failed", `${JSON.stringify(afterwards)} read as ${JSON.stringify(closed)}`);
    });
  }
});

test("a pane Herdr no longer has is closed, whatever the close said", async () => {
  const answers = { "pane.close": [refusal("pane_not_found")], "pane.get": [refusal("pane_not_found")] };
  await withFakeHerdr(answers, ({ options }) => {
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

  // The start's PATH holds only the fakes and the system's directories.
  const herdrPath = spawnSync("/bin/sh", ["-c", "command -v herdr"], { encoding: "utf8" }).stdout.trim();

  const herdr = (args: readonly string[]): { status: number | null; output: string } => {
    const result = spawnSync(herdrPath, args, {
      encoding: "utf8",
      env: options.environment as NodeJS.ProcessEnv,
      timeout: BOUND_MS,
    });
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  };

  const ensureWorkspace = (): void => {
    const workspaces = JSON.parse(herdr(["workspace", "list"]).output).result.workspaces;
    if (workspaces.length === 0) assert.equal(herdr(["workspace", "create", "--cwd", home]).status, 0);
  };

  before(async () => {
    home = mkdtempSync("/tmp/sqh-");
    fakes = join(home, "bin");
    mkdirSync(fakes);
    // Stands in for the agent: it writes its pid, adds it to a list of runs
    // beside it, and writes its SESSION_MARK where a third argument names a file
    // for it. It tells Herdr it is a `pi` in the state AGENT_STATE names, idle
    // by default, and becomes a sleep of the given length with the same pid.
    writeFileSync(
      join(fakes, "pi"),
      [
        "#!/bin/sh",
        'echo "$$" >> "$1.runs"',
        'echo "$$" > "$1.part" && mv "$1.part" "$1"',
        'if [ -n "$3" ]; then printf "%s" "${SESSION_MARK-unset}" > "$3"; fi',
        `'${herdrPath}' pane report-agent --source squiz-test --agent pi --state "\${AGENT_STATE-idle}" "$HERDR_PANE_ID" >/dev/null 2>&1`,
        'exec sleep "$2"',
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(join(fakes, "pi"), 0o755);

    const socket = join(home, ".config", "herdr", "sessions", session, "herdr.sock");
    // `pi` is found on the server's path, so it is the fake. The server has its
    // own SESSION_MARK, as it would have a person's token.
    server = spawn(herdrPath, ["--session", session, "server"], {
      env: environmentFor({ PATH: `${fakes}:/usr/bin:/bin`, SESSION_MARK: "gho_fromserver" }) as NodeJS.ProcessEnv,
      stdio: "ignore",
    });
    for (let tries = 0; tries < 100 && !existsSync(socket); tries += 1) {
      await new Promise((settle) => setTimeout(settle, 100));
    }
    assert.ok(existsSync(socket), `the private Herdr server made no socket at ${socket}`);
    options = { environment: environmentFor({ HERDR_SOCKET_PATH: socket, PATH: `${fakes}:/usr/bin:/bin` }), boundMs: BOUND_MS };
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
    program: "pi",
    arguments: [pidFile, String(seconds)],
    startsWithinMs: 20_000,
  });

  // The start returns as the command is let run, a moment before it writes anything.
  const written = async (file: string): Promise<string> => {
    for (let tries = 0; tries < 200 && !existsSync(file); tries += 1) {
      await new Promise((settle) => setTimeout(settle, 50));
    }
    return readFileSync(file, "utf8").trim();
  };

  test("a server with no workspace to open a tab in refuses, and opens nothing", () => {
    const started = startInHerdrPane(fakeCommand("squiz-none", join(home, "none.pid"), 30), options);

    assert.equal(started.outcome, "refused", JSON.stringify(started));
    assert.equal(existsSync(join(home, "none.pid")), false, "the command ran");
  });

  test("the leader is the process running the command, and the pane's own", async () => {
    const created = herdr(["workspace", "create", "--cwd", home, "--no-focus"]);
    assert.equal(created.status, 0, `no workspace was created: ${created.output}`);

    const pidFile = join(home, "running.pid");
    const started = startInHerdrPane(fakeCommand("squiz-running", pidFile, 60), options);
    assert.equal(started.outcome, "started", JSON.stringify(started));
    if (started.outcome !== "started") return;

    try {
      assert.equal(started.leader.pid, Number(await written(pidFile)));
      const info = JSON.parse(herdr(["pane", "process-info", "--pane", started.pane]).output);
      assert.equal(info.result.process_info.shell_pid, started.leader.pid);
      assert.deepEqual(stillRunning(started.leader, BOUND_MS), { outcome: "running" });
    } finally {
      assert.deepEqual(closeHerdrPane(started.pane, options), { outcome: "closed" });
    }
  });

  // The pane exists from the moment Herdr answers, so it says nothing about
  // whether the command ever ran.
  test("a pane whose command is not there failed, and its tab is gone (#911)", () => {
    ensureWorkspace();
    const tabs = (): number => JSON.parse(herdr(["tab", "list"]).output).result.tabs.length;
    const before = tabs();
    const started = startInHerdrPane({ ...fakeCommand("squiz-absent", "", 0), program: join(home, "squiz-no-such-reviewer") }, options);

    assert.equal(started.outcome, "failed", JSON.stringify(started));
    assert.match("reason" in started ? started.reason : "", /found no \/.*\/squiz-no-such-reviewer/u);
    assert.equal("paneLeftOpen" in started, false, JSON.stringify(started));
    assert.equal(tabs(), before, "the tab is still open");
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

  test("the variables given reach the command over the server's own", async () => {
    ensureWorkspace();
    const variables = { SESSION_MARK: "it's $HOME; a b=c" };
    const markFile = join(home, "mark.txt");
    const command = fakeCommand("squiz-variables", join(home, "variables.pid"), 60);
    const started = startInHerdrPane({ ...command, arguments: [...command.arguments, markFile], variables }, options);
    assert.equal(started.outcome, "started", JSON.stringify(started));
    if (started.outcome !== "started") return;
    try {
      assert.equal(await written(markFile), variables.SESSION_MARK);
    } finally {
      assert.deepEqual(closeHerdrPane(started.pane, options), { outcome: "closed" });
    }
  });

  // The empty value is how the round keeps a GitHub token from the reviewer.
  test("a variable given empty reaches the command set and empty, over the server's own", async () => {
    ensureWorkspace();
    const markFile = join(home, "empty-mark.txt");
    const command = fakeCommand("squiz-empty", join(home, "empty.pid"), 60);
    const started = startInHerdrPane(
      { ...command, arguments: [...command.arguments, markFile], variables: { SESSION_MARK: "" } },
      options,
    );
    assert.equal(started.outcome, "started", JSON.stringify(started));
    if (started.outcome !== "started") return;
    try {
      assert.equal(await written(markFile), "");
    } finally {
      assert.deepEqual(closeHerdrPane(started.pane, options), { outcome: "closed" });
    }
  });

  test("every argument reaches the command as given, newlines, tabs and long ones too (#911)", async () => {
    ensureWorkspace();
    const out = join(home, "awkward's $args");
    const quotedOut = `'${out.replaceAll("'", "'\\''")}'`;
    const script = `printf '%s\\0' "$0" "$@" > ${quotedOut}.part && mv ${quotedOut}.part ${quotedOut}; exec sleep 60`;
    const json = JSON.stringify({ servers: { squiz: { env: { A: "it's $HOME `id` a\\b" }, args: ["x ".repeat(800)] } } });
    const args = ["-c", script, json, "line one\nline two", "a\ttab", "$HOME", "", "it's"];
    const started = startInHerdrPane({ ...fakeCommand("squiz-awkward", "", 0), program: "/bin/sh", arguments: args }, options);
    assert.equal(started.outcome, "started", JSON.stringify(started));
    if (started.outcome !== "started") return;
    try {
      for (let tries = 0; tries < 200 && !existsSync(out); tries += 1) {
        await new Promise((settle) => setTimeout(settle, 50));
      }
      assert.deepEqual(readFileSync(out, "utf8").split("\0").slice(0, -1), args.slice(2));
    } finally {
      assert.deepEqual(closeHerdrPane(started.pane, options), { outcome: "closed" });
    }
  });

  test("once the command exits Herdr closes its tab, and a close afterwards confirms it (#911)", async () => {
    ensureWorkspace();
    const started = startInHerdrPane(fakeCommand("squiz-exits", join(home, "exits.pid"), 2), options);
    assert.equal(started.outcome, "started", JSON.stringify(started));
    if (started.outcome !== "started") return;

    let presence = stillRunning(started.leader, BOUND_MS);
    for (let tries = 0; tries < 200 && presence.outcome === "running"; tries += 1) {
      await new Promise((settle) => setTimeout(settle, 100));
      presence = stillRunning(started.leader, BOUND_MS);
    }
    assert.deepEqual(presence, { outcome: "gone" });
    let afterwards = herdr(["pane", "get", started.pane]);
    for (let tries = 0; tries < 50 && !/pane_not_found/u.test(afterwards.output); tries += 1) {
      await new Promise((settle) => setTimeout(settle, 100));
      afterwards = herdr(["pane", "get", started.pane]);
    }
    assert.match(afterwards.output, /pane_not_found/u, "Herdr kept the pane after its command exited");
    assert.deepEqual(closeHerdrPane(started.pane, options), { outcome: "closed" });
  });

  // #449: a `pi` started on its prompt is busy until the review is done, and the
  // start returned only then, so any review longer than the wait failed.
  test("a command still working when the start's wait runs out is started, not failed (#449)", async () => {
    ensureWorkspace();
    const pidFile = join(home, "working.pid");
    const started = startInHerdrPane(
      { ...fakeCommand("squiz-working", pidFile, 60), startsWithinMs: 4_000, variables: { AGENT_STATE: "working" } },
      options,
    );
    assert.equal(started.outcome, "started", JSON.stringify(started));
    if (started.outcome !== "started") return;
    try {
      assert.equal(started.leader.pid, Number(await written(pidFile)));
      assert.deepEqual(stillRunning(started.leader, BOUND_MS), { outcome: "running" });
    } finally {
      assert.deepEqual(closeHerdrPane(started.pane, options), { outcome: "closed" });
    }
  });

  test("a command that exits at once still started, and its leader is the command's own", async () => {
    ensureWorkspace();
    const pidFile = join(home, "at-once.pid");
    const started = startInHerdrPane(fakeCommand("squiz-at-once", pidFile, 0), options);
    assert.equal(started.outcome, "started", JSON.stringify(started));
    if (started.outcome !== "started") return;
    assert.equal(started.leader.pid, Number(await written(pidFile)));
    assert.deepEqual(closeHerdrPane(started.pane, options), { outcome: "closed" });
  });

  test("a command that started leaves no gate directory behind once it runs (#453)", async () => {
    ensureWorkspace();
    // The gate is made in the temporary directory, so one of the test's own holds nothing else.
    const temporary = mkdtempSync(join(home, "tmp-"));
    const pidFile = join(home, "gate-gone.pid");
    const saved = process.env["TMPDIR"];
    process.env["TMPDIR"] = temporary;
    let started: ReturnType<typeof startInHerdrPane>;
    try {
      started = startInHerdrPane(fakeCommand("squiz-gate-gone", pidFile, 60), options);
    } finally {
      if (saved === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = saved;
    }
    assert.equal(started.outcome, "started", JSON.stringify(started));
    if (started.outcome !== "started") return;
    try {
      // The command writes its pid only once the gate has become it.
      assert.equal(started.leader.pid, Number(await written(pidFile)));
      const [gate] = readdirSync(temporary);
      const left = gate === undefined ? [] : readdirSync(join(temporary, gate));
      assert.deepEqual(readdirSync(temporary), [], `the gate still holds ${JSON.stringify(left)}`);
    } finally {
      assert.deepEqual(closeHerdrPane(started.pane, options), { outcome: "closed" });
    }
  });
});
