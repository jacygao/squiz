import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const skill = read("../skills/squiz-review/SKILL.md");

/**
 * The skill's text as the spec gives it, read from the spec so the two cannot
 * drift. It is the one fenced `markdown` block whose frontmatter names the skill.
 */
function specText(): string {
  const spec = read("../docs/specs/review-harness-spec.md");
  const blocks = [...spec.matchAll(/^```markdown\n([\s\S]*?)^```$/gm)]
    .map((match) => match[1] ?? "")
    .filter((block) => block.startsWith("---\nname: squiz-review\n"));
  assert.equal(blocks.length, 1, "the spec gives the skill's text in exactly one block");
  return blocks[0] ?? "";
}

function frontmatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, "a skill opens with YAML frontmatter, or Claude Code does not load it");
  return Object.fromEntries(
    (match[1] ?? "").split("\n").map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    }),
  );
}

test("the plugin ships the squiz-review skill under its own name", () => {
  // Claude Code finds a plugin's skill at skills/<name>/SKILL.md, so the
  // directory and the frontmatter name are the same name.
  assert.equal(frontmatter(skill).name, "squiz-review");
});

test("the skill's description says when to load it", () => {
  assert.match(frontmatter(skill).description ?? "", /after opening a pull request and after every push/);
});

test("the skill's text is the spec's, character for character", () => {
  assert.equal(skill, specText());
});
