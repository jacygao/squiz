/**
 * The extension driven the way `pi` drives it: loaded once, then called.
 *
 * `pi` is not here, so what this holds is the half the harness owns — the names
 * registered, the schema the CLI is asked to validate against, what each call
 * answers with, that the refusal is subscribed at all, what each call and each
 * assistant message writes to the report file, and when the extension asks `pi`
 * to shut down. That `pi` loads the file and grants the calls is held by the
 * command line and the grant beside it, and that `pi` honours the shutdown is
 * not held here at all.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { historyTools } from "../git-tools.ts";
import { REPORTS_VARIABLE } from "../report-file.ts";
import { FINISH_REVIEW, REPORT_FINDING, REPORT_VERDICT, reportingTools } from "../reporting.ts";
import { grants } from "./argv.ts";
import reportAsYouGo, {
  type Context,
  type MessageEnd,
  type Registrar,
  reportInto,
  serveHistoryTools,
} from "./extension.ts";
import { GRANT_VARIABLE, type Refusal, type ToolCall } from "./refusals.ts";

type Tool = Parameters<Registrar["registerTool"]>[0];
type Handler = (call: ToolCall) => Refusal | undefined;
type MessageHandler = (event: MessageEnd) => void;
type EndHandler = (event: { readonly type: string }, ctx: Context) => void;

const lineFinding = {
  scope: "line",
  file: "src/cards/place.ts",
  line: 128,
  severity: "high",
  headline: "Card can be placed off-screen once the explanation expands",
  reasoning: ["`placeCard()` clamps against `window.innerHeight` before the animation runs."],
  suggestedFix: "Re-run `placeCard()` from the animation's completion callback.",
};

/** What the extension did with `pi`'s API: the calls it registered and what it subscribed. */
type Loaded = { tools: Map<string, Tool>; handlers: Map<string, unknown[]> };

/** `pi`'s API, recording what the extension did with it. */
function registrar(): { pi: Registrar; loaded: Loaded } {
  const loaded: Loaded = { tools: new Map(), handlers: new Map() };
  const pi: Registrar = {
    registerTool: (tool) => loaded.tools.set(tool.name, tool),
    on: (event: string, handler: unknown) => {
      loaded.handlers.set(event, [...(loaded.handlers.get(event) ?? []), handler]);
    },
  };
  return { pi, loaded };
}

/** The extension loaded with its reports going to `reports`, or nowhere, under the grant. */
function loaded(reports?: string): Loaded {
  const { pi, loaded } = registrar();
  reportInto(pi, reports, process.cwd(), grants);
  return loaded;
}

/** The one handler subscribed to `event`. */
function onlyHandler(subscribed: Loaded, event: string): unknown {
  const handlers = subscribed.handlers.get(event) ?? [];
  assert.equal(handlers.length, 1, `the extension subscribed ${handlers.length} ${event} handlers`);
  return handlers[0];
}

/** A report file of the test's own, in a directory removed when the test ends. */
function reportsFile(t: { after: (fn: () => void) => void }): string {
  const directory = mkdtempSync(join(tmpdir(), "squiz-extension-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "reports.jsonl");
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
  assert.ok(text.endsWith("\n"), "the last line carries no newline");
  return text.slice(0, -1).split("\n").map((line) => JSON.parse(line) as unknown);
}

/** An assistant message as `pi` ends one, cost and all. */
const assistantMessage = {
  role: "assistant",
  content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } }],
  api: "openai-completions",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  usage: {
    input: 1200,
    output: 80,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1280,
    cost: { input: 0.001, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0012 },
  },
  stopReason: "toolUse",
  timestamp: 1_759_500_000_000,
};

/** The three calls, registered as `pi` registers them. */
function registered(): Map<string, Tool> {
  return loaded().tools;
}

/**
 * The handler `pi` would offer every tool call to.
 *
 * `pi` skips the whole event where nothing subscribed to it, so a subscription
 * that went missing takes the refusal with it and says nothing. Failing here is
 * what tells that apart from a reviewer that tried nothing.
 */
function subscribedHandler(reports?: string): Handler {
  const subscribed = loaded(reports).handlers.get("tool_call") ?? [];
  assert.equal(
    subscribed.length,
    1,
    "the extension subscribed no tool_call handler, so pi runs every call the reviewer makes",
  );
  const [handler] = subscribed;
  assert.ok(handler !== undefined);
  return handler as Handler;
}

