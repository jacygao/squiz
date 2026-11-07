import assert from "node:assert/strict";
import { test } from "node:test";

import { deadlineIn } from "../reviewers/deadline.ts";
import { githubVenue } from "./github/venue.ts";
import { localVenue } from "./local/venue.ts";
import { venueFor } from "./venue.ts";

test("venueFor chooses the GitHub venue where SQUIZ_VENUE is not set", () => {
  assert.deepEqual(venueFor({}), { outcome: "chosen", venue: githubVenue });
});

test("venueFor chooses the GitHub venue where SQUIZ_VENUE is the empty string, or github", () => {
  assert.deepEqual(venueFor({ SQUIZ_VENUE: "" }), { outcome: "chosen", venue: githubVenue });
  assert.deepEqual(venueFor({ SQUIZ_VENUE: "github" }), { outcome: "chosen", venue: githubVenue });
});

test("venueFor chooses the local venue where SQUIZ_VENUE is local", () => {
  assert.deepEqual(venueFor({ SQUIZ_VENUE: "local" }), { outcome: "chosen", venue: localVenue });
});

test("venueFor chooses no venue for any other SQUIZ_VENUE, and names the value and the venues there are", () => {
  for (const value of ["lcoal", "Local", " local", "github "]) {
    assert.deepEqual(venueFor({ SQUIZ_VENUE: value }), {
      outcome: "failed",
      reason: `SQUIZ_VENUE is ${JSON.stringify(value)}, and squiz has the venues github and local`,
    });
  }
});

test("venueFor no longer reads SQUIZ_LOCAL", () => {
  assert.deepEqual(venueFor({ SQUIZ_LOCAL: "/work/squiz-review" }), { outcome: "chosen", venue: githubVenue });
});

test("the GitHub venue records nothing at a start, and touches nothing", () => {
  assert.deepEqual(githubVenue.recordStart("/nowhere/at/all", deadlineIn(0)), {
    outcome: "done",
  });
});
