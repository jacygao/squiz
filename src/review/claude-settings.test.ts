import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { allowSquizCommands } from "./claude-settings.ts";

// Every home here is a scratch directory, so no test reaches the real ~/.claude.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "squiz-707-settings-")));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let made = 0;

/** A fresh home with a `~/.claude`, its `settings.json` holding `settings` where it is given. */
function home(settings?: string): { home: string; file: string } {
  made += 1;
  const root = join(scratch, `home-${made}`);
  mkdirSync(join(root, ".claude"), { recursive: true });
  const file = join(root, ".claude", "settings.json");
  if (settings !== undefined) writeFileSync(file, settings, "utf8");
  return { home: root, file };
}

/** A fresh directory under the scratch space, or only its path where `make` is false. */
function directory(name: string, make = true): string {
  made += 1;
  const path = join(scratch, `${name}-${made}`);
  if (make) mkdirSync(path);
  return path;
}

const ALL = "Bash(squiz review *), Bash(squiz threads) and Bash(squiz reply *)";

test("with no settings file, squiz init creates it allowing the three commands (#707)", () => {
  const { home: root, file } = home();

  const printed = allowSquizCommands({ HOME: root });

  assert.deepEqual(printed, { stdout: `squiz: allowed ${ALL} in ${file}\n`, stderr: "" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    permissions: { allow: ["Bash(squiz review *)", "Bash(squiz threads)", "Bash(squiz reply *)"] },
  });
});

test("squiz init adds only the missing rules and keeps every other key and rule (#707)", () => {
  const before = {
    model: "opus",
    permissions: { allow: ["Bash(npm test)", "Bash(squiz threads)"], deny: ["Bash(rm *)"], defaultMode: "auto" },
    hooks: { Stop: [] },
  };
  const { home: root, file } = home(JSON.stringify(before, null, 2));

  const printed = allowSquizCommands({ HOME: root });

  assert.deepEqual(printed, {
    stdout: `squiz: allowed Bash(squiz review *) and Bash(squiz reply *) in ${file}\n`,
    stderr: "",
  });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    model: "opus",
    permissions: {
      allow: ["Bash(npm test)", "Bash(squiz threads)", "Bash(squiz review *)", "Bash(squiz reply *)"],
      deny: ["Bash(rm *)"],
      defaultMode: "auto",
    },
    hooks: { Stop: [] },
  });
});

test("a permissions object without allow gets the key, beside what it already holds (#707)", () => {
  const { home: root, file } = home('{"permissions":{"deny":["Bash(rm *)"]}}');

  allowSquizCommands({ HOME: root });

  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    permissions: {
      deny: ["Bash(rm *)"],
      allow: ["Bash(squiz review *)", "Bash(squiz threads)", "Bash(squiz reply *)"],
    },
  });
});

test("with all three already allowed, squiz init says so and leaves the file byte for byte (#707)", () => {
  const before = '{ "permissions": { "allow": ["Bash(squiz reply *)", "Bash(squiz review *)", "Bash(squiz threads)"] } }';
  const { home: root, file } = home(before);

  const printed = allowSquizCommands({ HOME: root });

  assert.deepEqual(printed, { stdout: `squiz: ${file} already allows ${ALL}; nothing changed\n`, stderr: "" });
  assert.equal(readFileSync(file, "utf8"), before);
});

/** Assert `before` is refused with a line naming the file and `why`, and left as it was. */
function refused(before: string, why: RegExp): void {
  const { home: root, file } = home(before);

  const printed = allowSquizCommands({ HOME: root });

  assert.equal(printed.stdout, "");
  assert.match(printed.stderr, /^squiz: allowed nothing in [^\n]+\n$/u);
  assert.ok(printed.stderr.startsWith(`squiz: allowed nothing in ${file}: `), printed.stderr);
  assert.match(printed.stderr, why);
  assert.equal(readFileSync(file, "utf8"), before, "the file was changed");
}

test("a settings file that is not JSON is left untouched, and named with why (#707)", () => {
  refused('{ "permissions": { "allow": [ } ', /it is not JSON/u);
});

test("a settings file that is JSON but not an object is left untouched, and named with why (#707)", () => {
  refused('["Bash(squiz threads)"]', /it holds a JSON array, not an object/u);
  refused("null", /it holds null, not an object/u);
});

test("a permissions that is not an object, or an allow that is not a list, is left untouched (#707)", () => {
  refused('{"permissions":"all"}', /its permissions is not an object/u);
  refused('{"permissions":{"allow":"Bash(squiz threads)"}}', /its permissions\.allow is not a list/u);
});

