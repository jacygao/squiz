import assert from "node:assert/strict";
import { test } from "node:test";

import { type ChangedLines, DiffParseError, parseDiff, touchesLine } from "./diff.ts";

/**
 * Every fixture below is `git diff` output, copied from a scratch repository
 * rather than written by hand, so that the shapes are the ones git really
 * emits. Each begins on the line after its backtick, which `parse` drops.
 */
function parse(fixture: string): ChangedLines {
  return parseDiff(fixture.slice(1));
}

function touches(fixture: string, file: string, line: number): boolean {
  return touchesLine(parse(fixture), file, line);
}

function refusal(fixture: string, what: string): DiffParseError {
  try {
    parse(fixture);
  } catch (error) {
    assert.ok(
      error instanceof DiffParseError,
      `${what} must be refused with a DiffParseError, and threw ${String(error)}`,
    );
    return error;
  }
  assert.fail(`${what} must be refused, and was read without complaint`);
}

/**
 * Two hunks in one file, where the first adds three lines.
 *
 * The second hunk's new side therefore starts at 300 while its old side starts
 * at 297, and the line it changes is line 303 of the new file. A parser that
 * counted from 1, or that read only the first of the two ranges, would answer
 * about the wrong line and look right doing it.
 */
const driftingHunks = `
diff --git a/drift.txt b/drift.txt
index 374e009..fb292e8 100644
--- a/drift.txt
+++ b/drift.txt
@@ -7,6 +7,9 @@ line 6
 line 7
 line 8
 line 9
+inserted A
+inserted B
+inserted C
 line 10
 line 11
 line 12
@@ -297,7 +300,7 @@ line 296
 line 297
 line 298
 line 299
-line 300
+line 300 CHANGED
 line 301
 line 302
 line 303
`;

/**
 * One line removed and a later one changed, in a single hunk.
 *
 * The removal makes the new file shorter than the old, so the changed line is
 * line 11 of the new file though it was line 12 of the old. A parser that let a
 * removed line advance the new side would answer 12.
 */
const pureDeletion = `
diff --git a/shrink.txt b/shrink.txt
index 624b469..3d2d767 100644
--- a/shrink.txt
+++ b/shrink.txt
@@ -3,10 +3,9 @@ line 2
 line 3
 line 4
 line 5
-line 6
 line 7
 line 8
 line 9
 line 10
 line 11
-line 12
+line 12 CHANGED
`;

const newFile = `
diff --git a/added.txt b/added.txt
new file mode 100644
index 0000000..c9267f1
--- /dev/null
+++ b/added.txt
@@ -0,0 +1,2 @@
+brand new
+second
`;

const deletedFile = `
diff --git a/doomed.txt b/doomed.txt
deleted file mode 100644
index 814f4a4..0000000
--- a/doomed.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
`;

// A rename that changed nothing carries no hunk at all.
const pureRename = `
diff --git a/renamed-from.txt b/renamed-to.txt
similarity index 100%
rename from renamed-from.txt
rename to renamed-to.txt
`;

const renameWithEdits = `
diff --git a/old-name.txt b/new-name.txt
similarity index 75%
rename from old-name.txt
rename to new-name.txt
index b2f931a..b80f223 100644
--- a/old-name.txt
+++ b/new-name.txt
@@ -1,5 +1,5 @@
 one
 two
-three
+THREE
 four
 five
`;

// A hunk of one line on each side writes no count: "@@ -1 +1 @@". The two
// "\\ No newline" markers annotate the lines above them and are lines of
// neither side.
const noNewlineAtEof = `
diff --git a/eof.txt b/eof.txt
index 69db55d..acc92b8 100644
--- a/eof.txt
+++ b/eof.txt
@@ -1 +1 @@
-no trailing newline
\\ No newline at end of file
+no trailing newline CHANGED
\\ No newline at end of file
`;

