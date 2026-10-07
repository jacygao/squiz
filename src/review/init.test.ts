import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { squizInit } from "./init.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "squiz-600-init-")));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let made = 0;

/** A fresh repository, with `AGENTS.md` holding `agents` where it is given. */
function repository(agents?: string): string {
  made += 1;
  const root = join(scratch, `repo-${made}`);
  mkdirSync(root, { recursive: true });
  const result = spawnSync("git", ["init", "--quiet", "--initial-branch", "main"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  if (agents !== undefined) writeFileSync(join(root, "AGENTS.md"), agents, "utf8");
  return realpathSync(root);
}

/** A home whose ~/.local/bin is on PATH, and a squiz to link, both under the scratch space. */
function linkable(): { environment: { PATH: string; HOME: string }; target: string; localBin: string } {
  made += 1;
  const home = join(scratch, `home-${made}`);
  const localBin = join(home, ".local", "bin");
  mkdirSync(localBin, { recursive: true });
  const plugin = join(scratch, `plugin-${made}`);
  mkdirSync(join(plugin, "bin"), { recursive: true });
  const target = join(plugin, "bin", "squiz");
  writeFileSync(target, "#!/bin/sh\n", { mode: 0o755 });
  return { environment: { PATH: localBin, HOME: home }, target, localBin };
}

/** The opening of the section an earlier `squiz init` appended, which a project may have cut down since. */
const EARLIER_SECTION = `## Review

After you open a pull request, and after every push to it, run
\`squiz review <number>\` from the worktree its branch is checked out in.
`;

test("squiz init links squiz and writes no AGENTS.md (#600)", () => {
  const root = repository();
  const { environment, target, localBin } = linkable();

  const printed = squizInit(root, environment, target);

  assert.deepEqual(printed, { stdout: `squiz: linked ${join(localBin, "squiz")} to ${target}\n`, stderr: "", exit: 0 });
  assert.equal(existsSync(join(root, "AGENTS.md")), false);
});

test("an AGENTS.md section an earlier squiz init wrote is left byte for byte (#600)", () => {
  const before = `# Conventions\n\n- Tabs, not spaces.\n\n${EARLIER_SECTION}`;
  const root = repository(before);
  const { environment, target } = linkable();

  squizInit(root, environment, target);

  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), before);
});

test("outside a git repository squiz init still links squiz", () => {
  const outside = mkdtempSync(join(tmpdir(), "squiz-600-outside-"));
  const { environment, target, localBin } = linkable();
  try {
    const printed = squizInit(outside, environment, target);

    assert.deepEqual(printed, { stdout: `squiz: linked ${join(localBin, "squiz")} to ${target}\n`, stderr: "", exit: 0 });
    assert.equal(existsSync(join(outside, "AGENTS.md")), false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a link squiz init cannot make exits 1 with one line on stderr", () => {
  const root = repository();
  const { target } = linkable();

  const printed = squizInit(root, { PATH: "", HOME: scratch }, target);

  assert.equal(printed.exit, 1);
  assert.equal(printed.stdout, "");
  assert.match(printed.stderr, /^squiz: made no link: [^\n]+\n$/u);
});