function messageHandler(reports?: string): MessageHandler {
  return onlyHandler(loaded(reports), "message_end") as MessageHandler;
}

function toolNamed(name: string, reports?: string): Tool {
  const tool = loaded(reports).tools.get(name);
  assert.ok(tool !== undefined, `${name} was not registered`);
  return tool;
}

/** The schema read as its fields, which is all a JSON Schema is here. */
function schemaOf(tool: Tool): Readonly<Record<string, unknown>> {
  assert.ok(typeof tool.parameters === "object" && tool.parameters !== null);
  return tool.parameters as Readonly<Record<string, unknown>>;
}

/** What a call refused, which is the line the reviewer is handed. */
async function refusalOf(tool: Tool, params: unknown): Promise<string> {
  try {
    await tool.execute("call_1", params);
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  assert.fail("the call was answered rather than refused");
}

test("the calls registered are the ones the grant carries", () => {
  assert.deepEqual([...registered().keys()], [...reportingTools]);
});

test("the schema requires every field a comment is composed from", () => {
  const schema = schemaOf(toolNamed(REPORT_FINDING));
  assert.deepEqual(schema["required"], [
    "scope",
    "severity",
    "headline",
    "reasoning",
    "suggestedFix",
  ]);
});

/**
 * The anchor fields are optional in the schema and checked in the call, because
 * which of them a finding carries follows from its scope. The CLI refuses a
 * call missing a field; the call refuses one whose anchor and scope disagree.
 */
test("the anchor fields are optional in the schema and ruled on in the call", async () => {
  const schema = schemaOf(toolNamed(REPORT_FINDING));
  const required: readonly unknown[] = schema["required"] as readonly unknown[];
  assert.equal(required.includes("file"), false);
  assert.equal(required.includes("line"), false);

  const { file: _file, ...noFile } = lineFinding;
  const refused = await refusalOf(toolNamed(REPORT_FINDING), noFile);
  assert.match(refused, /the finding is scoped to a line and carries no file/);
});

test("a finding reported is answered with the finding the harness will read", async () => {
  const answer = await toolNamed(REPORT_FINDING).execute("call_1", lineFinding);
  assert.deepEqual(answer.details, lineFinding);
});

test("what the reviewer is told back names the finding without repeating it", async () => {
  const answer = await toolNamed(REPORT_FINDING).execute("call_1", lineFinding);
  const said = answer.content[0];
  assert.equal(said?.type, "text");
  assert.match(said?.text ?? "", /Card can be placed off-screen/);
  assert.equal(said?.text.includes(lineFinding.suggestedFix), false);
});

test("a headline with no length to it is truncated rather than answered whole", async () => {
  const long = { ...lineFinding, headline: "x".repeat(5_000) };
  const answer = await toolNamed(REPORT_FINDING).execute("call_1", long);
  assert.ok((answer.content[0]?.text.length ?? 0) < 200, "a custom tool must bound what it answers");
});

test("a malformed finding is refused with the reason, and the next one stands", async () => {
  const tool = toolNamed(REPORT_FINDING);
  assert.match(await refusalOf(tool, { ...lineFinding, severity: "critical" }), /no severity/);
  const answer = await tool.execute("call_2", lineFinding);
  assert.deepEqual(answer.details, lineFinding);
});

test("a verdict is answered with the ruling the harness will read", async () => {
  const ruling = { thread: "PRRT_kwDOAbc123", verdict: "fixed" };
  const answer = await toolNamed(REPORT_VERDICT).execute("call_1", ruling);
  assert.deepEqual(answer.details, ruling);
});

test("a second ruling on one thread is refused, and the first stands", async () => {
  const tool = toolNamed(REPORT_VERDICT);
  await tool.execute("call_1", { thread: "PRRT_kwDOAbc123", verdict: "fixed" });
  const refused = await refusalOf(tool, { thread: "PRRT_kwDOAbc123", verdict: "open", reason: "Still there." });
  assert.match(refused, /PRRT_kwDOAbc123 was already ruled on/);

  const other = { thread: "PRRT_kwDOAbc456", verdict: "open", reason: "Still there." };
  assert.deepEqual((await tool.execute("call_3", other)).details, other);
});

test("an open verdict with no reason is refused, and pi's reviewer can rule again", async () => {
  const tool = toolNamed(REPORT_VERDICT);
  const refused = await refusalOf(tool, { thread: "PRRT_kwDOAbc123", verdict: "open" });
  assert.match(refused, /keeps thread PRRT_kwDOAbc123 open and gives no reason/u);

  const ruling = { thread: "PRRT_kwDOAbc123", verdict: "open", reason: "The clamp still runs first." };
  assert.deepEqual((await tool.execute("call_2", ruling)).details, ruling);
});

test("a malformed verdict is refused with the reason", async () => {
  const refused = await refusalOf(toolNamed(REPORT_VERDICT), { verdict: "fixed" });
  assert.match(refused, /the verdict names no thread/);
});

/**
 * The run is left to end itself, and the call asks `pi` for nothing. `pi` ends a
 * run on a call only where every call of the same message asked it to, so a
 * reviewer that reports a finding and finishes in one message would be asking for
 * nothing.
 */
test("finishing the review is answered, and asks for nothing of its own", async () => {
  const tool = toolNamed(FINISH_REVIEW);
  assert.equal(schemaOf(tool)["required"], undefined, "the call takes no arguments");
  const answer = await tool.execute("call_1", {});
  assert.equal(answer.content[0]?.type, "text");
});

/**
 * The one assertion that tells a handler which is never reached from a round
 * where the reviewer tried nothing. Both produce a clean round and no refusals.
 */
test("the extension subscribes a handler that refuses a write", () => {
  const refused = subscribedHandler()({ toolName: "write", input: { path: "src/a.ts", content: "x" } });
  assert.equal(refused?.block, true, "the subscribed handler let a write through");
  assert.equal(refused?.reason, "squiz refused this call: `write` is not a tool this review grants.");
});

test("the subscribed handler lets a call nothing objects to through", () => {
  assert.equal(subscribedHandler()({ toolName: "read", input: { path: "src/a.ts" } }), undefined);
});

test("every call describes itself to the reviewer", () => {
  for (const [name, tool] of registered()) {
    assert.notEqual(tool.description, "", `${name} carries no description`);
    assert.equal(tool.label === "", false, `${name} carries no label`);
  }
});

/** The tool registered under `name` on one loaded extension. */
function toolOf(subscribed: Loaded, name: string): Tool {
  const tool = subscribed.tools.get(name);
  assert.ok(tool !== undefined, `${name} was not registered`);
  return tool;
}

/** A path in a directory that does not exist, where every append fails. */
function unwritable(t: { after: (fn: () => void) => void }): string {
  return join(reportsFile(t), "..", "not-yet", "reports.jsonl");
}

/**
 * `pi` converts the arguments before the call runs, and the extension reads
 * them into a finding, so what lands can differ from what the model sent. Here
 * the reading drops a property the schema never declared, which `pi` passes
 * through.
 */
test("a finding is recorded as the call accepted it, not as the arguments it was sent", async (t) => {
  const reports = reportsFile(t);
  await toolNamed(REPORT_FINDING, reports).execute("call_1", { ...lineFinding, unasked: "x" });
  assert.deepEqual(linesIn(reports), [
    { type: "report", call: REPORT_FINDING, value: lineFinding },
  ]);
});

test("a verdict is recorded as the call accepted it", async (t) => {
  const reports = reportsFile(t);
  const ruling = { thread: "PRRT_kwDOAbc123", verdict: "fixed" };
  await toolNamed(REPORT_VERDICT, reports).execute("call_1", ruling);
  assert.deepEqual(linesIn(reports), [{ type: "report", call: REPORT_VERDICT, value: ruling }]);
});

test("a report the call refused is recorded with its refusal, as one that ran", async (t) => {
  const reports = reportsFile(t);
  const extension = loaded(reports);
  const verdict = toolOf(extension, REPORT_VERDICT);
  await verdict.execute("call_1", { thread: "PRRT_kwDOAbc123", verdict: "fixed" });
  const second = await refusalOf(verdict, { thread: "PRRT_kwDOAbc123", verdict: "open", reason: "Still there." });
  const malformed = await refusalOf(toolOf(extension, REPORT_FINDING), { scope: "line" });

  assert.deepEqual(linesIn(reports).slice(1), [
    { type: "refused", call: REPORT_VERDICT, reason: second, stopped: false },
    { type: "refused", call: REPORT_FINDING, reason: malformed, stopped: false },
  ]);
});

test("a call stopped before it ran is recorded with its refusal", (t) => {
  const reports = reportsFile(t);
  const handler = subscribedHandler(reports);
  const refused = handler({ toolName: "edit", input: { path: "src/a.ts" } });
  handler({ toolName: "read", input: { path: "src/a.ts" } });

  assert.deepEqual(linesIn(reports), [
    { type: "refused", call: "edit", reason: refused?.reason, stopped: true },
  ]);
});

test("a read outside the working directory pi was started in is refused and recorded", (t) => {
  const reports = reportsFile(t);
  const outside = join(reports, "..", "id_rsa");
  writeFileSync(outside, "decoy\n");
  const { pi, loaded: extension } = registrar();
  keepVariable(t);
  process.env[REPORTS_VARIABLE] = reports;
  process.env[GRANT_VARIABLE] = grants.join(",");
  reportAsYouGo(pi);
  const handler = onlyHandler(extension, "tool_call") as Handler;

  const refused = handler({ toolName: "read", input: { path: outside } });
  assert.equal(refused?.block, true, "the subscribed handler let a read outside the snapshot through");
  assert.equal(handler({ toolName: "read", input: { path: "package.json" } }), undefined);
  assert.deepEqual(linesIn(reports), [
    { type: "refused", call: "read", reason: refused?.reason, stopped: true },
  ]);
});

test("an assistant message is recorded with its usage and why it stopped", (t) => {
  const reports = reportsFile(t);
  messageHandler(reports)({ type: "message_end", message: assistantMessage });
  assert.deepEqual(linesIn(reports), [
    {
      type: "usage",
      stopReason: "toolUse",
      model: "deepseek-v4-pro",
      usage: assistantMessage.usage,
    },
  ]);
});

/** `pi` retries a failed request, so an errored message sits among working ones. */
test("an errored assistant message is recorded with its error", (t) => {
  const reports = reportsFile(t);
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const errored = {
    ...assistantMessage,
    content: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zero },
    stopReason: "error",
    errorMessage: "429 Too Many Requests",
  };
  messageHandler(reports)({ type: "message_end", message: errored });
  assert.deepEqual(linesIn(reports), [
    {
      type: "usage",
      stopReason: "error",
      errorMessage: "429 Too Many Requests",
      model: "deepseek-v4-pro",
      usage: errored.usage,
    },
  ]);
});

