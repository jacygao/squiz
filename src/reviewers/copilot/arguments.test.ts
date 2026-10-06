import assert from "node:assert/strict";
import { test } from "node:test";

import { mismatchOf } from "./arguments.ts";
import { deepTools } from "../deep-tools.ts";

const valid: Readonly<Record<string, unknown>> = {
  run_tests: {},
  git_log_search: { term: "margin" },
  git_blame: { file: "src/place.ts", line: 12 },
  git_show: { commit: "HEAD~1" },
};

// A keyword the check does not know would refuse every call to the tool.
test("every deep tool's schema is one the check can read, and passes a call that matches it", () => {
  for (const tool of deepTools({})) {
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