test("a permissions or allow that is null is refused rather than replaced (#707)", () => {
  refused('{"permissions":null}', /its permissions is not an object/u);
  refused('{"permissions":{"allow":null}}', /its permissions\.allow is not a list/u);
});

test("a settings symlink whose target is missing is left a link, and named with why (#707)", () => {
  const { home: root, file } = home();
  const target = join(root, "dotfiles", "claude-settings.json");
  symlinkSync(target, file);

  const printed = allowSquizCommands({ HOME: root });

  assert.equal(printed.stdout, "");
  assert.ok(printed.stderr.startsWith(`squiz: allowed nothing in ${file}: it could not be read: `), printed.stderr);
  assert.ok(lstatSync(file).isSymbolicLink(), "the link was replaced by a file");
});

test("a settings file that cannot be read is left untouched, and named with why (#707)", () => {
  const { home: root, file } = home();
  mkdirSync(file, { recursive: true });

  const printed = allowSquizCommands({ HOME: root });

  assert.equal(printed.stdout, "");
  assert.match(printed.stderr, new RegExp(`^squiz: allowed nothing in ${file.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}: it could not be read: [^\\n]+\\n$`, "u"));
  assert.ok(lstatSync(file).isDirectory());
});

test("a settings file that is a symlink stays one, and its target takes the rules (#707)", () => {
  const { home: root, file } = home();
  const dotfiles = join(root, "dotfiles");
  mkdirSync(dotfiles);
  const target = join(dotfiles, "claude-settings.json");
  writeFileSync(target, '{"model":"opus"}', "utf8");
  symlinkSync(target, file);

  allowSquizCommands({ HOME: root });

  assert.ok(lstatSync(file).isSymbolicLink(), "the link was replaced by a file");
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), {
    model: "opus",
    permissions: { allow: ["Bash(squiz review *)", "Bash(squiz threads)", "Bash(squiz reply *)"] },
  });
});

test("with HOME and CLAUDE_CONFIG_DIR unset, squiz init allows nothing and says why (#707)", () => {
  assert.deepEqual(allowSquizCommands({}), {
    stdout: "",
    stderr: "squiz: allowed nothing: neither CLAUDE_CONFIG_DIR nor HOME is set, so Claude Code's configuration cannot be found\n",
  });
});

test("with CLAUDE_CONFIG_DIR set, the rules go in its settings.json and ~/.claude is left alone (#707)", () => {
  const { home: root, file: underHome } = home();
  const config = directory("config");
  const file = join(config, "settings.json");

  const printed = allowSquizCommands({ HOME: root, CLAUDE_CONFIG_DIR: config });

  assert.deepEqual(printed, { stdout: `squiz: allowed ${ALL} in ${file}\n`, stderr: "" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    permissions: { allow: ["Bash(squiz review *)", "Bash(squiz threads)", "Bash(squiz reply *)"] },
  });
  assert.equal(existsSync(underHome), false, "~/.claude/settings.json was written though CLAUDE_CONFIG_DIR is set");
});

test("a CLAUDE_CONFIG_DIR that does not exist is not created, and ~/.claude is not used instead (#707)", () => {
  const { home: root, file: underHome } = home();
  const config = directory("config", false);

  const printed = allowSquizCommands({ HOME: root, CLAUDE_CONFIG_DIR: config });

  assert.deepEqual(printed, {
    stdout: `squiz: allowed nothing: Claude Code's configuration was not found at ${config}\n`,
    stderr: "",
  });
  assert.equal(existsSync(config), false, "CLAUDE_CONFIG_DIR was created");
  assert.equal(existsSync(underHome), false, "~/.claude/settings.json was written instead");
});

test("with no ~/.claude and no CLAUDE_CONFIG_DIR, squiz init writes nothing and says so on stdout (#707)", () => {
  const root = directory("home");

  const printed = allowSquizCommands({ HOME: root });

  assert.deepEqual(printed, {
    stdout: `squiz: allowed nothing: Claude Code's configuration was not found at ${join(root, ".claude")}\n`,
    stderr: "",
  });
  assert.equal(existsSync(join(root, ".claude")), false, "~/.claude was created");
});

test("a CLAUDE_CONFIG_DIR that is not an absolute path is named, and nothing is written (#707)", () => {
  const { home: root, file: underHome } = home();

  const printed = allowSquizCommands({ HOME: root, CLAUDE_CONFIG_DIR: "claude-config" });

  assert.deepEqual(printed, {
    stdout: "",
    stderr: 'squiz: allowed nothing: CLAUDE_CONFIG_DIR is "claude-config", which is not an absolute path\n',
  });
  assert.equal(existsSync(underHome), false);
});