test("a message that is not the reviewer's records nothing", (t) => {
  const reports = reportsFile(t);
  const handler = messageHandler(reports);
  handler({ type: "message_end", message: { role: "user", content: [] } });
  handler({ type: "message_end", message: { role: "toolResult", content: [] } });
  assert.deepEqual(linesIn(reports), []);
});

test("finishing the review is recorded", async (t) => {
  const reports = reportsFile(t);
  await toolNamed(FINISH_REVIEW, reports).execute("call_1", {});
  assert.deepEqual(linesIn(reports), [{ type: "finish" }]);
});

test("the lines are in the order the reviewer did things", async (t) => {
  const reports = reportsFile(t);
  const extension = loaded(reports);
  const message = onlyHandler(extension, "message_end") as MessageHandler;
  const handler = onlyHandler(extension, "tool_call") as Handler;

  message({ type: "message_end", message: assistantMessage });
  handler({ toolName: "write", input: { path: "src/a.ts", content: "x" } });
  await toolOf(extension, REPORT_FINDING).execute("call_2", lineFinding);
  message({ type: "message_end", message: { ...assistantMessage, stopReason: "stop" } });
  await toolOf(extension, FINISH_REVIEW).execute("call_3", {});

  assert.deepEqual(
    linesIn(reports).map((line) => (line as { type: string }).type),
    ["usage", "refused", "report", "usage", "finish"],
  );
});

