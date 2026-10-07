import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
  extensions?: string;
};

const registration = readJson("../hooks/hooks.json") as {
  hooks?: Record<
    string,
    { hooks?: { type?: string; command?: string; asyncRewake?: boolean; timeout?: number }[] }[]
  >;
};

const packageVersion = (readJson("../package.json") as { version?: string }).version;

test("the manifest names the plugin", () => {
  assert.equal(manifest.name, "squiz", "the name is what `/plugin install` and the binary share");
  assert.ok((manifest.description ?? "").length > 0, "the description is what a marketplace lists");
});

test("the manifest names the directory of Copilot extensions, and the wake extension is in it", () => {
  // Copilot reads the field and Claude Code ignores it. Copilot starts each
  // subdirectory's extension.mjs.
  assert.equal(manifest.extensions, "extensions");
  assert.ok(existsSync(fileURLToPath(new URL("../extensions/squiz-wake/extension.mjs", import.meta.url))));
});

test("the manifest's version is the package's", () => {
  // The plugin is the package, so a second version number here is the same one
  // written twice, and the two drift the first time either is bumped.
  assert.equal(manifest.version, packageVersion);
});

test("the marketplace lists this repository's plugin under the manifest's name and version", () => {
  const marketplace = readJson("../.claude-plugin/marketplace.json") as {
    name?: string;
    plugins?: { name?: string; source?: unknown; version?: string }[];
  };
  // The marketplace's name is the half after the @ in `/plugin install squiz@squiz`.
  assert.equal(marketplace.name, "squiz");
  const entries = marketplace.plugins ?? [];
  assert.equal(entries.length, 1, "the marketplace lists squiz and nothing else");
  const [entry] = entries;
  assert.equal(entry?.name, manifest.name, "the entry's name is the one `/plugin install` resolves against plugin.json");
  assert.equal(entry?.version, manifest.version, "a marketplace version that differs from plugin.json's installs under the wrong one");
  assert.equal(entry?.source, "./", "the plugin is this repository, at its root");
});

function commandsOn(event: string): readonly unknown[] {
  return (registration.hooks?.[event] ?? []).flatMap((matcher) => matcher.hooks ?? []);
}

// The bare name does not resolve in either. A hook runs under a shell whose PATH
// is the user's, without the plugin's bin/ in it, and the runtime supplies the
// root instead.
const command = "${CLAUDE_PLUGIN_ROOT}/bin/squiz hook";

test("Stop runs the binary through the plugin root, in the background, for as long as a day", () => {
  assert.deepEqual(commandsOn("Stop"), [{ type: "command", command, asyncRewake: true, timeout: 86_400 }]);
});

test("SubagentStop runs the binary through the plugin root, under the runtime's own timeout", () => {
  assert.deepEqual(commandsOn("SubagentStop"), [{ type: "command", command }]);
});
