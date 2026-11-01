import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { squizVersion } from "./version.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "squiz-768-version-")));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let made = 0;

/** A squiz install whose `plugin.json` holds `manifest`, or none where it is left out, and the path of its `bin/squiz`. */
function install(manifest?: string): string {
  const root = join(scratch, `install-${made++}`);
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "squiz"), "");
  if (manifest !== undefined) {
    mkdirSync(join(root, ".claude-plugin"));
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), manifest);
  }
  return join(root, "bin", "squiz");
}

test("the version is the one in the plugin.json beside the bin/squiz that answers, with that path", () => {
  const target = install(JSON.stringify({ name: "squiz", version: "9.8.7" }));

  const printed = squizVersion(() => target);

  assert.deepEqual(printed, { stdout: `squiz 9.8.7 ${target}\n`, stderr: "", exit: 0 });
});

test("a plugin.json that cannot be read is said on stderr, and exits 1", () => {
  const target = install();

  const printed = squizVersion(() => target);

  assert.equal(printed.stdout, "", "a version that could not be read must not print as one");
  assert.equal(printed.exit, 1);
  assert.match(printed.stderr, /^squiz: the version of this squiz could not be read: .*plugin\.json could not be read: ENOENT/u);
});

test("a plugin.json naming another plugin is not read as squiz's version", () => {
  const target = install(JSON.stringify({ name: "other", version: "1.0.0" }));

  const printed = squizVersion(() => target);

  assert.equal(printed.stdout, "");
  assert.equal(printed.exit, 1);
  assert.match(printed.stderr, /^squiz: the version of this squiz could not be read: .* is not squiz\n$/u);
});
