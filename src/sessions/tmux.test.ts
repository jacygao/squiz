import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { identityOf, stillRunning } from "./process.ts";
import { closeWindow, openWindow, type TmuxWindow, type WindowOpening } from "./tmux.ts";

const BOUND_MS = 5_000;

const tmuxMissing = spawnSync("tmux", ["-V"], { stdio: "ignore" }).error !== undefined;
// CI installs tmux, so there a missing tmux fails the tests rather than skipping them.
const skip = tmuxMissing && process.env["CI"] === undefined ? "tmux is not installed" : false;

type Server = {
  /** An environment that points tmux at this server and nowhere else. */
  readonly environment: Record<string, string | undefined>;
  /** Run tmux against this server, and return what it printed. */
  readonly tmux: (...args: string[]) => string;
};

/**
 * Start a tmux server of the test's own, and kill it when the test ends. Its
 * windows run their commands with `shell` where one is given.
 *
 * It never reads a configuration file, so the owner's settings cannot change
 * what it does. `TMUX` is the only thing the code under test is told, and its
 * first field is the server's socket.
 */
function privateServer(t: TestContext, shell?: string): Server {
  const socketName = `squiz-test-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const tmux = (...args: string[]): string => {
    const result = spawnSync("tmux", ["-L", socketName, "-f", "/dev/null", ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, `tmux ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  tmux("new-session", "-d", "-s", "main");
  if (shell !== undefined) tmux("set-option", "-g", "default-shell", shell);
  const [socketPath = "", serverPid] = tmux("display", "-p", "-t", "main", "#{socket_path}\t#{pid}").split("\t");
  t.after(() => {
    spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" });
    // A killed server leaves its socket behind.
    rmSync(socketPath, { force: true });
  });

  const environment: Record<string, string | undefined> = { ...process.env, TMUX: `${socketPath},${serverPid},0` };
  // The owner's own pane, were these tests run inside tmux, is on another server.
  delete environment["TMUX_PANE"];
  return { environment, tmux };
}

function scratch(t: TestContext): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "squiz-sessions-tmux-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * An environment with no `TMUX`. Its default server is under `directory`, so
 * code that asked tmux anyway would reach no server, and never the owner's.
 */
function outsideTmux(directory: string): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = { ...process.env, TMUX_TMPDIR: directory };
  delete environment["TMUX"];
  delete environment["TMUX_PANE"];
  return environment;
}

