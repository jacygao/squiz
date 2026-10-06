/**
 * The reporting server driven as Copilot drives it: started by path with the
 * Node the harness runs on, from another directory, and spoken to over stdio in
 * newline-delimited JSON-RPC.
 *
 * Copilot validates no call's arguments, so every argument here is sent exactly
 * as a model could send it, and the server is the only check it meets.
 */

import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { deadlineIn } from "../deadline.ts";
import { ROUND_VARIABLE, roundVariable } from "../deep-tools.ts";
import { gitBlame, gitLogSearch, gitShow } from "../git-tools.ts";
import { discardRoundSpace, KEEPER_VARIABLE, makeRoundSpace, RECORD_VARIABLE, stopRecordedGroups } from "../groups.ts";
import { reportCalls } from "../report-calls.ts";
import { runTestsTool, STOP_MARGIN_MS } from "../run-tests.ts";
import { REPORTS_VARIABLE } from "../report-file.ts";
import { FINISH_REVIEW, REPORT_FINDING, REPORT_VERDICT, reportingTools } from "../reporting.ts";
import { CHARTER_VARIABLE } from "./server.ts";

const serverPath = fileURLToPath(new URL("./server.ts", import.meta.url));

/** How long a test waits for the server to answer or exit before it fails. */
const PATIENCE_MS = 5_000;

const lineFinding = {
  scope: "line",
  file: "src/cards/place.ts",
  line: 128,
  severity: "high",
  headline: "Card can be placed off-screen once the explanation expands",
  reasoning: ["`placeCard()` clamps against `window.innerHeight` before the animation runs."],
  suggestedFix: "Re-run `placeCard()` from the animation's completion callback.",
};

type Message = Readonly<Record<string, unknown>>;

type Running = {
  readonly child: ChildProcessWithoutNullStreams;
  /** Write one message as one line, or a raw line as it is. */
  readonly send: (message: Message | string) => void;
  /** The next message the server writes. Every line it writes must parse. */
  readonly next: () => Promise<Message>;
  /** Send a request and wait for the next message, which must answer it. */
  readonly request: (id: number | string, method: string, params?: unknown) => Promise<Message>;
  readonly stderr: () => string;
  readonly exited: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

/** A directory of the test's own, removed when the test ends. */
function scratch(t: { after: (fn: () => void) => void }): string {
  const directory = mkdtempSync(join(tmpdir(), "squiz-461-server-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** The server started as Copilot starts it, in `cwd`, with `env` added. */
function started(
  t: { after: (fn: () => void) => void },
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = {},
  options: { readonly detached?: boolean } = {},
): Running {
  const child = spawn(process.execPath, [serverPath], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: options.detached === true,
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );

  const queued: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const waiter = waiting.shift();
    if (waiter === undefined) queued.push(line);
    else waiter(line);
  });

  const nextLine = (): Promise<string> => {
    const line = queued.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`the server answered nothing; its stderr: ${stderr}`)),
        PATIENCE_MS,
      );
      waiting.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  };

  const next = async (): Promise<Message> => {
    const line = await nextLine();
    try {
      return JSON.parse(line) as Message;
    } catch {
      assert.fail(`the server wrote a line that is not JSON: ${line}`);
    }
  };

  const send = (message: Message | string): void => {
    child.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  };

  return {
    child,
    send,
    next,
    request: async (id, method, params) => {
      send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      const answer = await next();
      assert.equal(answer["id"], id, `the next message answered ${String(answer["id"])}, not ${id}`);
      return answer;
    },
    stderr: () => stderr,
    exited: () =>
      Promise.race([
        exit,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("the server did not exit")), PATIENCE_MS),
        ),
      ]),
  };
}

/** The file read back a line at a time, each line parsed on its own. */
function linesIn(path: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  if (text === "") return [];
  return text.slice(0, -1).split("\n").map((line) => JSON.parse(line) as unknown);
}

function resultOf(answer: Message): Message {
  assert.equal(answer["error"], undefined, `the server answered an error: ${JSON.stringify(answer)}`);
  const result = answer["result"];
  assert.ok(typeof result === "object" && result !== null, "the answer carries no result");
  return result as Message;
}

/** What a tool call answered: whether it refused, and the text the model reads. */
function toolAnswer(answer: Message): { isError: boolean; text: string } {
  const result = resultOf(answer);
  const content = result["content"] as readonly { type: string; text: string }[];
  assert.equal(content.length, 1);
  assert.equal(content[0]?.type, "text");
  return { isError: result["isError"] === true, text: content[0]?.text ?? "" };
}

