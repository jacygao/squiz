import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChildCommand, ChildProcessHandle, ChildStart } from "./child.ts";
import type { HerdrOptions, PaneCommand, PaneStart } from "./herdr.ts";
import { startSession, type Backends, type SessionRequest, type SessionStart } from "./session.ts";
import type { Environment, WindowOpening, WindowRequest } from "./tmux.ts";

const BOUND_MS = 1_000;
const herdrIdentity = { pid: 101, startedAt: 1_700_000_001 };
const tmuxIdentity = { pid: 202, startedAt: 1_700_000_002 };
const childIdentity = { pid: 303, startedAt: 1_700_000_003 };
// Stands for the handle only; no test reads from it.
const childHandle = { pid: 303 } as unknown as ChildProcessHandle;

const request: SessionRequest = {
  name: "worker-1",
  directory: "/work/tree",
  inPane: { program: "agent", arguments: ["--interactive", "two words"] },
  withoutTerminal: { program: "agent", arguments: ["--print"] },
  startsWithinMs: 5_000,
};

const insideHerdr: Environment = { HERDR_SOCKET_PATH: "/run/herdr.sock" };
const insideTmux: Environment = { TMUX: "/tmp/tmux-1/default,1,0" };
const insideBoth: Environment = { ...insideHerdr, ...insideTmux };

type Calls = {
  herdr: { command: PaneCommand; options: HerdrOptions }[];
  tmux: { request: WindowRequest; environment: Environment; boundMs: number }[];
  child: { command: ChildCommand; environment: NodeJS.ProcessEnv; boundMs: number }[];
};

/** Backends answering as given, which record every call and run nothing. */
function fakes(answers: {
  herdr?: PaneStart;
  tmux?: WindowOpening;
  child?: ChildStart;
}): { backends: Backends; calls: Calls } {
  const calls: Calls = { herdr: [], tmux: [], child: [] };
  const backends: Backends = {
    herdr: (command, options) => {
      calls.herdr.push({ command, options });
      return answers.herdr ?? { outcome: "started", pane: "w1:p2", leader: herdrIdentity };
    },
    tmux: (windowRequest, environment, boundMs) => {
      calls.tmux.push({ request: windowRequest, environment, boundMs });
      return answers.tmux ?? { outcome: "opened", window: { id: "@7", name: windowRequest.name }, identity: tmuxIdentity };
    },
    child: async (command, environment, boundMs) => {
      calls.child.push({ command, environment, boundMs });
      return answers.child ?? { outcome: "started", identity: childIdentity, child: childHandle };
    },
  };
  return { backends, calls };
}

function backendsCalled(calls: Calls): string[] {
  return (["herdr", "tmux", "child"] as const).filter((name) => calls[name].length > 0);
}

/** The outcome without the child's handle, which `deepEqual` cannot compare. */
function plain(started: SessionStart): unknown {
  if (started.outcome !== "started") return started;
  const { child: _child, ...rest } = started;
  return rest;
}

test("inside Herdr the session starts in a Herdr pane, and nowhere else", async () => {
  const { backends, calls } = fakes({});
  const started = await startSession(request, { environment: insideBoth, boundMs: BOUND_MS }, backends);
  assert.deepEqual(plain(started), {
    outcome: "started",
    place: { backend: "herdr", pane: "w1:p2", identity: herdrIdentity },
    refusals: [],
  });
  assert.deepEqual(backendsCalled(calls), ["herdr"]);
  assert.deepEqual(calls.herdr[0], {
    command: {
      directory: "/work/tree",
      name: "worker-1",
      program: "agent",
      arguments: ["--interactive", "two words"],
      startsWithinMs: 5_000,
    },
    options: { environment: insideBoth, boundMs: BOUND_MS },
  });
});

test("a workspace given reaches the Herdr pane's start", async () => {
  const { backends, calls } = fakes({});
  await startSession({ ...request, workspace: "w3" }, { environment: insideHerdr, boundMs: BOUND_MS }, backends);
  assert.equal(calls.herdr[0]?.command.workspace, "w3");
});

test("inside tmux and not Herdr the session starts in a tmux window", async () => {
  const { backends, calls } = fakes({});
  const started = await startSession(request, { environment: insideTmux, boundMs: BOUND_MS }, backends);
  assert.deepEqual(plain(started), {
    outcome: "started",
    place: { backend: "tmux", window: { id: "@7", name: "worker-1" }, identity: tmuxIdentity },
    refusals: [],
  });
  assert.deepEqual(backendsCalled(calls), ["tmux"]);
  assert.deepEqual(calls.tmux[0], {
    request: { name: "worker-1", directory: "/work/tree", argv: ["agent", "--interactive", "two words"] },
    environment: insideTmux,
    boundMs: BOUND_MS,
  });
});

test("an empty HERDR_SOCKET_PATH or TMUX is not being inside either", async () => {
  const { backends, calls } = fakes({});
  const started = await startSession(
    request,
    { environment: { HERDR_SOCKET_PATH: "", TMUX: "" }, boundMs: BOUND_MS },
    backends,
  );
  assert.equal(started.outcome === "started" ? started.place.backend : started.outcome, "child");
  assert.deepEqual(backendsCalled(calls), ["child"]);
});