// Git appends a tab to a name holding a space, so the header reads
// "+++ b/with space.txt\\t". Splitting the header on whitespace loses the rest
// of the name; keeping the whole of it keeps the tab.
const pathWithASpace = `
diff --git a/with space.txt b/with space.txt
index 85c3040..4620eb5 100644
--- a/with space.txt\t
+++ b/with space.txt\t
@@ -1,3 +1,3 @@
 alpha
-beta
+beta CHANGED
 gamma
`;

// Git writes a name holding a byte above ASCII in C quoting, one octal escape
// per byte: "café.txt" arrives as caf\\303\\251.txt.
const quotedPath = `
diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"
index b77b4eb..609a0b8 100644
--- "a/caf\\303\\251.txt"
+++ "b/caf\\303\\251.txt"
@@ -1,2 +1,2 @@
-x
+x CHANGED
 y
`;

// A name holding a tab is quoted too, and the tab becomes the escape "\\t".
// Nothing in the header is then a tab, so the separator git appends to a name
// holding a space cannot be confused with a tab inside the name.
const quotedPathHoldingATab = `
diff --git "a/tab\\there.txt" "b/tab\\there.txt"
index 422c2b7..55dce13 100644
--- "a/tab\\there.txt"
+++ "b/tab\\there.txt"
@@ -1,2 +1,2 @@
 a
-b
+B
`;

/**
 * A merge's combined diff, from `git show` of a merge commit.
 *
 * It carries one marker column per parent rather than one in all. "++MERGED"
 * is a line added against both parents, not an added line whose text begins
 * with a plus, and every count this parser keeps would be a column out.
 */
const combinedDiff = `
diff --cc f.txt
index af70335,f794161..121cba9
--- a/f.txt
+++ b/f.txt
@@@ -1,3 -1,3 +1,3 @@@
  a
- MAIN
 -SIDE
++MERGED
  c
`;

test("an added line is one the change touched", () => {
  assert.equal(touches(driftingHunks, "drift.txt", 10), true);
  assert.equal(touches(driftingHunks, "drift.txt", 11), true);
  assert.equal(touches(driftingHunks, "drift.txt", 12), true);
});

test("a context line is not one the change touched", () => {
  assert.equal(touches(driftingHunks, "drift.txt", 9), false);
  assert.equal(touches(driftingHunks, "drift.txt", 13), false);
});

test("a hunk whose new side starts at 300 answers about the new file's line 303", () => {
  assert.equal(
    touches(driftingHunks, "drift.txt", 303),
    true,
    "the second hunk's added line is line 303 of the new file, not line 300",
  );
  assert.equal(
    touches(driftingHunks, "drift.txt", 300),
    false,
    "line 300 of the new file is a context line; only the old side numbers it 297",
  );
  assert.equal(
    touches(driftingHunks, "drift.txt", 4),
    false,
    "a parser counting hunk bodies from line 1 would answer here",
  );
});

test("a removed line does not advance the new side, and cannot be anchored to", () => {
  assert.deepEqual(
    [...(parse(pureDeletion).get("shrink.txt") ?? [])],
    [11],
    "the changed line is line 11 of the new file, because a line above it was removed",
  );
  assert.equal(touches(pureDeletion, "shrink.txt", 12), false);
});

test("every line of a new file is one the change touched", () => {
  assert.equal(touches(newFile, "added.txt", 1), true);
  assert.equal(touches(newFile, "added.txt", 2), true);
  assert.equal(touches(newFile, "added.txt", 3), false);
});

test("a deleted file has no line to anchor to, and is not a parse failure", () => {
  const changed = parse(deletedFile);
  assert.equal(changed.size, 0, "a file with no new side must not be recorded at all");
  assert.equal(touchesLine(changed, "doomed.txt", 1), false);
});

test("a rename that changed nothing has no line to anchor to", () => {
  assert.equal(parse(pureRename).size, 0);
  assert.equal(touches(pureRename, "renamed-to.txt", 1), false);
});