/** Wait up to `ms` for `done` to hold, and say whether it did. */
async function eventually(done: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (done()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return done();
}

/**
 * A node program that writes its pid, its working directory and its arguments
 * to the file named by its first argument, then sleeps until it is stopped.
 * The file appears whole, by a rename, so it is never read half written.
 */
function recorder(file: string, ...args: string[]): string[] {
  const script = [
    "const [file, ...rest] = process.argv.slice(1);",
    "const fs = require('node:fs');",
    "fs.writeFileSync(file + '.part', JSON.stringify({ pid: process.pid, cwd: process.cwd(), args: rest }));",
    "fs.renameSync(file + '.part', file);",
    "setInterval(() => {}, 60000);",
  ].join("\n");
  return [process.execPath, "-e", script, file, ...args];
}

type Recorded = { readonly pid: number; readonly cwd: string; readonly args: readonly string[] };

async function recordOf(file: string): Promise<Recorded> {
  assert.ok(await eventually(() => existsSync(file), 10_000), "the command never ran");
  return JSON.parse(readFileSync(file, "utf8")) as Recorded;
}

function opened(result: WindowOpening): Extract<WindowOpening, { outcome: "opened" }> {
  assert.equal(result.outcome, "opened", `not opened: ${JSON.stringify(result)}`);
  if (result.outcome !== "opened") throw new Error("unreachable");
  return result;
}

test("a command starts in a new window, with the name and directory given", { skip }, async (t) => {
  const server = privateServer(t);
  const directory = scratch(t);
  const file = join(directory, "record.json");

  const { window } = opened(
    openWindow({ name: "squiz-41-r2", directory, argv: recorder(file) }, server.environment, BOUND_MS),
  );

  assert.equal(window.name, "squiz-41-r2");
  assert.match(window.id, /^@\d+$/u);
  const listed = server.tmux("list-windows", "-a", "-F", "#{window_id} #{window_name}").split("\n");
  assert.ok(listed.includes(`${window.id} squiz-41-r2`), `not listed: ${JSON.stringify(listed)}`);
  assert.equal((await recordOf(file)).cwd, directory);
});

test("the window opens without taking the focus", { skip }, async (t) => {
  const server = privateServer(t);
  const directory = scratch(t);
  const before = server.tmux("display", "-p", "-t", "main", "#{window_id}");

  opened(
    openWindow(
      { name: "squiz-quiet", directory, argv: recorder(join(directory, "r.json")) },
      server.environment,
      BOUND_MS,
    ),
  );

  assert.equal(server.tmux("display", "-p", "-t", "main", "#{window_id}"), before);
});

const AWKWARD = [
  "two words",
  "it's",
  "'",
  "''",
  '"quoted"',
  "$HOME",
  "${PATH}",
  "`id`",
  "$(id)",
  "a\nb",
  "back\\slash",
  "\\'",
  "'\\",
  "",
  "*",
  "; exit 1",
  "&& echo no",
  "| cat",
  "~",
  "-c",
  "#not a comment",
  "#{pane_id}",
  "#(id)",
  "tab\there",
  "ünïcödé",
];

// tmux hands the command line to its default shell, which is whatever the owner's is.
for (const shell of ["sh", "dash", "bash", "zsh", "fish"]) {
  const path = spawnSync("/bin/sh", ["-c", 'command -v "$1"', "-", shell], { encoding: "utf8" }).stdout.trim();
  const shellSkip = skip || (path === "" && process.env["CI"] === undefined ? `${shell} is not installed` : false);

  test(`every argument reaches the program exactly as given, under ${shell}`, { skip: shellSkip }, async (t) => {
    const server = privateServer(t, path);
    const directory = scratch(t);
    const file = join(directory, "record.json");

    opened(
      openWindow({ name: "squiz-quoting", directory, argv: recorder(file, ...AWKWARD) }, server.environment, BOUND_MS),
    );

    assert.deepEqual((await recordOf(file)).args, AWKWARD);
  });

  test(
    `the identity returned is the process running the command, not a shell above it, under ${shell}`,
    { skip: shellSkip },
    async (t) => {
      const server = privateServer(t, path);
      const directory = scratch(t);
      const file = join(directory, "record.json");

      const { identity } = opened(
        openWindow({ name: "squiz-pid", directory, argv: recorder(file) }, server.environment, BOUND_MS),
      );

      assert.equal(identity.pid, (await recordOf(file)).pid);
      assert.deepEqual(identityOf(identity.pid, BOUND_MS), { outcome: "read", identity });
    },
  );
}

test("outside tmux no window opens, and that is a refusal", { skip }, (t) => {
  const directory = scratch(t);
  const environment = outsideTmux(directory);

  const result = openWindow({ name: "squiz-outside", directory, argv: ["/bin/sleep", "30"] }, environment, BOUND_MS);

  assert.equal(result.outcome, "refused", JSON.stringify(result));
});

test("a tmux whose server is not there refuses, and no window opens", { skip }, (t) => {
  const directory = scratch(t);
  const environment = { ...outsideTmux(directory), TMUX: `${join(directory, "no-such-socket")},1,0` };

  const result = openWindow({ name: "squiz-no-server", directory, argv: ["/bin/sleep", "30"] }, environment, BOUND_MS);

  assert.equal(result.outcome, "refused", JSON.stringify(result));
  assert.match(result.outcome === "refused" ? result.reason : "", /no-such-socket/u);
});

test("a tmux that is not installed refuses, and no window opens", { skip }, (t) => {
  const server = privateServer(t);
  const directory = scratch(t);
  const environment = { ...server.environment, PATH: directory };

  const result = openWindow({ name: "squiz-no-tmux", directory, argv: ["/bin/sleep", "30"] }, environment, BOUND_MS);

  assert.equal(result.outcome, "refused", JSON.stringify(result));
  assert.ok(!server.tmux("list-windows", "-a", "-F", "#{window_name}").includes("squiz-no-tmux"));
});

test(
  "closing the window stops a command that does not ignore the hangup, and the window is gone",
  { skip },
  async (t) => {
    const server = privateServer(t);
    const directory = scratch(t);
    const file = join(directory, "record.json");
    const { window, identity } = opened(
      openWindow({ name: "squiz-close", directory, argv: recorder(file) }, server.environment, BOUND_MS),
    );
    await recordOf(file);

    assert.deepEqual(closeWindow(window, server.environment, BOUND_MS), { outcome: "closed" });

    assert.ok(!server.tmux("list-windows", "-a", "-F", "#{window_id}").split("\n").includes(window.id));
    assert.ok(
      await eventually(() => stillRunning(identity, BOUND_MS).outcome === "gone", 5_000),
      "the command was still running after its window closed",
    );
  },
);

test("closing one window leaves another of the same name open", { skip }, async (t) => {
  const server = privateServer(t);
  const directory = scratch(t);
  const first = opened(
    openWindow(
      { name: "squiz-same", directory, argv: recorder(join(directory, "1.json")) },
      server.environment,
      BOUND_MS,
    ),
  );
  const second = opened(
    openWindow(
      { name: "squiz-same", directory, argv: recorder(join(directory, "2.json")) },
      server.environment,
      BOUND_MS,
    ),
  );

  assert.deepEqual(closeWindow(first.window, server.environment, BOUND_MS), { outcome: "closed" });

  const listed = server.tmux("list-windows", "-a", "-F", "#{window_id}").split("\n");
  assert.ok(listed.includes(second.window.id), `the other window went too: ${JSON.stringify(listed)}`);
});

test("a window whose command has already exited reads as closed", { skip }, async (t) => {
  const server = privateServer(t);
  const directory = scratch(t);
  const { window, identity } = opened(
    openWindow(
      { name: "squiz-exits", directory, argv: [process.execPath, "-e", "setTimeout(() => {}, 1000)"] },
      server.environment,
      BOUND_MS,
    ),
  );
  assert.ok(
    await eventually(() => stillRunning(identity, BOUND_MS).outcome === "gone", 10_000),
    "the command never exited",
  );

  assert.deepEqual(closeWindow(window, server.environment, BOUND_MS), { outcome: "closed" });
});

test("a window on a server that has gone reads as closed", { skip }, async (t) => {
  const server = privateServer(t);
  const directory = scratch(t);
  const { window } = opened(
    openWindow(
      { name: "squiz-last", directory, argv: recorder(join(directory, "r.json")) },
      server.environment,
      BOUND_MS,
    ),
  );
  // With the session's first window gone, closing this one leaves the server nothing, and it exits.
  server.tmux("kill-window", "-t", "main:0");

  assert.deepEqual(closeWindow(window, server.environment, BOUND_MS), { outcome: "closed" });
});

test("a close outside tmux could not tell", { skip }, (t) => {
  const window: TmuxWindow = { id: "@1", name: "squiz-unasked" };

  const result = closeWindow(window, outsideTmux(scratch(t)), BOUND_MS);

  assert.equal(result.outcome, "unknown", JSON.stringify(result));
});

test("a close where tmux is not installed could not tell", { skip }, async (t) => {
  const server = privateServer(t);
  const directory = scratch(t);
  const { window } = opened(
    openWindow(
      { name: "squiz-no-tmux", directory, argv: recorder(join(directory, "r.json")) },
      server.environment,
      BOUND_MS,
    ),
  );

  const result = closeWindow(window, { ...server.environment, PATH: directory }, BOUND_MS);

  assert.equal(result.outcome, "unknown", JSON.stringify(result));
});