function call(name: string, args: unknown): Message {
  return { name, arguments: args };
}

test("initialize answers with the charter as the server's instructions", async (t) => {
  const directory = scratch(t);
  const charter = join(directory, "charter.md");
  writeFileSync(charter, "# Charter\n\nReview the change as a careful colleague.\n");
  const server = started(t, directory, { [CHARTER_VARIABLE]: charter });

  const result = resultOf(
    await server.request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "copilot", version: "1.0.91" },
    }),
  );

  assert.equal(result["instructions"], "# Charter\n\nReview the change as a careful colleague.\n");
  assert.equal(result["protocolVersion"], "2025-06-18");
  assert.deepEqual(result["capabilities"], { tools: {} });
});

test("initialize answers with a protocol version it knows where the client asks for one it does not", async (t) => {
  const server = started(t, scratch(t));
  const result = resultOf(
    await server.request(1, "initialize", { protocolVersion: "1999-01-01", capabilities: {} }),
  );
  assert.equal(result["protocolVersion"], "2025-11-25");
});

test("initialize is refused where the charter named cannot be read", async (t) => {
  const directory = scratch(t);
  const server = started(t, directory, { [CHARTER_VARIABLE]: join(directory, "missing.md") });
  const answer = await server.request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
  });
  const error = answer["error"] as Message | undefined;
  assert.ok(error !== undefined, "a reviewer was offered the calls with no charter");
  assert.match(String(error["message"]), /charter/);
});

test("the calls listed are the ones the grant carries, with the schemas the checks declare", async (t) => {
  const server = started(t, scratch(t));
  const result = resultOf(await server.request(1, "tools/list"));
  const tools = result["tools"] as readonly Message[];
  const declared = reportCalls({ record: () => {} }).calls;

  assert.deepEqual(
    tools.map((tool) => tool["name"]),
    reportingTools,
  );
  for (const [index, tool] of tools.entries()) {
    assert.deepEqual(tool["inputSchema"], declared[index]?.parameters);
    assert.equal(tool["description"], declared[index]?.description);
  }
});

test("a finding is in the report file before the reviewer is told it landed", async (t) => {
  const directory = scratch(t);
  const reports = join(directory, "reports.jsonl");
  const server = started(t, directory, { [REPORTS_VARIABLE]: reports });

  const answer = toolAnswer(await server.request(1, "tools/call", call(REPORT_FINDING, lineFinding)));

  assert.deepEqual(linesIn(reports), [{ type: "report", call: REPORT_FINDING, value: lineFinding }]);
  assert.equal(answer.isError, false);
  assert.equal(answer.text, `Reported: ${lineFinding.headline}`);
});

const unconverted: readonly { readonly sent: string; readonly args: unknown; readonly reason: string }[] = [
  {
    sent: "a line written as a string",
    args: { ...lineFinding, line: "12" },
    reason: "the finding is scoped to a line and carries no line number",
  },
  {
    sent: "a severity outside the enum",
    args: { ...lineFinding, severity: "critical" },
    reason: "the finding names no severity of high, medium or low",
  },
  {
    sent: "no headline",
    args: (({ headline: _headline, ...rest }) => rest)(lineFinding),
    reason: "the finding carries no headline",
  },
];

for (const { sent, args, reason } of unconverted) {
  test(`a finding with ${sent} is refused as the model sent it, not converted`, async (t) => {
    const directory = scratch(t);
    const reports = join(directory, "reports.jsonl");
    const server = started(t, directory, { [REPORTS_VARIABLE]: reports });

    const answer = toolAnswer(await server.request(1, "tools/call", call(REPORT_FINDING, args)));

    assert.deepEqual(answer, { isError: true, text: reason });
    assert.deepEqual(linesIn(reports), [
      { type: "refused", call: REPORT_FINDING, reason, stopped: false },
    ]);
  });
}

test("a call with no arguments at all is refused rather than crashing the server", async (t) => {
  const server = started(t, scratch(t));
  const answer = toolAnswer(await server.request(1, "tools/call", { name: REPORT_FINDING }));
  assert.deepEqual(answer, { isError: true, text: "the finding is not an object" });
  resultOf(await server.request(2, "ping"));
});