test("a rename that changed something is keyed by the name the file now has", () => {
  assert.equal(touches(renameWithEdits, "new-name.txt", 3), true);
  assert.equal(
    touches(renameWithEdits, "old-name.txt", 3),
    false,
    "an anchor names the file as it now stands",
  );
});

test("the no-newline marker is a line of neither side", () => {
  assert.deepEqual([...(parse(noNewlineAtEof).get("eof.txt") ?? [])], [1]);
});

test("a path holding a space keeps the space and drops the tab git added", () => {
  assert.equal(touches(pathWithASpace, "with space.txt", 2), true);
  assert.deepEqual(
    [...parse(pathWithASpace).keys()],
    ["with space.txt"],
    "the tab git appends to the name must not become part of it",
  );
});

test("a path git quoted is read back as the name it stands for", () => {
  assert.deepEqual([...parse(quotedPath).keys()], ["café.txt"]);
  assert.equal(touches(quotedPath, "café.txt", 1), true);
  assert.deepEqual([...parse(quotedPathHoldingATab).keys()], ["tab\there.txt"]);
});

test("a file the diff does not mention answers no rather than throwing", () => {
  assert.equal(touches(driftingHunks, "untouched.ts", 10), false);
});

test("a line number no file could have answers no", () => {
  assert.equal(touches(driftingHunks, "drift.txt", 0), false);
  assert.equal(touches(driftingHunks, "drift.txt", -1), false);
  assert.equal(touches(driftingHunks, "drift.txt", 10.5), false);
});

test("a diff with no changes is empty rather than unreadable", () => {
  assert.equal(parseDiff("").size, 0);
  assert.equal(touchesLine(parseDiff(""), "anything.ts", 1), false);
});

// A parse failure and a line the diff does not contain are the two facts the
// caller must be able to tell apart.
test("a diff that cannot be read is refused rather than answered no", () => {
  assert.equal(
    touches(driftingHunks, "drift.txt", 9),
    false,
    "a readable diff answers no for a line it does not contain",
  );
  const refused = refusal(combinedDiff, "a merge's combined diff");
  assert.match(
    refused.message,
    /combined diff/,
    "the refusal must name what it could not read, so that a person can act on it",
  );
});

test("text that is not a diff at all is refused", () => {
  refusal("\nthe reviewer wrote prose where a diff was expected\n", "text naming no file");
});

test("a diff cut off inside a hunk is refused", () => {
  // What a diff truncated in transit looks like: the header declares nine new
  // lines and the body stops after seven.
  const cutOff = driftingHunks.split("\n").slice(0, 13).join("\n");
  refusal(cutOff, "a diff that ends inside a hunk");
});

test("a hunk body line with no marker is refused", () => {
  refusal(
    `
--- a/x.txt
+++ b/x.txt
@@ -1,2 +1,2 @@
 one

`,
    "an empty line inside a hunk, which git writes as a single space",
  );
});

test("a hunk that overruns the counts its header declares is refused", () => {
  const refused = refusal(
    `
--- a/x.txt
+++ b/x.txt
@@ -1,2 +1,1 @@
 one
 two
`,
    "a hunk delivering two context lines where its new side declares one",
  );
  assert.match(
    refused.message,
    /more lines than its header declares/,
    "the overrun must be named where it happens, not left to surface as a hunk that never ends",
  );
});

test("a hunk header that cannot be read is refused", () => {
  refusal(
    `
--- a/x.txt
+++ b/x.txt
@@ nonsense @@
 one
`,
    "a hunk header with no line numbers",
  );
});

test("a hunk arriving before any file is refused", () => {
  refusal(
    `
@@ -1,1 +1,1 @@
 one
`,
    "a hunk with no file header above it",
  );

  // The rest of the diff names a file, so nothing else here would notice that
  // this hunk belongs to none. Its lines would be attributed to no file and
  // silently answer no.
  const stray = refusal(
    `
diff --git a/x.txt b/x.txt
@@ -1,1 +1,1 @@
 one
`,
    "a hunk under a file entry that has lost its +++ header",
  );
  assert.match(stray.message, /before any file/);
});