/**
 * The reviewer is told a report landed only where it is in the file. A report
 * answered as accepted and missing from the file is lost with nobody knowing.
 */
test("a report that cannot be recorded is refused, and can be made again", async (t) => {
  const missing = unwritable(t);
  const verdict = toolOf(loaded(missing), REPORT_VERDICT);
  const ruling = { thread: "PRRT_kwDOAbc123", verdict: "fixed" };

  const refused = await refusalOf(verdict, ruling);
  assert.match(refused, /the verdict could not be recorded, so it was not reported/u);

  mkdirSync(join(missing, ".."));
  assert.deepEqual((await verdict.execute("call_2", ruling)).details, ruling);
  assert.deepEqual(linesIn(missing), [{ type: "report", call: REPORT_VERDICT, value: ruling }]);
});

test("a finish that cannot be recorded is refused", async (t) => {
  const refused = await refusalOf(toolOf(loaded(unwritable(t)), FINISH_REVIEW), {});
  assert.match(refused, /the finish could not be recorded, so the review is not finished/u);
});

/** The call is stopped either way, and what the reviewer reads still opens as a refusal. */
test("a refusal that cannot be recorded still refuses, and says it was not recorded", (t) => {
  const refused = subscribedHandler(unwritable(t))({
    toolName: "edit",
    input: { path: "src/a.ts" },
  });
  assert.equal(refused?.block, true);
  assert.match(refused?.reason ?? "", /^squiz refused this call: /u);
  assert.match(refused?.reason ?? "", /The refusal could not be recorded/u);
});