test("a report the file refuses is refused, and lands when the reviewer calls again", async (t) => {
  const directory = scratch(t);
  const missing = join(directory, "not-yet");
  const reports = join(missing, "reports.jsonl");
  const server = started(t, directory, { [REPORTS_VARIABLE]: reports });

  const refused = toolAnswer(await server.request(1, "tools/call", call(REPORT_FINDING, lineFinding)));
  assert.equal(refused.isError, true, "a report the file never held was answered as landed");
  assert.match(refused.text, /could not be recorded, so it was not reported/);

  mkdirSync(missing);
  const landed = toolAnswer(await server.request(2, "tools/call", call(REPORT_FINDING, lineFinding)));
  assert.equal(landed.isError, false);
  assert.deepEqual(linesIn(reports), [{ type: "report", call: REPORT_FINDING, value: lineFinding }]);
});

test("a verdict and the finish are recorded as pi's extension records them", async (t) => {
  const directory = scratch(t);
  const reports = join(directory, "reports.jsonl");
  const server = started(t, directory, { [REPORTS_VARIABLE]: reports });

  const verdict = { thread: "PRRT_kwDOabc", verdict: "fixed" };
  const ruled = toolAnswer(await server.request(1, "tools/call", call(REPORT_VERDICT, verdict)));
  assert.deepEqual(ruled, { isError: false, text: "Ruled fixed on PRRT_kwDOabc" });

  const finished = toolAnswer(await server.request(2, "tools/call", call(FINISH_REVIEW, {})));
  assert.deepEqual(finished, { isError: false, text: "The review is complete." });

  assert.deepEqual(linesIn(reports), [
    { type: "report", call: REPORT_VERDICT, value: verdict },
    { type: "finish" },
  ]);
});

test("a call to a tool the server does not serve is a protocol error", async (t) => {
  const server = started(t, scratch(t));
  const answer = await server.request(1, "tools/call", call("bash", { command: "ls" }));
  const error = answer["error"] as Message | undefined;
  assert.equal(error?.["code"], -32602);
});

test("a notification is answered with nothing", async (t) => {
  const server = started(t, scratch(t));
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  server.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } });
  resultOf(await server.request(1, "ping"));
});

test("a method the server does not know is answered as not found, and the server goes on", async (t) => {
  const server = started(t, scratch(t));
  // Copilot opens with this one.
  const answer = await server.request("discover", "server/discover");
  const error = answer["error"] as Message | undefined;
  assert.equal(error?.["code"], -32601);
  resultOf(await server.request(2, "ping"));
});

test("a line that is not a message goes to stderr and nowhere else", async (t) => {
  const server = started(t, scratch(t));
  server.send("this is not json");
  server.send("[1, 2]");
  server.send("");
  resultOf(await server.request(1, "ping"));
  assert.match(server.stderr(), /not json/i);
});

test("the server exits when its standard input closes", async (t) => {
  const server = started(t, scratch(t));
  resultOf(await server.request(1, "ping"));
  server.child.stdin.end();
  assert.deepEqual(await server.exited(), { code: 0, signal: null });
});

for (const signal of ["SIGTERM", "SIGHUP"] as const) {
  test(`the server exits on ${signal}`, async (t) => {
    const server = started(t, scratch(t));
    resultOf(await server.request(1, "ping"));
    server.child.kill(signal);
    const { code, signal: by } = await server.exited();
    assert.ok(code !== null || by === signal, `the server exited ${code} by ${by}`);
  });
}

/** The four tools a reviewer at `deep` is granted beside the reporting calls, in the grant's order. */
const deepTools = [runTestsTool, gitLogSearch, gitBlame, gitShow];

