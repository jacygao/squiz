/**
 * Changes with the defects each is known to hold, for measuring what the
 * reviewer finds.
 *
 * Three are this repository's own pull requests, each with the description the
 * reviewer was handed at the time. The rest are a patch on a pinned commit of
 * another project whose test command works in a fresh checkout, each with a
 * description written as a coding agent would write it. A description is kept
 * beside this file, because a pull request's body is edited after its review and
 * the edit can carry the fix.
 *
 * Each planted defect is marked by what is expected to find it:
 *
 * - `test`: the project's own tests fail on it, and nothing in the diff or the
 *   description points at it;
 * - `reading`: the diff, the description and the files they name show it, and
 *   the tests pass;
 * - `history`: the commit that wrote the replaced code says why it was written
 *   that way, and nothing in the tree does.
 */

import { fileURLToPath } from "node:url";

import type { Source } from "./case-repository.ts";

/** A defect the change holds, with the line a finding about it belongs on. */
export type KnownDefect = {
  readonly file: string;
  readonly line: number;
  readonly defect: string;
  readonly expected: "test" | "reading" | "history";
};

export type Case = {
  /** The pull request number the reviewer is told it is reviewing. */
  readonly number: number;
  readonly headRef: string;
  readonly source: Source;
  /** The description, as a file beside this one. */
  readonly description: string;
  /** The project's own test command, which works in a fresh checkout and fails on each defect marked `test`. */
  readonly test: string;
  /** Why the case is in the set, and how its defects were chosen. */
  readonly chosen: string;
  /** Empty for a change with no defect, which measures false findings. */
  readonly known: readonly KnownDefect[];
};

/** Where this repository is, for the cases that are its own commits. */
const HERE = fileURLToPath(new URL("../..", import.meta.url));

const NOTE_261 = "docs/notes/an-empty-group-loses-its-number-inside-one-round.md";
const NOTE_286 = "docs/notes/a-subagent-cannot-write-inside-a-loaded-plugin.md";

const SQUIZ_TEST = "npm ci --no-audit --no-fund --silent && npm run typecheck";
const QS = { url: "https://github.com/ljharb/qs.git", commit: "07b1d4d82c8f9301c105ea4b94fa2302cfd6e8b4" };
const QS_TEST = "npm install --no-audit --no-fund --silent && npm run tests-only";
const SEMVER = { url: "https://github.com/npm/node-semver.git", commit: "6e05b7637396ac66522cff8731f07cfe0ef49a29" };
const SEMVER_TEST = "npm install --no-audit --no-fund --silent && npx tap";
const MARKED = { url: "https://github.com/markedjs/marked.git", commit: "7e8754d60b3c37be30aa17106ada623d1f0cf9db" };
const MARKED_TEST =
  "npm ci --no-audit --no-fund --silent && npm run build && npm run test:specs && npm run test:unit";

const PLANTED_FOR_TESTS =
  "A refactor whose description says behaviour is unchanged, planted with a defect that only an input the description does not mention reaches. The project's own suite fails on it, and the patch was kept only after that was seen.";

