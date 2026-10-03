/**
 * Real changes from this repository, each with the defects it is known to hold.
 *
 * A charter is measured by running the reviewer over each and counting which of
 * the known defects it reports. Each description is the one the reviewer was
 * handed at the time, kept beside this file because a pull request's body is
 * edited after its review and the edit can carry the fix.
 */

/** A defect found in review and accepted, with the line the finding belongs on. */
export type KnownDefect = {
  readonly file: string;
  readonly line: number;
  readonly defect: string;
};

export type Case = {
  readonly number: number;
  readonly base: string;
  readonly head: string;
  readonly headRef: string;
  /** The description, as a file beside this one. */
  readonly description: string;
  /** Empty for a change with no defect known, which measures what a clean change costs. */
  readonly known: readonly KnownDefect[];
};

const NOTE_261 = "docs/notes/an-empty-group-loses-its-number-inside-one-round.md";
const NOTE_286 = "docs/notes/a-subagent-cannot-write-inside-a-loaded-plugin.md";

export const cases: Readonly<Record<string, Case>> = {
  "261": {
    number: 261,
    base: "3ada723",
    head: "9276dea",
    headRef: "notes/sleep-holds-group",
    description: "261.md",
    known: [
      {
        file: NOTE_261,
        line: 120,
        defect: "The measured line says `sleep 900`, and the `ps` output quoted under it says `120`.",
      },
      {
        file: NOTE_261,
        line: 33,
        defect:
          "A group with no holder is said to be refused, and `judge()` neither signals nor refuses an empty one.",
      },
      {
        file: NOTE_261,
        line: 72,
        defect: "The age test is stated without the 2 seconds of clock slack `groups.ts` allows.",
      },
      {
        file: NOTE_261,
        line: 23,
        defect:
          "A round without the holder is said to signal a user's process, and the code refuses that group.",
      },
    ],
  },
  "286": {
    number: 286,
    base: "45dc53b",
    head: "78c86a7",
    headRef: "docs/plugin-outside-repo",
    description: "286.md",
    known: [
      {
        file: NOTE_286,
        line: 25,
        defect:
          "The note says to restart after every merge, and the skill's § 8 it settles restarts only for `hooks/hooks.json`.",
      },
      {
        file: NOTE_286,
        line: 59,
        defect: "The table names the manifest `plugin.json`, and it is `.claude-plugin/plugin.json`.",
      },
      {
        file: NOTE_286,
        line: 49,
        defect: "The note carries the measurement table, which `writing-notes` puts in the pull request.",
      },
    ],
  },
  "20f8a1d": {
    number: 247,
    base: "20f8a1d~1",
    head: "20f8a1d",
    headRef: "reviewers/the-shell-records-its-group",
    description: "20f8a1d.md",
    known: [],
  },
};
