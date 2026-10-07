import assert from "node:assert/strict";
import { test } from "node:test";

import { mismatchOf } from "./arguments.ts";
import { historyTools } from "../git-tools.ts";

const valid: Readonly<Record<string, unknown>> = {
  git_log_search: { term: "margin" },
  git_blame: { file: "src/place.ts", line: 12 },
  git_show: { commit: "HEAD~1" },
};

// A keyword the check does not know would refuse every call to the tool.
test("every history tool's schema is one the check can read, and passes a call that matches it", () => {
  for (const tool of historyTools) {
    assert.ok(tool.name in valid, `no valid call for ${tool.name}`);
    assert.equal(mismatchOf(tool.parameters, valid[tool.name]), undefined, tool.name);
  }
});

test("a schema using a keyword the check does not know refuses every call", () => {
  const schema = {
    type: "object",
    properties: { commit: { type: "string", pattern: "^[0-9a-f]+$" } },
  };
  assert.match(mismatchOf(schema, { commit: "zzz" }) ?? "", /pattern/u);
  assert.match(mismatchOf(schema, { commit: "abc" }) ?? "", /pattern/u);
  assert.match(mismatchOf({ ...schema, oneOf: [] }, {}) ?? "", /oneOf/u);
});

test("a schema the check cannot read refuses a call that leaves the property it cannot read out", () => {
  const pattern = { type: "object", properties: { commit: { type: "string", pattern: "^[0-9a-f]+$" } } };
  assert.match(mismatchOf(pattern, {}) ?? "", /pattern/u);
  const typed = { type: "object", properties: { count: { type: "number" } } };
  assert.match(mismatchOf(typed, {}) ?? "", /type/u);
});

test("a schema whose additionalProperties is a schema refuses every call", () => {
  const schema = { type: "object", properties: {}, additionalProperties: { type: "string" } };
  assert.match(mismatchOf(schema, { extra: 42 }) ?? "", /additionalProperties/u);
  assert.match(mismatchOf(schema, {}) ?? "", /additionalProperties/u);
});

test("an argument the schema does not name is passed over unless the schema forbids it", () => {
  const open = { type: "object", properties: { term: { type: "string" } } };
  assert.equal(mismatchOf(open, { term: "a", page: 2 }), undefined);
  assert.match(mismatchOf({ ...open, additionalProperties: false }, { term: "a", page: 2 }) ?? "", /page/u);
});

test("a whole number written with a fraction is an integer, and a fraction is not", () => {
  const schema = { type: "object", properties: { line: { type: "integer" } } };
  assert.equal(mismatchOf(schema, { line: 12.0 }), undefined);
  assert.match(mismatchOf(schema, { line: 12.5 }) ?? "", /integer/u);
});
