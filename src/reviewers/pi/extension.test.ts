/**
 * The extension driven the way `pi` drives it: loaded once, then called.
 *
 * `pi` is not here, so what this holds is the half the harness owns — the names
 * registered, the schema the CLI is asked to validate against, what each call
 * answers with, and that the refusal is subscribed at all. That `pi` loads the
 * file and grants the calls is held by the command line and the grant beside it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import reportAsYouGo, { type Registrar } from "./extension.ts";
import type { Refusal, ToolCall } from "./refusals.ts";
import { FINISH_REVIEW, REPORT_FINDING, REPORT_VERDICT, reportingTools } from "./reporting.ts";

type Tool = Parameters<Registrar["registerTool"]>[0];
type Handler = (call: ToolCall) => Refusal | undefined;

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
function loaded(): { tools: Map<string, Tool>; handlers: Map<string, Handler[]> } {
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Handler[]>();
  reportAsYouGo({
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  });
  return { tools, handlers };
}

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
function subscribedHandler(): Handler {
  const subscribed = loaded().handlers.get("tool_call") ?? [];
  assert.equal(
    subscribed.length,
    1,
    "the extension subscribed no tool_call handler, so pi runs every call the reviewer makes",
  );
  const [handler] = subscribed;
  assert.ok(handler !== undefined);
  return handler;
}

function toolNamed(name: string): Tool {
  const tool = registered().get(name);
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
  const refused = await refusalOf(tool, { thread: "PRRT_kwDOAbc123", verdict: "open" });
  assert.match(refused, /PRRT_kwDOAbc123 was already ruled on/);

  const other = { thread: "PRRT_kwDOAbc456", verdict: "open" };
  assert.deepEqual((await tool.execute("call_3", other)).details, other);
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
test("the extension subscribes a handler that refuses a commit", () => {
  const refused = subscribedHandler()({ toolName: "bash", input: { command: "git commit -m x" } });
  assert.equal(refused?.block, true, "the subscribed handler let a commit through");
  assert.match(refused?.reason ?? "", /changes what the coding agent commits/u);
});

test("the subscribed handler lets a command nothing objects to through", () => {
  assert.equal(subscribedHandler()({ toolName: "bash", input: { command: "npm test" } }), undefined);
});

test("every call describes itself to the reviewer", () => {
  for (const [name, tool] of registered()) {
    assert.notEqual(tool.description, "", `${name} carries no description`);
    assert.equal(tool.label === "", false, `${name} carries no label`);
  }
});
