import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";

import { refuseRead } from "./reads.ts";

/**
 * A snapshot with a decoy beside it, and links inside it that point out at the
 * decoy and in at its own file.
 */
function fixture(t: TestContext): { snapshot: string; decoy: string } {
  const base = mkdtempSync(join(tmpdir(), "squiz-reads-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const snapshot = join(base, "tree");
  const secret = join(base, "secret");
  mkdirSync(join(snapshot, "src"), { recursive: true });
  mkdirSync(secret);
  writeFileSync(join(snapshot, "src", "place.ts"), "export {};\n");
  const decoy = join(secret, "id_rsa");
  writeFileSync(decoy, "decoy\n");
  symlinkSync(decoy, join(snapshot, "key"));
  symlinkSync(secret, join(snapshot, "keys"));
  symlinkSync(join(snapshot, "src"), join(snapshot, "source"));
  return { snapshot, decoy };
}

const call = (toolName: string, input: unknown) => ({ toolName, input });

test("a read outside the snapshot is refused, by an absolute path, a .. path, or a link that points out", (t) => {
  const { snapshot, decoy } = fixture(t);
  const ways = {
    "an absolute path": decoy,
    "a .. path": "../secret/id_rsa",
    "a link to a file": "key",
    "a link to a directory": "keys/id_rsa",
    "a path that climbs back out through a link": "source/../../secret/id_rsa",
  };
  for (const [way, path] of Object.entries(ways)) {
    const refused = refuseRead(call("read", { path }), snapshot);
    assert.ok(refused?.block === true, `${way} was let through: ${path}`);
    assert.match(refused.reason, /^squiz refused this call: /u);
    assert.ok(refused.reason.includes(path), `the reason does not name ${path}: ${refused.reason}`);
  }
});

test("grep, find and ls rooted outside the snapshot are refused", (t) => {
  const { snapshot, decoy } = fixture(t);
  const outside = join(decoy, "..");
  for (const tool of ["grep", "find", "ls"]) {
    for (const path of [outside, "../secret", "keys"]) {
      const refused = refuseRead(call(tool, { pattern: "decoy", path }), snapshot);
      assert.ok(refused?.block === true, `${tool} at ${path} was let through`);
    }
  }
});

test("the spellings pi expands before it reads are refused where they lead out", (t) => {
  const { snapshot, decoy } = fixture(t);
  for (const path of ["~/.ssh/id_rsa", "~", `@${decoy}`, pathToFileURL(decoy).href]) {
    assert.ok(refuseRead(call("read", { path }), snapshot)?.block === true, `${path} was let through`);
  }
});

// pi reads a file it cannot find under a spelling of its name with a curly
// apostrophe, as macOS writes one, so a link of that name is a way out too.
test("a link that pi would reach under another spelling of the path is refused", (t) => {
  const { snapshot, decoy } = fixture(t);
  symlinkSync(join(decoy, ".."), join(snapshot, "it’s"));
  assert.ok(refuseRead(call("read", { path: "it's/id_rsa" }), snapshot)?.block === true);
});

test("a read inside the snapshot runs, however it is spelled", (t) => {
  const { snapshot } = fixture(t);
  for (const path of [
    "src/place.ts",
    "./src/place.ts",
    join(snapshot, "src", "place.ts"),
    "source/place.ts",
    "src/../src/place.ts",
    "src/missing.ts",
    `@src/place.ts`,
  ]) {
    assert.equal(refuseRead(call("read", { path }), snapshot), undefined, `${path} was refused`);
  }
  for (const tool of ["grep", "find", "ls"]) {
    assert.equal(refuseRead(call(tool, { pattern: "x" }), snapshot), undefined, `${tool} with no path was refused`);
    assert.equal(refuseRead(call(tool, { pattern: "x", path: "." }), snapshot), undefined);
    assert.equal(refuseRead(call(tool, { pattern: "x", path: snapshot }), snapshot), undefined);
  }
});

test("a snapshot under a directory with an apostrophe in its name is read like any other", (t) => {
  const base = mkdtempSync(join(tmpdir(), "squiz-reads-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const snapshot = join(base, "alice's-project", "tree");
  mkdirSync(snapshot, { recursive: true });
  writeFileSync(join(snapshot, "package.json"), "{}\n");
  assert.equal(refuseRead(call("read", { path: "package.json" }), snapshot), undefined);
  for (const tool of ["grep", "find", "ls"]) {
    assert.equal(refuseRead(call(tool, { pattern: "x" }), snapshot), undefined, `${tool} with no path was refused`);
  }
});

test("a call that is not a read is not read", (t) => {
  const { snapshot, decoy } = fixture(t);
  assert.equal(refuseRead(call("report_finding", { path: decoy }), snapshot), undefined);
  assert.equal(refuseRead(call("git_blame", { file: decoy, line: 1 }), snapshot), undefined);
});

test("a path that is not a string is refused rather than guessed at", (t) => {
  const { snapshot } = fixture(t);
  for (const input of [{ path: 7 }, { path: ["src"] }, null, "src"]) {
    assert.ok(refuseRead(call("ls", input), snapshot)?.block === true, `${JSON.stringify(input)} was let through`);
  }
});

test("a file URL that names no path is refused rather than thrown", (t) => {
  const { snapshot } = fixture(t);
  for (const path of ["file:///tmp/%", "file:///tmp/a%2Fb"]) {
    let refused;
    assert.doesNotThrow(() => {
      refused = refuseRead(call("read", { path }), snapshot);
    }, `${path} threw`);
    assert.equal((refused as { block?: boolean } | undefined)?.block, true, `${path} was let through`);
  }
});

test("every read is refused where the snapshot itself cannot be resolved", (t) => {
  const { snapshot } = fixture(t);
  const gone = join(snapshot, "nowhere");
  assert.ok(refuseRead(call("read", { path: "src/place.ts" }), gone)?.block === true);
});
