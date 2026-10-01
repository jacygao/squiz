/**
 * The splitter, driven as a table: a line in, the commands and the words of
 * each out.
 *
 * The table covers the shapes rather than the lines a review happened to send.
 * A quoting rule read wrongly moves a word out of one command and into the
 * next, or drops it, and a caller is then matching against something the shell
 * would never have run.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { splitIntoCommands, type Word } from "./words.ts";

/** One line, and the commands it splits into. */
type Split = {
  readonly line: string;
  readonly commands: readonly (readonly Word[])[];
};

/** A word written as it arrives, which is the only kind a caller matches against. */
function plain(text: string): Word {
  return { text, plain: true };
}

/** A word the quoting or a backslash built, which the shell would read further. */
function built(text: string): Word {
  return { text, plain: false };
}

function splitsInto(rows: readonly Split[]): void {
  for (const row of rows) {
    assert.deepEqual(
      splitIntoCommands(row.line),
      row.commands,
      `${JSON.stringify(row.line)} split into ${JSON.stringify(splitIntoCommands(row.line))}`,
    );
  }
}

/** The shapes a line takes when no quote is holding anything together. */
const SPLITS: readonly Split[] = [
  { line: "", commands: [] },
  { line: "    ", commands: [] },
  { line: ";;", commands: [] },
  { line: "git commit", commands: [[plain("git"), plain("commit")]] },
  {
    line: "git   commit  -m  x",
    commands: [[plain("git"), plain("commit"), plain("-m"), plain("x")]],
  },
  {
    line: "git add --all; git commit",
    commands: [
      [plain("git"), plain("add"), plain("--all")],
      [plain("git"), plain("commit")],
    ],
  },
  {
    line: "cd /tmp && git push origin HEAD",
    commands: [
      [plain("cd"), plain("/tmp")],
      [plain("git"), plain("push"), plain("origin"), plain("HEAD")],
    ],
  },
  {
    line: "git status | head -5",
    commands: [
      [plain("git"), plain("status")],
      [plain("head"), plain("-5")],
    ],
  },
  {
    line: "cd /tmp\ngit commit -m x",
    commands: [
      [plain("cd"), plain("/tmp")],
      [plain("git"), plain("commit"), plain("-m"), plain("x")],
    ],
  },
  // A substitution is not read. Its parentheses end a command like any others.
  {
    line: "echo $(git commit)",
    commands: [
      [plain("echo"), plain("$")],
      [plain("git"), plain("commit")],
    ],
  },
  { line: 'a"b"c', commands: [[built("abc")]] },
  { line: "a'b'\"c\"d", commands: [[built("abcd")]] },
  // A backslash outside quotes escapes the separator, and the two stay one word.
  { line: "echo a\\; b", commands: [[plain("echo"), built("a;"), plain("b")]] },
  { line: "echo a\\ b", commands: [[plain("echo"), built("a b")]] },
  // A backslash before a newline joins the two lines and leaves no word behind.
  { line: "echo a\\\nb", commands: [[plain("echo"), plain("ab")]] },
  // Inside single quotes a backslash is a backslash.
  { line: "echo 'a\\nb'", commands: [[plain("echo"), built("a\\nb")]] },
  { line: "echo 'a\\'", commands: [[plain("echo"), built("a\\")]] },
  { line: "echo \"it's\"", commands: [[plain("echo"), built("it's")]] },
  { line: "echo 'say \"hi\"'", commands: [[plain("echo"), built('say "hi"')]] },
  // A quote left open runs to the end of the line, which is a line no shell would run.
  { line: 'echo "a; git commit', commands: [[plain("echo"), built("a; git commit")]] },
  { line: "echo 'a; git commit", commands: [[plain("echo"), built("a; git commit")]] },
  {
    line: "git checkout -Breview-copy HEAD~1",
    commands: [[plain("git"), plain("checkout"), plain("-Breview-copy"), plain("HEAD~1")]],
  },
];

/** A quoted empty string is an argument, and a shell passes it as one. */
const EMPTY_QUOTED: readonly Split[] = [
  { line: 'echo ""', commands: [[plain("echo"), built("")]] },
  { line: "echo ''", commands: [[plain("echo"), built("")]] },
  { line: '""', commands: [[built("")]] },
  {
    line: 'git -C "" commit --allow-empty -m x',
    commands: [
      [
        plain("git"),
        plain("-C"),
        built(""),
        plain("commit"),
        plain("--allow-empty"),
        plain("-m"),
        plain("x"),
      ],
    ],
  },
  // Written onto the option it is one word, and the option takes the commit as its value.
  {
    line: 'git -C"" commit --allow-empty',
    commands: [[plain("git"), built("-C"), plain("commit"), plain("--allow-empty")]],
  },
];