/** Run git in `directory`, failing the test rather than the fixture. */
function git(directory: string, ...args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

type Deep = { readonly snapshot: string; readonly scratch: string; readonly commit: string };

/** A snapshot of one commit, and a scratch space beside it. */
function deepPlace(t: { after: (fn: () => void) => void }): Deep {
  const root = realpathSync(scratch(t));
  const snapshot = join(root, "tree");
  const scratchSpace = join(root, "scratch");
  mkdirSync(snapshot);
  mkdirSync(scratchSpace);
  git(snapshot, "init", "--quiet");
  writeFileSync(join(snapshot, "place.ts"), "export const margin = 12;\n");
  git(snapshot, "add", "place.ts");
  git(
    snapshot,
    "-c",
    "user.email=squiz@example.invalid",
    "-c",
    "user.name=Squiz",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--message",
    "Keep the card clear of the edge",
  );
  return { snapshot, scratch: scratchSpace, commit: git(snapshot, "rev-parse", "HEAD").trim() };
}

/**
 * The server as Copilot starts it at `deep`: in the reviewer's environment,
 * which carries the round's variable. The round ends two minutes from now
 * unless `endsAt` says otherwise.
 */
function startedDeep(
  t: { after: (fn: () => void) => void },
  place: Deep,
  command: string | null,
  options: {
    readonly endsAt?: number;
    readonly extra?: Readonly<Record<string, string | undefined>>;
    readonly detached?: boolean;
  } = {},
): Running {
  return started(
    t,
    place.scratch,
    {
      ...roundVariable({
        snapshot: place.snapshot,
        scratch: place.scratch,
        test: command,
        endsAt: options.endsAt ?? Date.now() + 120_000,
      }),
      ...options.extra,
    },
    { detached: options.detached === true },
  );
}

test("at deep the server lists the four deep tools after the reporting calls, with their own schemas", async (t) => {
  const server = startedDeep(t, deepPlace(t), "true");
  const tools = resultOf(await server.request(1, "tools/list"))["tools"] as readonly Message[];
  assert.deepEqual(
    tools.map((tool) => tool["name"]),
    [...reportingTools, ...deepTools.map((tool) => tool.name)],
  );
  for (const tool of deepTools) {
    const listed = tools.find((each) => each["name"] === tool.name);
    assert.deepEqual(listed?.["inputSchema"], tool.parameters);
    assert.equal(listed?.["description"], tool.description);
  }
});

test("at read the server serves no deep tool, though one is called", async (t) => {
  const server = started(t, scratch(t));
  const answer = await server.request(1, "tools/call", call("git_show", { commit: "HEAD" }));
  assert.equal((answer["error"] as Message | undefined)?.["code"], -32602);
});

test("each history tool runs its git subcommand in the snapshot", async (t) => {
  const place = deepPlace(t);
  const server = startedDeep(t, place, null);

  const searched = toolAnswer(await server.request(1, "tools/call", call("git_log_search", { term: "margin" })));
  assert.equal(searched.isError, false, searched.text);
  assert.match(searched.text, new RegExp(place.commit));

  const blamed = toolAnswer(await server.request(2, "tools/call", call("git_blame", { file: "place.ts", line: 1 })));
  assert.equal(blamed.isError, false, blamed.text);
  assert.match(blamed.text, /export const margin = 12;/);

  const shown = toolAnswer(await server.request(3, "tools/call", call("git_show", { commit: "HEAD" })));
  assert.equal(shown.isError, false, shown.text);
  assert.match(shown.text, /Keep the card clear of the edge/);
});

// Copilot hands the server each call exactly as the model sent it.
const malformed: readonly { readonly sent: string; readonly name: string; readonly args: unknown; readonly reason: RegExp }[] = [
  { sent: "a line written as a string", name: "git_blame", args: { file: "place.ts", line: "1" }, reason: /line must be an integer/ },
  { sent: "a line below 1", name: "git_blame", args: { file: "place.ts", line: 0 }, reason: /line must be at least 1/ },
  { sent: "no file", name: "git_blame", args: { line: 1 }, reason: /file is required/ },
  { sent: "a commit that is a number", name: "git_show", args: { commit: 42 }, reason: /commit must be a string/ },
  { sent: "arguments that are a list", name: "git_log_search", args: ["margin"], reason: /arguments must be an object/ },
  { sent: "an argument it does not take", name: "run_tests", args: { command: "touch pwned" }, reason: /takes no argument command/ },
];

for (const { sent, name, args, reason } of malformed) {
  test(`a ${name} call with ${sent} is refused before it runs`, async (t) => {
    const place = deepPlace(t);
    const marker = join(place.scratch, "ran");
    const server = startedDeep(t, place, `touch '${marker}'`);
    const answer = toolAnswer(await server.request(1, "tools/call", call(name, args)));
    assert.equal(answer.isError, true, answer.text);
    assert.match(answer.text, reason);
    assert.match(answer.text, new RegExp(`^${name} was not run`));
    assert.ok(!existsSync(marker), "the test command ran on a call its schema refuses");
  });
}

test("run_tests runs the configured command in the snapshot, in the reviewer's environment less the server's own", async (t) => {
  const place = deepPlace(t);
  const server = startedDeep(
    t,
    place,
    'pwd; printf "tmp=%s mark=%s reports=%s\\n" "$TMPDIR" "$MARK" "${SQUIZ_REPORTS-unset}"',
    { extra: { MARK: "from-the-reviewer", [REPORTS_VARIABLE]: join(place.scratch, "reports.jsonl") } },
  );
  const answer = toolAnswer(await server.request(1, "tools/call", call("run_tests", {})));
  assert.equal(answer.isError, false, answer.text);
  assert.match(answer.text, /exited 0/);
  assert.ok(answer.text.includes(place.snapshot), answer.text);
  assert.ok(answer.text.includes(`tmp=${place.scratch} mark=from-the-reviewer reports=unset`), answer.text);
});

test("run_tests sent no arguments at all runs the command", async (t) => {
  const server = startedDeep(t, deepPlace(t), "exit 4");
  const answer = toolAnswer(await server.request(1, "tools/call", { name: "run_tests" }));
  assert.match(answer.text, /exited 4/);
});

test("run_tests handed a round it cannot read runs nothing rather than running unbounded", async (t) => {
  const place = deepPlace(t);
  const server = started(t, place.scratch, { [ROUND_VARIABLE]: "not json" });
  const answer = toolAnswer(await server.request(1, "tools/call", call("run_tests", {})));
  assert.equal(answer.isError, true, answer.text);
  assert.match(answer.text, /could not run/);
});

test("run_tests stops a command that would outrun the round, before the round's deadline", async (t) => {
  const place = deepPlace(t);
  const endsAt = Date.now() + STOP_MARGIN_MS + 1_500;
  const leftPid = join(place.scratch, "left");
  const server = startedDeep(t, place, `sleep 60 & printf '%s' "$!" > '${leftPid}'; wait`, { endsAt });
  server.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: call("run_tests", {}) });
  const answer = toolAnswer(await server.next());
  assert.ok(Date.now() < endsAt, `run_tests answered ${Date.now() - endsAt} ms after the round's deadline`);
  assert.match(answer.text, /stopped after \d+ seconds, because the round's time ran out/);
  assert.ok(!alive(Number(readFileSync(leftPid, "utf8"))), "the command outlived the run");
});

