import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { deadlineIn } from "../reviewers/deadline.ts";
import { githubVenue } from "./github/venue.ts";
import { localVenue } from "./local/venue.ts";
import { venueAt, venueFor } from "./venue.ts";

/** A repository holding `squizJson` as its `.squiz.json`, or none where it is null. */
function repository(squizJson: string | null): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "squiz-venue-")));
  const ran = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  if (squizJson !== null) writeFileSync(join(root, ".squiz.json"), squizJson);
  return root;
}

test("venueFor chooses the venue the configuration names", () => {
  assert.equal(venueFor({ venue: "github" }), githubVenue);
  assert.equal(venueFor({ venue: "local" }), localVenue);
});

test("#838: venueAt chooses the local venue where the main worktree's .squiz.json says local", (t) => {
  const root = repository('{"venue": "local"}');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const chosen = venueAt(root, deadlineIn(30_000));

  assert.equal(chosen.outcome, "chosen");
  assert.equal(chosen.outcome === "chosen" && chosen.venue, localVenue);
});

test("#838: venueAt ignores SQUIZ_VENUE, and chooses GitHub where there is no .squiz.json", (t) => {
  const root = repository(null);
  const before = process.env["SQUIZ_VENUE"];
  process.env["SQUIZ_VENUE"] = "local";
  t.after(() => {
    if (before === undefined) delete process.env["SQUIZ_VENUE"];
    else process.env["SQUIZ_VENUE"] = before;
    rmSync(root, { recursive: true, force: true });
  });

  const chosen = venueAt(root, deadlineIn(30_000));

  assert.equal(chosen.outcome === "chosen" && chosen.venue, githubVenue);
});

test("#838: venueAt chooses no venue from a .squiz.json that cannot be parsed, rather than GitHub", (t) => {
  const root = repository('{"venue": "local",}');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const chosen = venueAt(root, deadlineIn(30_000));

  assert.equal(chosen.outcome, "failed");
  assert.match(chosen.outcome === "failed" ? chosen.reason : "", /\.squiz\.json is not valid JSON: /u);
});

test("the GitHub venue records nothing at a start, and touches nothing", () => {
  assert.deepEqual(githubVenue.recordStart("/nowhere/at/all", deadlineIn(0)), {
    outcome: "done",
  });
});
