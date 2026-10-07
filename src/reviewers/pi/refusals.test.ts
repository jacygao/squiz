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
import { grantIn, refuse } from "./refusals.ts";

/** One tool call, in the shape `pi` emits it: the fields the handler never reads included. */
function called(toolName: string, input: unknown): { toolName: string; input: unknown } {
  return { type: "tool_call", toolCallId: "call_7", toolName, input } as unknown as {
    toolName: string;
    input: unknown;
  };
}

/** What the reviewer is told in place of the call, which is the point of refusing it. */
function reasonFor(call: { toolName: string; input: unknown }, grant: readonly string[]): string {
  const refused = refuse(call, grant);
  assert.ok(refused !== undefined, `the call was let through: ${JSON.stringify(call)}`);
  assert.equal(refused.block, true, "a refusal that does not block runs the tool anyway");
  return refused.reason;
}

/** `pi`'s own default set, which it falls back to where no `--tools` reaches it, and a name nothing serves. */
const ungranted = ["bash", "edit", "write", "delete_everything"];

test("a tool the grant does not name is refused, and the reviewer is told so", () => {
  for (const grant of Object.values(grants)) {
    for (const tool of ungranted) {
      assert.equal(
        reasonFor(called(tool, { path: "src/threads.ts" }), grant),
        `squiz refused this call: \`${tool}\` is not a tool this review grants.`,
      );
    }
  }
});

test("every tool the grant names is left alone", () => {
  for (const grant of Object.values(grants)) {
    for (const tool of grant) {
      assert.equal(refuse(called(tool, { path: "src/threads.ts" }), grant), undefined, tool);
    }
  }
});

/** The allow-list is the grant handed over, so a tool one grant carries is refused under one that does not. */
test("a tool is refused under a grant that leaves it out", () => {
  assert.equal(refuse(called("git_show", { commit: "HEAD" }), ["read", "git_show"]), undefined);
  assert.equal(refuse(called("git_show", { commit: "HEAD" }), ["read"])?.block, true);
});

/** The name is the whole of it: nothing is read out of what the call was given. */
test("a refused tool is refused whatever it was given, including nothing", () => {
  for (const input of [undefined, {}, { command: "git status" }]) {
    assert.equal(refuse(called("bash", input), grants.read)?.block, true, JSON.stringify(input));
  }
});

test("with no grant handed over, every call is refused", () => {
  assert.deepEqual(grantIn(undefined), []);
  assert.deepEqual(grantIn(""), []);
  for (const tool of grants.deep) {
    assert.equal(refuse(called(tool, {}), grantIn(undefined))?.block, true, tool);
  }
});

test("the grant is read back as the names it was handed over as", () => {
  for (const grant of Object.values(grants)) {
    assert.deepEqual(grantIn(grant.join(",")), grant);
  }
});

/**
 * `pi` treats a handler that throws as one that blocked, so a throw here refuses
 * a call this meant to allow. Every path answers instead.
 */
test("the handler answers rather than throwing, whatever the call carries", () => {
  const hostile: readonly unknown[] = [
    { toolName: "edit", input: null },
    { toolName: "", input: undefined },
    { toolName: undefined, input: undefined },
    { toolName: "read", input: Object.create(null) as unknown },
  ];
  for (const call of hostile) {
    assert.doesNotThrow(() => refuse(call as { toolName: string; input: unknown }, grants.read));
  }
});