test("a report refused and not recorded says both", async (t) => {
  const refused = await refusalOf(toolOf(loaded(unwritable(t)), REPORT_FINDING), {
    scope: "line",
  });
  assert.match(refused, /^the finding /u);
  assert.match(refused, /The refusal could not be recorded/u);
});

/**
 * `pi` catches what a message handler throws and shows it as the extension's
 * error, on stderr or in the pane. Swallowing it here would leave a round that
 * undercounts its cost with nothing anywhere saying so.
 */
test("usage that cannot be recorded throws, for pi to show", (t) => {
  const handler = messageHandler(unwritable(t));
  assert.throws(
    () => handler({ type: "message_end", message: assistantMessage }),
    /ENOENT/u,
  );
});

/**
 * A file holding the finish and missing a message reads as a complete review
 * that cost less than it did. So the lost usage is written ahead of the next
 * line that can be, and the finish cannot land without it.
 */
test("usage that could not be recorded is written before a later finish", async (t) => {
  const missing = unwritable(t);
  const extension = loaded(missing);
  const message = onlyHandler(extension, "message_end") as MessageHandler;
  assert.throws(() => message({ type: "message_end", message: assistantMessage }), /ENOENT/u);

  mkdirSync(join(missing, ".."));
  await toolOf(extension, FINISH_REVIEW).execute("call_1", {});
  assert.deepEqual(
    linesIn(missing).map((line) => (line as { type: string }).type),
    ["usage", "finish"],
    "the finish was recorded and the usage lost before it was not",
  );
});

/**
 * `pi` defers its exit until the reviewer has written its closing message, so
 * that message's usage arrives after the finish, with no later line to carry
 * it. The end of the run is its last chance.
 */
for (const event of ["agent_settled", "session_shutdown"]) {
  test(`usage lost after the finish is written on ${event}`, async (t) => {
    const reports = reportsFile(t);
    const extension = loaded(reports);
    await toolOf(extension, FINISH_REVIEW).execute("call_1", {});

    chmodSync(reports, 0o444);
    const message = onlyHandler(extension, "message_end") as MessageHandler;
    const closing = { ...assistantMessage, stopReason: "stop" };
    assert.throws(() => message({ type: "message_end", message: closing }), /EACCES/u);
    chmodSync(reports, 0o644);

    for (const handler of extension.handlers.get(event) ?? []) {
      (handler as EndHandler)({ type: event }, { shutdown: () => {} });
    }
    assert.deepEqual(
      linesIn(reports).map((line) => (line as { type: string }).type),
      ["finish", "usage"],
      "the closing message's usage was never written",
    );
  });
}

/** The type of each line in the file, in order. */
function typesIn(path: string): string[] {
  return linesIn(path).map((line) => (line as { type: string }).type);
}

/** A context whose every shutdown records the types of the lines in the file at that moment. */
function shuttingDown(reports: string): { ctx: Context; shutdowns: string[][] } {
  const shutdowns: string[][] = [];
  return { ctx: { shutdown: () => shutdowns.push(typesIn(reports)) }, shutdowns };
}

/** The extension's agent_settled handler, run as `pi` runs it once the agent settles. */
function settle(extension: Loaded, ctx: Context): void {
  (onlyHandler(extension, "agent_settled") as EndHandler)({ type: "agent_settled" }, ctx);
}

