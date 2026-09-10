import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

function readJson(relative: string): unknown {
  const path = fileURLToPath(new URL(relative, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

const manifest = readJson("../.claude-plugin/plugin.json") as {
  name?: string;
  version?: string;
  description?: string;
};

const registration = readJson("../hooks/hooks.json") as {
  hooks?: Record<string, { hooks?: { type?: string; command?: string }[] }[]>;
};

const packageVersion = (readJson("../package.json") as { version?: string }).version;

test("the manifest names the plugin", () => {
  assert.equal(manifest.name, "squiz", "the name is what `/plugin install` and the binary share");
  assert.ok((manifest.description ?? "").length > 0, "the description is what a marketplace lists");
});

test("the manifest's version is the package's", () => {
  // The plugin is the package, so a second version number here is the same one
  // written twice, and the two drift the first time either is bumped.
  // (review-harness-spec, "Structure")
  assert.equal(manifest.version, packageVersion);
});

test("SubagentStop runs the binary through the plugin root", () => {
  // The bare name does not resolve here. A hook runs under a shell whose PATH
  // is the user's, without the plugin's bin/ in it, and the runtime supplies
  // the root instead.
  // (docs/notes/the-hook-shell-does-not-get-the-plugin-bin-on-path.md)
  const registered = registration.hooks?.["SubagentStop"] ?? [];
  const commands = registered.flatMap((matcher) => matcher.hooks ?? []);

  assert.deepEqual(
    commands,
    [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/bin/squiz hook" }],
    "the registration goes through the root the runtime gives it, never an install path",
  );
});