test("inside neither the session starts as a child with no terminal, and its handle is returned", async () => {
  const environment: Environment = { PATH: "/usr/bin" };
  const { backends, calls } = fakes({});
  const started = await startSession(request, { environment, boundMs: BOUND_MS }, backends);
  assert.deepEqual(plain(started), {
    outcome: "started",
    place: { backend: "child", identity: childIdentity },
    refusals: [],
  });
  assert.equal(started.outcome === "started" ? started.child : undefined, childHandle);
  assert.deepEqual(calls.child[0], {
    command: { program: "agent", arguments: ["--print"], directory: "/work/tree" },
    environment,
    boundMs: BOUND_MS,
  });
});

test("Herdr refusing falls back to tmux, and the caller is told why", async () => {
  const { backends, calls } = fakes({ herdr: { outcome: "refused", reason: "no herdr on the path" } });
  const started = await startSession(request, { environment: insideBoth, boundMs: BOUND_MS }, backends);
  assert.deepEqual(plain(started), {
    outcome: "started",
    place: { backend: "tmux", window: { id: "@7", name: "worker-1" }, identity: tmuxIdentity },
    refusals: [{ backend: "herdr", reason: "no herdr on the path" }],
  });
  assert.deepEqual(backendsCalled(calls), ["herdr", "tmux"]);
});

test("Herdr refusing outside tmux falls back to a child with no terminal", async () => {
  const { backends, calls } = fakes({ herdr: { outcome: "refused", reason: "tab create refused" } });
  const started = await startSession(request, { environment: insideHerdr, boundMs: BOUND_MS }, backends);
  assert.deepEqual(plain(started), {
    outcome: "started",
    place: { backend: "child", identity: childIdentity },
    refusals: [{ backend: "herdr", reason: "tab create refused" }],
  });
  assert.deepEqual(backendsCalled(calls), ["herdr", "child"]);
});

test("Herdr and tmux both refusing falls back to a child, and names both refusals", async () => {
  const { backends } = fakes({
    herdr: { outcome: "refused", reason: "herdr said no" },
    tmux: { outcome: "refused", reason: "tmux said no" },
  });
  const started = await startSession(request, { environment: insideBoth, boundMs: BOUND_MS }, backends);
  assert.deepEqual(plain(started), {
    outcome: "started",
    place: { backend: "child", identity: childIdentity },
    refusals: [
      { backend: "herdr", reason: "herdr said no" },
      { backend: "tmux", reason: "tmux said no" },
    ],
  });
});

test("Herdr failing is returned, and nothing else is started", async () => {
  const { backends, calls } = fakes({ herdr: { outcome: "failed", reason: "agent start timed out" } });
  const started = await startSession(request, { environment: insideBoth, boundMs: BOUND_MS }, backends);
  assert.deepEqual(started, { outcome: "failed", backend: "herdr", reason: "agent start timed out" });
  assert.deepEqual(backendsCalled(calls), ["herdr"]);
});

test("a pane a failed Herdr start left open reaches the caller", async () => {
  const { backends } = fakes({
    herdr: { outcome: "failed", reason: "process-info unreadable; and close failed", paneLeftOpen: "w1:p9" },
  });
  const started = await startSession(request, { environment: insideHerdr, boundMs: BOUND_MS }, backends);
  assert.deepEqual(started, {
    outcome: "failed",
    backend: "herdr",
    reason: "process-info unreadable; and close failed",
    leftOpen: { backend: "herdr", pane: "w1:p9" },
  });
});

test("tmux failing is returned with its window, and no child is started", async () => {
  const { backends, calls } = fakes({
    herdr: { outcome: "refused", reason: "herdr said no" },
    tmux: { outcome: "failed", reason: "identity unreadable", window: { id: "@8", name: "worker-1" } },
  });
  const started = await startSession(request, { environment: insideBoth, boundMs: BOUND_MS }, backends);
  assert.deepEqual(started, {
    outcome: "failed",
    backend: "tmux",
    reason: "identity unreadable",
    leftOpen: { backend: "tmux", window: { id: "@8", name: "worker-1" } },
  });
  assert.deepEqual(backendsCalled(calls), ["herdr", "tmux"]);
});

test("tmux failing with no window known is returned without one", async () => {
  const { backends } = fakes({ tmux: { outcome: "failed", reason: "tmux did not answer" } });
  const started = await startSession(request, { environment: insideTmux, boundMs: BOUND_MS }, backends);
  assert.deepEqual(started, { outcome: "failed", backend: "tmux", reason: "tmux did not answer" });
});

test("the variables given reach the command on every backend", async () => {
  const variables = { SESSION_MARK: "marked" };
  const environment: Environment = { ...insideBoth, PATH: "/usr/bin" };
  const { backends, calls } = fakes({
    herdr: { outcome: "refused", reason: "herdr said no" },
    tmux: { outcome: "refused", reason: "tmux said no" },
  });
  await startSession({ ...request, variables }, { environment, boundMs: BOUND_MS }, backends);
  assert.deepEqual(calls.herdr[0]?.command.variables, variables);
  assert.deepEqual(calls.tmux[0]?.request.variables, variables);
  assert.deepEqual(calls.child[0]?.environment, { ...environment, ...variables });
});

test("a child that cannot be started is returned as a failure", async () => {
  const { backends } = fakes({ child: { outcome: "failed", reason: "agent could not be started" } });
  const started = await startSession(request, { environment: {}, boundMs: BOUND_MS }, backends);
  assert.deepEqual(started, { outcome: "failed", backend: "child", reason: "agent could not be started" });
});
