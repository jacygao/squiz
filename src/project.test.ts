import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

test("the package declares no runtime dependencies", () => {
  const stanzas = ["dependencies", "optionalDependencies", "peerDependencies"] as const;
  for (const stanza of stanzas) {
    assert.deepEqual(
      Object.keys(manifest[stanza] ?? {}),
      [],
      `${stanza} must be empty: everything outside the process is a subprocess`,
    );
  }
});

test("the harness runs on Node 24 or later", () => {
  const major = Number.parseInt(process.versions.node, 10);
  assert.ok(major >= 24, `Node 24 or later is required, and this is ${process.versions.node}`);
});