test("finishing the review shuts pi down once the finish is in the file", async (t) => {
  const reports = reportsFile(t);
  const { ctx, shutdowns } = shuttingDown(reports);
  await toolNamed(FINISH_REVIEW, reports).execute("call_1", {}, undefined, undefined, ctx);
  assert.deepEqual(shutdowns, [["finish"]], "pi was not shut down once, after the finish was written");
});

test("a finish that cannot be recorded does not shut pi down", async (t) => {
  const missing = unwritable(t);
  const { ctx, shutdowns } = shuttingDown(missing);
  const finish = toolOf(loaded(missing), FINISH_REVIEW);
  await assert.rejects(finish.execute("call_1", {}, undefined, undefined, ctx));
  assert.deepEqual(shutdowns, [], "pi was shut down on a finish the reviewer was told to call again");
});

test("an agent that settles with no finish records an unfinished end and shuts pi down", (t) => {
  const reports = reportsFile(t);
  const { ctx, shutdowns } = shuttingDown(reports);
  settle(loaded(reports), ctx);
  assert.deepEqual(linesIn(reports), [{ type: "unfinished" }]);
  assert.deepEqual(shutdowns, [["unfinished"]], "pi was not shut down once, after the unfinished end");
});

/**
 * A file that ends unfinished while missing a message reads as a review that
 * cost less than it did, so the lost usage goes first.
 */
test("usage that could not be recorded is written before the unfinished end", (t) => {
  const missing = unwritable(t);
  const extension = loaded(missing);
  const message = onlyHandler(extension, "message_end") as MessageHandler;
  assert.throws(() => message({ type: "message_end", message: assistantMessage }), /ENOENT/u);

  mkdirSync(join(missing, ".."));
  const { ctx, shutdowns } = shuttingDown(missing);
  settle(extension, ctx);
  assert.deepEqual(typesIn(missing), ["usage", "unfinished"]);
  assert.deepEqual(shutdowns, [["usage", "unfinished"]]);
});

/** `pi` fires agent_settled after the closing message of a finished review as well. */
test("an agent that settles after the finish records no unfinished end", async (t) => {
  const reports = reportsFile(t);
  const extension = loaded(reports);
  await toolOf(extension, FINISH_REVIEW).execute("call_1", {}, undefined, undefined, { shutdown: () => {} });
  const message = onlyHandler(extension, "message_end") as MessageHandler;
  message({ type: "message_end", message: { ...assistantMessage, stopReason: "stop" } });

  settle(extension, { shutdown: () => {} });
  assert.deepEqual(typesIn(reports), ["finish", "usage"]);
});

/**
 * The file cannot record that it refused the unfinished end, and the round
 * already reads a run with no finish as unfinished. A `pi` left running would
 * wait for input until the round's time bound.
 */
test("an unfinished end that cannot be recorded still shuts pi down, and throws for pi to show", (t) => {
  const missing = unwritable(t);
  let shutdowns = 0;
  assert.throws(
    () => settle(loaded(missing), { shutdown: () => (shutdowns += 1) }),
    /ENOENT/u,
  );
  assert.equal(shutdowns, 1, "pi was left waiting for input");
});

/** Restore the variables the extension reads, whatever the test set them to. */
function keepVariable(t: { after: (fn: () => void) => void }): void {
  for (const name of [REPORTS_VARIABLE, GRANT_VARIABLE]) {
    const before = process.env[name];
    t.after(() => {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    });
  }
}

/** The handler of the extension `pi` loads, with the grant variable set to `grant`, or unset. */
function handlerUnder(grant: string | undefined): Handler {
  delete process.env[REPORTS_VARIABLE];
  if (grant === undefined) delete process.env[GRANT_VARIABLE];
  else process.env[GRANT_VARIABLE] = grant;
  const { pi, loaded: extension } = registrar();
  reportAsYouGo(pi);
  return onlyHandler(extension, "tool_call") as Handler;
}

// pi falls back to read, bash, edit and write where --tools is lost, so each of
// those it would add, and a name nothing grants, has to be refused here.
test("the extension pi loads refuses every call the grant it was handed leaves out", (t) => {
  keepVariable(t);
  const handler = handlerUnder(grants.join(","));
  for (const tool of ["bash", "edit", "write", "delete_everything"]) {
    assert.equal(
      handler({ toolName: tool, input: { command: "touch x", path: "src/a.ts" } })?.reason,
      `squiz refused this call: \`${tool}\` is not a tool this review grants.`,
      tool,
    );
  }
  for (const tool of grants) {
    assert.equal(handler({ toolName: tool, input: { path: "package.json" } }), undefined, tool);
  }
});

