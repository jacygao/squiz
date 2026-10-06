/**
 * The handler driven the way `pi` drives it: one tool call at a time, in the
 * shape `pi` hands over, and the answer read as `pi` reads it.
 *
 * `pi` is not here, so the event is written out as `pi` emits it rather than
 * imported. The types are structural, which means a shape that drifted from
 * `pi`'s would compile and fail only in a round, so the calls below carry the
 * fields `pi` carries and nothing is narrowed to what the handler happens to
 * read.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { grants } from "./argv.ts";
import { refuse, refusedTools } from "./refusals.ts";

/** One tool call, in the shape `pi` emits it: the fields the handler never reads included. */
function called(toolName: string, input: unknown): { toolName: string; input: unknown } {
  return { type: "tool_call", toolCallId: "call_7", toolName, input } as unknown as {
    toolName: string;
    input: unknown;
  };
}

/** What the reviewer is told in place of the call, which is the point of refusing it. */
function reasonFor(call: { toolName: string; input: unknown }): string {
  const refused = refuse(call);
  assert.ok(refused !== undefined, `the call was let through: ${JSON.stringify(call)}`);
  assert.equal(refused.block, true, "a refusal that does not block runs the tool anyway");
  return refused.reason;
}

test("the tools a review has no use for are refused by name", () => {
  assert.deepEqual([...refusedTools], ["edit", "write"]);
  for (const tool of refusedTools) {
    const reason = reasonFor(called(tool, { path: "src/threads.ts", content: "anything" }));
    assert.match(reason, /^squiz refused this call: /u);
    assert.match(reason, new RegExp(`\`${tool}\``, "u"), `the refusal of ${tool} does not name it`);
  }
});

/** The name is the whole of it: nothing is read out of what the call was given. */
test("a refused tool is refused whatever it was given, including nothing", () => {
  for (const tool of refusedTools) {
    assert.equal(refuse(called(tool, undefined))?.block, true);
    assert.equal(refuse(called(tool, {}))?.block, true);
  }
});

test("the tools the deep grant carries are left alone", () => {
  for (const tool of grants.deep) {
    assert.equal(refuse(called(tool, { path: "src/threads.ts" })), undefined);
  }
});

/** No depth grants a shell, so a command line is never read, whatever it would do. */
test("a shell call is not read for what its command would do", () => {
  for (const input of [{ command: "git commit -m x" }, { command: "git push" }, undefined]) {
    assert.equal(refuse(called("bash", input)), undefined, JSON.stringify(input));
  }
});

test("the reason tells the reviewer what to do instead", () => {
  assert.match(reasonFor(called("write", {})), /Report what is wrong with the change/u);
});

/**
 * `pi` treats a handler that throws as one that blocked, so a throw here refuses
 * a call this meant to allow. Every path answers instead.
 */
test("the handler answers rather than throwing, whatever the call carries", () => {
  const hostile: readonly unknown[] = [
    { toolName: "edit", input: null },
    { toolName: "", input: undefined },
    { toolName: "read", input: Object.create(null) as unknown },
  ];
  for (const call of hostile) {
    assert.doesNotThrow(() => refuse(call as { toolName: string; input: unknown }));
  }
});

/** The list holds against a caller that would add to it at runtime. */
test("the list cannot be added to", () => {
  assert.throws(() => (refusedTools as string[]).push("read"));
});