export const cases: Readonly<Record<string, Case>> = {
  "261": {
    number: 261,
    headRef: "notes/sleep-holds-group",
    source: { kind: "here", repository: HERE, base: "3ada723", head: "9276dea" },
    description: "261.md",
    test: SQUIZ_TEST,
    chosen: "A note of this repository's whose defects its own review found and accepted. No test reads a note.",
    known: [
      {
        file: NOTE_261,
        line: 120,
        defect: "The measured line says `sleep 900`, and the `ps` output quoted under it says `120`.",
        expected: "reading",
      },
      {
        file: NOTE_261,
        line: 33,
        defect:
          "A group with no holder is said to be refused, and `judge()` neither signals nor refuses an empty one.",
        expected: "reading",
      },
      {
        file: NOTE_261,
        line: 72,
        defect: "The age test is stated without the 2 seconds of clock slack `groups.ts` allows.",
        expected: "reading",
      },
      {
        file: NOTE_261,
        line: 23,
        defect:
          "A round without the holder is said to signal a user's process, and the code refuses that group.",
        expected: "reading",
      },
    ],
  },
  "286": {
    number: 286,
    headRef: "docs/plugin-outside-repo",
    source: { kind: "here", repository: HERE, base: "45dc53b", head: "78c86a7" },
    description: "286.md",
    test: SQUIZ_TEST,
    chosen: "A note and a skill of this repository's whose defects its own review found and accepted. No test reads either.",
    known: [
      {
        file: NOTE_286,
        line: 25,
        defect:
          "The note says to restart after every merge, and the skill's § 8 it settles restarts only for `hooks/hooks.json`.",
        expected: "reading",
      },
      {
        file: NOTE_286,
        line: 59,
        defect: "The table names the manifest `plugin.json`, and it is `.claude-plugin/plugin.json`.",
        expected: "reading",
      },
      {
        file: NOTE_286,
        line: 49,
        defect: "The note carries the measurement table, which `writing-notes` puts in the pull request.",
        expected: "reading",
      },
    ],
  },
  "20f8a1d": {
    number: 247,
    headRef: "reviewers/the-shell-records-its-group",
    source: { kind: "here", repository: HERE, base: "20f8a1d~1", head: "20f8a1d" },
    description: "20f8a1d.md",
    test: SQUIZ_TEST,
    chosen: "A one-line fix of this repository's with no defect known, which measures false findings on code.",
    known: [],
  },
  "marked-rtrim": {
    number: 9001,
    headRef: "refactor/rtrim-index",
    source: { kind: "upstream", ...MARKED, patch: "marked-rtrim.patch" },
    description: "marked-rtrim.md",
    test: MARKED_TEST,
    chosen: PLANTED_FOR_TESTS,
    known: [
      {
        file: "src/helpers.ts",
        line: 119,
        defect:
          "`last > 0` stops before the first character, so a string made wholly of `c` keeps one: an ATX heading of only closing `#`s (CommonMark example 79) renders a `#`.",
        expected: "test",
      },
    ],
  },
  "marked-escaped-pipe": {
    number: 9002,
    headRef: "perf/split-cells",
    source: { kind: "upstream", ...MARKED, patch: "marked-escaped-pipe.patch" },
    description: "marked-escaped-pipe.md",
    test: MARKED_TEST,
    chosen: PLANTED_FOR_TESTS,
    known: [
      {
        file: "src/helpers.ts",
        line: 65,
        defect:
          "Only the one character before a pipe is looked at, so a pipe after an escaped backslash (`\\\\|`) is taken as escaped and the cell is not split.",
        expected: "test",
      },
    ],
  },
  "marked-list-start": {
    number: 9003,
    headRef: "refactor/renderer-list",
    source: { kind: "upstream", ...MARKED, patch: "marked-list-start.patch" },
    description: "marked-list-start.md",
    test: MARKED_TEST,
    chosen: PLANTED_FOR_TESTS,
    known: [
      {
        file: "src/Renderer.ts",
        line: 69,
        defect:
          "`Number(start) > 1` drops the `start` attribute of a list that starts at 0 (CommonMark example 267), which `start !== 1` kept.",
        expected: "test",
      },
    ],
  },
  "marked-heading-ids": {
    number: 9004,
    headRef: "feat/heading-ids",
    source: { kind: "upstream", ...MARKED, patch: "marked-heading-ids.patch" },
    description: "marked-heading-ids.md",
    test: MARKED_TEST,
    chosen:
      "A small feature whose defects are in its own new lines, against what its own documentation says, and which its new tests do not exercise. The suite passes.",
    known: [
      {
        file: "src/Renderer.ts",
        line: 69,
        defect:
          "The id is the heading's raw text, unescaped, so a `\"` or `<` in a heading breaks out of the attribute.",
        expected: "reading",
      },
      {
        file: "src/MarkedOptions.ts",
        line: 65,
        defect:
          "The option is documented as giving unique ids, and two headings with the same text get the same id.",
        expected: "reading",
      },
    ],
  },
  "marked-blank-line": {
    number: 9013,
    headRef: "fix/blank-line-whitespace",
    source: { kind: "upstream", ...MARKED, patch: "marked-blank-line.patch" },
    description: "marked-blank-line.md",
    test: MARKED_TEST,
    chosen:
      "Added after the first runs showed reading finding every defect on a changed line. A one-line change whose defect is in what other code does with it: the suite fails, and nothing in the diff shows why.",
    known: [
      {
        file: "src/rules.ts",
        line: 57,
        defect:
          "A blank line may now hold whitespace the lexer does not consume as blank, and the lexer loops forever on such input (the `code_blank_line` ReDoS fixture: \"Infinite loop on byte: 9\").",
        expected: "test",
      },
    ],
  },
  "marked-list-digits": {
    number: 9014,
    headRef: "feat/ten-digit-list-markers",
    source: { kind: "upstream", ...MARKED, patch: "marked-list-digits.patch" },
    description: "marked-list-digits.md",
    test: MARKED_TEST,
    chosen:
      "Added after the first runs showed reading finding every defect on a changed line. A deliberate change whose defect is against a specification outside the repository's code, which the project's spec suite enforces.",
    known: [
      {
        file: "src/rules.ts",
        line: 117,
        defect:
          "CommonMark limits an ordered list marker to nine digits, so `1234567890.` must stay a paragraph (example 266), and the suite says so.",
        expected: "test",
      },
    ],
  },
  "qs-comma-empty": {
    number: 9005,
    headRef: "refactor/comma-join",
    source: { kind: "upstream", ...QS, patch: "qs-comma-empty.patch" },
    description: "qs-comma-empty.md",
    test: QS_TEST,
    chosen: PLANTED_FOR_TESTS,
    known: [
      {
        file: "lib/stringify.js",
        line: 157,
        defect:
          "An empty array in the `comma` format now joins to `''` and is sent as `null`, so `{ a: [] }` stringifies to `a=` where it gave nothing.",
        expected: "test",
      },
    ],
  },
  "qs-comma-limit": {
    number: 9006,
    headRef: "perf/comma-limit",
    source: { kind: "upstream", ...QS, patch: "qs-comma-limit.patch" },
    description: "qs-comma-limit.md",
    test: QS_TEST,
    chosen: `${PLANTED_FOR_TESTS} Its \`history\` defect was not planted: the first run granted the history tools found it through \`git_log_search\`, and it was added then.`,
    known: [
      {
        file: "lib/parse.js",
        line: 42,
        defect:
          "`elements.length >= options.arrayLimit` throws on a value with exactly `arrayLimit` elements, which the comma count allowed.",
        expected: "test",
      },
      {
        file: "lib/parse.js",
        line: 41,
        defect:
          "The value is split before the limit is checked, so an oversized value is allocated whole: the memory exhaustion that counting commas first was written to prevent (upstream 52afe00).",
        expected: "history",
      },
    ],
  },
  "qs-encode-chunk": {
    number: 9007,
    headRef: "refactor/encode-segments",
    source: { kind: "upstream", ...QS, patch: "qs-encode-chunk.patch" },
    description: "qs-encode-chunk.md",
    test: QS_TEST,
    chosen: PLANTED_FOR_TESTS,
    known: [
      {
        file: "lib/utils.js",
        line: 306,
        defect:
          "The surrogate check reads `string.charCodeAt(end)`, the first character of the next segment, rather than `end - 1`, so a pair straddling a 1024-character boundary is split and mis-encoded.",
        expected: "test",
      },
    ],
  },
  "qs-key-length": {
    number: 9008,
    headRef: "feat/max-key-length",
    source: { kind: "upstream", ...QS, patch: "qs-key-length.patch" },
    description: "qs-key-length.md",
    test: QS_TEST,
    chosen:
      "A small feature whose defects are in its own new lines, against what its description and README say, and which its new tests do not exercise. The suite passes.",
    known: [
      {
        file: "lib/parse.js",
        line: 390,
        defect:
          "`maxKeyLength: opts.maxKeyLength` takes no default, so the 1000-character limit applies only when no options are passed at all.",
        expected: "reading",
      },
      {
        file: "README.md",
        line: 140,
        defect: "The README says the length is measured before percent-decoding, and the code measures the decoded key.",
        expected: "reading",
      },
    ],
  },
  "qs-limit-error": {
    number: 9009,
    headRef: "refactor/array-limit-error",
    source: { kind: "upstream", ...QS, patch: "qs-limit-error.patch" },
    description: "qs-limit-error.md",
    test: QS_TEST,
    chosen: "A refactor with no defect, which measures false findings. The suite passes.",
    known: [],
  },
  "semver-inc": {
    number: 9010,
    headRef: "refactor/inc-find-last",
    source: { kind: "upstream", ...SEMVER, patch: "semver-inc.patch" },
    description: "semver-inc.md",
    test: SEMVER_TEST,
    chosen: `${PLANTED_FOR_TESTS} It also holds a defect for reading, which the suite cannot see because it runs on a Node that has the method.`,
    known: [
      {
        file: "classes/semver.js",
        line: 308,
        defect:
          "`last > 0` misses a numeric identifier at index 0, so `1.2.3-0` bumps to `1.2.3-0.0` instead of `1.2.3-1`.",
        expected: "test",
      },
      {
        file: "classes/semver.js",
        line: 307,
        defect: "`Array.prototype.findLastIndex` is not in Node 10 to 16, and `package.json` declares `node >=10`.",
        expected: "reading",
      },
    ],
  },
  "semver-min-version": {
    number: 9011,
    headRef: "refactor/min-version-inc",
    source: { kind: "upstream", ...SEMVER, patch: "semver-min-version.patch" },
    description: "semver-min-version.md",
    test: SEMVER_TEST,
    chosen: PLANTED_FOR_TESTS,
    known: [
      {
        file: "ranges/min-version.js",
        line: 31,
        defect:
          "`inc('patch')` on a prerelease drops the prerelease rather than appending `0`, so `minVersion('>1.2.3-alpha')` is `1.2.3` instead of `1.2.3-alpha.0`.",
        expected: "test",
      },
    ],
  },
  "semver-compare-pre": {
    number: 9012,
    headRef: "refactor/compare-pre-loop",
    source: { kind: "upstream", ...SEMVER, patch: "semver-compare-pre.patch" },
    description: "semver-compare-pre.md",
    test: SEMVER_TEST,
    chosen: "A refactor with no defect, which measures false findings. The suite passes.",
    known: [],
  },
};
