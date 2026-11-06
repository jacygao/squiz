import assert from "node:assert/strict";
import { test } from "node:test";

import { githubVenue } from "./github/venue.ts";
import { venueFor } from "./venue.ts";

test("venueFor chooses the GitHub venue where SQUIZ_LOCAL is not set", () => {
  assert.deepEqual(venueFor({}), { outcome: "chosen", venue: githubVenue });
});

test("venueFor chooses the GitHub venue where SQUIZ_LOCAL is the empty string", () => {
  assert.deepEqual(venueFor({ SQUIZ_LOCAL: "" }), { outcome: "chosen", venue: githubVenue });
});

test("venueFor fails, naming the variable, where SQUIZ_LOCAL asks for the local venue", () => {
  assert.deepEqual(venueFor({ SQUIZ_LOCAL: "/work/squiz-review" }), {
    outcome: "failed",
    reason: `SQUIZ_LOCAL is "/work/squiz-review", and this squiz has no local venue`,
  });
});
