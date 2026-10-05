import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { REVIEW_SECTION, squizInit } from "./init.ts";

const scratch = mkdtempSync(join(tmpdir(), "squiz-init-"));
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

function agentsIn(root: string): string {
  return readFileSync(join(root, "AGENTS.md"), "utf8");
}

const ADDED = "squiz: added the review section to AGENTS.md\n";
const ALREADY = "squiz: AGENTS.md already has the review section; nothing changed\n";

test("the section is the one the spec gives, so neither changes without the other", () => {
  const spec = readFileSync(fileURLToPath(new URL("../../docs/specs/review-harness-spec.md", import.meta.url)), "utf8");
  const introduced = spec.indexOf("`squiz init` adds:");
  assert.notEqual(introduced, -1, "the spec no longer introduces the section the way this test looks for it");
  const opened = spec.indexOf("```markdown\n", introduced) + "```markdown\n".length;
  const closed = spec.indexOf("\n```\n", opened) + 1;

  assert.equal(REVIEW_SECTION, spec.slice(opened, closed));
});

test("a repository with no AGENTS.md gets one holding the section alone", () => {
  const root = repository();

  const printed = squizInit(root);

  assert.deepEqual(printed, { stdout: ADDED, stderr: "", exit: 0 });
  assert.equal(agentsIn(root), REVIEW_SECTION);
});

test("an existing AGENTS.md keeps everything it had, with one blank line before the section", () => {
  const before = "# Conventions\n\n- Tabs, not spaces.\n";
  const root = repository(before);

  const printed = squizInit(root);

  assert.deepEqual(printed, { stdout: ADDED, stderr: "", exit: 0 });
  assert.equal(agentsIn(root), `${before}\n${REVIEW_SECTION}`);
});

test("an AGENTS.md with no trailing newline is ended before the blank line", () => {
  const before = "# Conventions\n\n- Tabs, not spaces.";
  const root = repository(before);

  squizInit(root);

  assert.equal(agentsIn(root), `${before}\n\n${REVIEW_SECTION}`);
});

test("an AGENTS.md already ending on a blank line gets no second one", () => {
  const before = "# Conventions\n\n";
  const root = repository(before);

  squizInit(root);

  assert.equal(agentsIn(root), `${before}${REVIEW_SECTION}`);
});

test("a second run finds the section and changes nothing", () => {
  const root = repository("# Conventions\n");
  squizInit(root);
  const once = agentsIn(root);

  const printed = squizInit(root);

  assert.deepEqual(printed, { stdout: ALREADY, stderr: "", exit: 0 });
  assert.equal(agentsIn(root), once);
});

test("the section is found where the file goes on past it", () => {
  const before = `# Conventions\n\n${REVIEW_SECTION}\n## Later\n\nMore.\n`;
  const root = repository(before);

  const printed = squizInit(root);

  assert.deepEqual(printed, { stdout: ALREADY, stderr: "", exit: 0 });
  assert.equal(agentsIn(root), before);
});

test("the section is found where it ends the file with no newline after it", () => {
  const before = `# Conventions\n\n${REVIEW_SECTION.slice(0, -1)}`;
  const root = repository(before);

  const printed = squizInit(root);

  assert.deepEqual(printed, { stdout: ALREADY, stderr: "", exit: 0 });
  assert.equal(agentsIn(root), before);
});

test("a file that mentions squiz review, under a Review heading of its own, still gets the section", () => {
  const before = "# Conventions\n\n## Review\n\nRun `squiz review <number>` when you feel like it.\n";
  const root = repository(before);

  const printed = squizInit(root);

  assert.deepEqual(printed, { stdout: ADDED, stderr: "", exit: 0 });
  assert.equal(agentsIn(root), `${before}\n${REVIEW_SECTION}`);
});

test("run from a subdirectory, it writes the AGENTS.md at the repository's root", () => {
  const root = repository();
  const nested = join(root, "src", "deep");
  mkdirSync(nested, { recursive: true });

  const printed = squizInit(nested);

  assert.equal(printed.exit, 0);
  assert.equal(agentsIn(root), REVIEW_SECTION);
  assert.equal(existsSync(join(nested, "AGENTS.md")), false);
});

test("outside a git repository it writes nothing and exits 1 with one line on stderr", () => {
  const outside = mkdtempSync(join(tmpdir(), "squiz-init-outside-"));
  try {
    const printed = squizInit(outside);

    assert.equal(printed.exit, 1);
    assert.equal(printed.stdout, "");
    assert.match(printed.stderr, /^squiz: nothing changed: [^\n]+\n$/u);
    assert.equal(existsSync(join(outside, "AGENTS.md")), false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