test("the extension pi loads refuses a history tool a grant leaves out", (t) => {
  keepVariable(t);
  const handler = handlerUnder("read,grep,find,ls");
  assert.equal(handler({ toolName: "git_show", input: { commit: "HEAD" } })?.block, true);
});

// A command line that lost the variable is the same mistake as one that lost
// --tools, so it allows nothing rather than everything.
test("the extension pi loads refuses every call where no grant was handed to it", (t) => {
  keepVariable(t);
  const handler = handlerUnder(undefined);
  for (const tool of [...grants, "bash"]) {
    assert.equal(handler({ toolName: tool, input: { path: "package.json" } })?.block, true, tool);
  }
});

test("the extension pi loads writes to the file the variable names", async (t) => {
  keepVariable(t);
  const reports = reportsFile(t);
  process.env[REPORTS_VARIABLE] = reports;

  const { pi, loaded: extension } = registrar();
  reportAsYouGo(pi);
  await toolOf(extension, FINISH_REVIEW).execute("call_1", {});
  assert.deepEqual(linesIn(reports), [{ type: "finish" }]);
});

/**
 * Only the adapter's command line sets the variable. With it unset, every call
 * still answers rather than being refused.
 */
test("with no file named, every call answers as it did", async (t) => {
  keepVariable(t);
  delete process.env[REPORTS_VARIABLE];

  const { pi, loaded: extension } = registrar();
  reportAsYouGo(pi);
  const unset = "with no file named, the call was refused rather than answered";
  await assert.doesNotReject(async () => {
    const answer = await toolOf(extension, REPORT_FINDING).execute("call_1", lineFinding);
    assert.deepEqual(answer.details, lineFinding);
  }, unset);
  await assert.doesNotReject(toolOf(extension, FINISH_REVIEW).execute("call_2", {}), unset);
  const message = onlyHandler(extension, "message_end") as MessageHandler;
  assert.doesNotThrow(
    () => message({ type: "message_end", message: assistantMessage }),
    "with no file named, an assistant message threw",
  );
});

/** The history tools served in `snapshot`, by default this repository, which has a history to read. */
function historyLoaded(snapshot: string = process.cwd()): Loaded {
  const { pi, loaded: extension } = registrar();
  serveHistoryTools(pi, snapshot);
  return extension;
}

/** The tools `pi` brings itself, which the extension does not register. */
const builtIn = new Set(["read", "grep", "find", "ls"]);

// pi registers what the extension offers and grants what --tools names, so a
// name in one list and not the other is a tool offered and never granted.
test("the extension pi loads registers exactly what the grant names", (t) => {
  keepVariable(t);
  const { pi, loaded: extension } = registrar();
  reportAsYouGo(pi);
  assert.deepEqual(
    [...extension.tools.keys()].sort(),
    grants.filter((name) => !builtIn.has(name)).sort(),
  );
});

test("each history tool is registered under its shared runner's name, schema and description", () => {
  const extension = historyLoaded();
  for (const shared of historyTools) {
    const tool = toolOf(extension, shared.name);
    assert.deepEqual(tool.parameters, shared.parameters);
    assert.equal(tool.description, shared.description);
    assert.notEqual(tool.label, "", `${shared.name} carries no label`);
  }
});

// pi marks a call's answer as an error only where execute throws.
test("a history tool that failed is the call's error", async () => {
  for (const { name } of historyTools) {
    const refused = await refusalOf(toolOf(historyLoaded(), name), {});
    assert.notEqual(refused, "", `${name} failed with no reason`);
  }
});

test("a history tool's result is the call's answer", async () => {
  const answer = await toolOf(historyLoaded(), "git_show").execute("call_1", { commit: "HEAD" });
  const [content] = answer.content;
  assert.ok(content !== undefined && content.text.startsWith("commit "), JSON.stringify(answer));
});

test("the signal pi hands a call reaches the runner", async () => {
  const tool = toolOf(historyLoaded(), "git_show");
  await assert.rejects(tool.execute("call_1", { commit: "HEAD" }, AbortSignal.abort()));
});