/** Inside double quotes a backslash escapes four characters and stands for itself before the rest. */
const BACKSLASH_IN_DOUBLE_QUOTES: readonly Split[] = [
  { line: 'echo "a\\"b"', commands: [[plain("echo"), built('a"b')]] },
  { line: 'echo "a\\\\b"', commands: [[plain("echo"), built("a\\b")]] },
  { line: 'echo "a\\$b"', commands: [[plain("echo"), built("a$b")]] },
  { line: 'echo "a\\`b"', commands: [[plain("echo"), built("a`b")]] },
  { line: 'echo "a\\nb"', commands: [[plain("echo"), built("a\\nb")]] },
  { line: 'echo "a\\\nb"', commands: [[plain("echo"), built("ab")]] },
  { line: 'echo "a\\', commands: [[plain("echo"), built("a\\")]] },
  // The escaped quotes close nothing, so the commit stays inside the pattern.
  {
    line: 'grep -F "a \\"; git commit; \\" b" tracked.txt',
    commands: [[plain("grep"), plain("-F"), built('a "; git commit; " b'), plain("tracked.txt")]],
  },
  // The argument ends where it is written to, and the commit after it is a command of its own.
  {
    line: "printf '%s\\n' \"a \\\" b\"; git commit --allow-empty -m x",
    commands: [
      [plain("printf"), built("%s\\n"), built('a " b')],
      [plain("git"), plain("commit"), plain("--allow-empty"), plain("-m"), plain("x")],
    ],
  },
];

/** A separator inside quotes is a character of the argument. */
const SEPARATORS_INSIDE_QUOTES: readonly Split[] = [
  { line: 'echo "a; b"', commands: [[plain("echo"), built("a; b")]] },
  { line: "echo 'a; b'", commands: [[plain("echo"), built("a; b")]] },
  { line: 'echo "a | b"', commands: [[plain("echo"), built("a | b")]] },
  { line: "echo 'a & b'", commands: [[plain("echo"), built("a & b")]] },
  { line: 'echo "a(b)c"', commands: [[plain("echo"), built("a(b)c")]] },
  { line: 'echo "a\nb"', commands: [[plain("echo"), built("a\nb")]] },
  {
    line: "grep -rn 'git commit; git push' src",
    commands: [[plain("grep"), plain("-rn"), built("git commit; git push"), plain("src")]],
  },
];

/**
 * A `#` where a word starts is a comment, and a `#` anywhere else is a character
 * of the word.
 *
 * What a comment holds decides nothing, so the quote and the separator rules
 * above stop at it. Read as text instead, an apostrophe in a comment swallows
 * the command on the next line and a `;` in one invents a command the shell
 * never runs.
 */
const COMMENTS: readonly Split[] = [
  {
    line: "# Record the reviewer's result\ngit commit --allow-empty -m review",
    commands: [
      [plain("git"), plain("commit"), plain("--allow-empty"), plain("-m"), plain("review")],
    ],
  },
  {
    line: '# say "no" to it\ngit commit -m x',
    commands: [[plain("git"), plain("commit"), plain("-m"), plain("x")]],
  },
  {
    line: "git status # then: git commit; git push | wc -l",
    commands: [[plain("git"), plain("status")]],
  },
  {
    line: "git add --all; # git commit\ngit status",
    commands: [
      [plain("git"), plain("add"), plain("--all")],
      [plain("git"), plain("status")],
    ],
  },
  { line: "# nothing here", commands: [] },
  {
    line: "echo '# not a comment' && git commit",
    commands: [
      [plain("echo"), built("# not a comment")],
      [plain("git"), plain("commit")],
    ],
  },
  { line: 'echo "#1"', commands: [[plain("echo"), built("#1")]] },
  { line: "echo \\#1", commands: [[plain("echo"), built("#1")]] },
  { line: "git log --grep=x#y", commands: [[plain("git"), plain("log"), plain("--grep=x#y")]] },
  { line: "curl host/path#frag", commands: [[plain("curl"), plain("host/path#frag")]] },
  // The quotes open the word, so the `#` after them opens a comment of its own.
  { line: 'echo "" #c', commands: [[plain("echo"), built("")]] },
];

test("a command line splits into the commands it runs and the words of each", () => {
  splitsInto(SPLITS);
});

test("a quoted empty string is a word", () => {
  splitsInto(EMPTY_QUOTED);
});

test("a backslash inside double quotes escapes the quote and leaves the argument whole", () => {
  splitsInto(BACKSLASH_IN_DOUBLE_QUOTES);
});

test("a separator inside quotes does not end the command", () => {
  splitsInto(SEPARATORS_INSIDE_QUOTES);
});

test("a comment runs to the newline, and a # written elsewhere is a character of a word", () => {
  splitsInto(COMMENTS);
});

/**
 * Nothing is expanded, so a word the shell would build out of a substitution or
 * a variable comes back as the characters it was written with.
 */
test("a word is the characters it was written with, and nothing is expanded", () => {
  assert.deepEqual(splitIntoCommands("git $HOME"), [[plain("git"), plain("$HOME")]]);
  assert.deepEqual(splitIntoCommands("git *.ts"), [[plain("git"), plain("*.ts")]]);
  assert.deepEqual(splitIntoCommands('git "com"mit'), [[plain("git"), built("commit")]]);
});