test("a run_tests call Copilot cancels stops the command, and is not answered", async (t) => {
  const place = deepPlace(t);
  const leftPid = join(place.scratch, "left");
  const server = startedDeep(t, place, `sleep 600 & printf '%s' "$!" > '${leftPid}'; wait`);
  server.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: call("run_tests", {}) });
  await untilWritten(leftPid);
  server.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, reason: "the user stopped it" } });
  assert.ok(await goneWithin(Number(readFileSync(leftPid, "utf8")), 5_000), "the command outlived the cancel");
  // The next message answers the ping, so nothing answered the cancelled call first.
  resultOf(await server.request(2, "ping"));
});

test("a test command still running when the round ends is stopped through the round's record", async (t) => {
  const place = deepPlace(t);
  const made = makeRoundSpace(place.scratch);
  assert.equal(made.outcome, "made");
  if (made.outcome !== "made") return;
  t.after(() => discardRoundSpace(made.space));
  const leftPid = join(place.scratch, "left");

  // The server leads a group of its own, as the reviewer's `sh` leads the group
  // Copilot and the server run in, and the round's variables reach it as they
  // reach Copilot.
  const server = startedDeep(t, place, `sleep 600 & printf '%s' "$!" > '${leftPid}'; wait`, {
    extra: { [RECORD_VARIABLE]: made.space.shellRecord, [KEEPER_VARIABLE]: made.space.keeperName },
    detached: true,
  });
  server.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: call("run_tests", {}) });
  await untilWritten(leftPid);
  const sleeping = Number(readFileSync(leftPid, "utf8"));

  // The server goes on answering while the tests run.
  resultOf(await server.request(2, "ping"));

  // The round's signal to the reviewer's group reaches the server, and not the
  // test command, which leads a group of its own.
  process.kill(-(server.child.pid ?? 0), "SIGTERM");
  await server.exited();
  assert.ok(alive(sleeping), "the test command was in the server's group after all");

  const stopped = await stopRecordedGroups(made.space, 1_500, deadlineIn(20_000));
  assert.equal(stopped.signalled.length, 1, `the round reached no group: ${JSON.stringify(stopped)}`);
  assert.ok(await goneWithin(sleeping, 5_000), "the test command outlived the round");
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function goneWithin(pid: number, milliseconds: number): Promise<boolean> {
  const until = Date.now() + milliseconds;
  while (alive(pid)) {
    if (Date.now() > until) return false;
    await new Promise((settle) => setTimeout(settle, 25));
  }
  return true;
}

async function untilWritten(path: string): Promise<void> {
  const until = Date.now() + 10_000;
  while (!existsSync(path) || readFileSync(path, "utf8") === "") {
    assert.ok(Date.now() < until, `${path} never appeared, so the command never started`);
    await new Promise((settle) => setTimeout(settle, 20));
  }
}
