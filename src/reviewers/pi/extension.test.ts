/**
 * The extension driven the way `pi` drives it: registered once, then called.
 *
 * `pi` is not here, so what this holds is the half the harness owns — the names
 * registered, the schema the CLI is asked to validate against, and what each
 * call answers with. That `pi` loads the file and grants the calls is held by
 * the command line and the grant beside it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import reportAsYouGo, { type Registrar } from "./extension.ts";
import { FINISH_REVIEW, REPORT_FINDING, REPORT_VERDICT, reportingTools } from "./reporting.ts";

type Tool = Parameters<Registrar["registerTool"]>[0];

const lineFinding = {
  scope: "line",
  file: "src/cards/place.ts",
  line: 128,
  severity: "high",
  headline: "Card can be placed off-screen once the explanation expands",
  reasoning: ["`placeCard()` clamps against `window.innerHeight` before the animation runs."],
  suggestedFix: "Re-run `placeCard()` from the animation's completion callback.",
};

/** The three calls, registered as `pi` registers them. */
function registered(): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  reportAsYouGo({ registerTool: (tool) => tools.set(tool.name, tool) });
  return tools;
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

test("every call describes itself to the reviewer", () => {
  for (const [name, tool] of registered()) {
    assert.notEqual(tool.description, "", `${name} carries no description`);
    assert.equal(tool.label === "", false, `${name} carries no label`);
  }
});
