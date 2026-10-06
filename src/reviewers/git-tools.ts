/**
 * The three history tools a reviewer at depth `deep` is granted, as any CLI's
 * server of them runs them: `git_log_search`, `git_blame` and `git_show`.
 *
 * Each runs its one git subcommand in the snapshot, by `execFile` with an
 * argument array, never through a shell. The repository under review is
 * hostile: its tracked files, and its local config once a test command has
 * run, are the code under review's to set. So:
 *
 * - no argument the reviewer sends can be read as an option or as anything
 *   but the one commit, term or file it is meant as;
 * - no setting git reads from the environment, the user's config or the
 *   repository's config can make git run a program, fetch, or read a file
 *   outside the repository into what it prints;
 * - output is capped, and a cut is said in what the reviewer reads.
 *
 * Nothing here throws. A refused argument and a git that failed come back as
 * that call's error text, for the reviewer to read and choose again.
 */

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** What a call answers with. `failed` marks `text` as the call's error rather than its result. */
export type HistoryResult = { readonly text: string; readonly failed: boolean };

/** One history tool. `parameters` is the JSON Schema the CLI validates against. */
export type HistoryTool = {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  /**
   * Run the tool in `snapshot`, the root of the round's snapshot, with the
   * reviewer's arguments as the CLI received them. `signal` stops git.
   */
  readonly run: (snapshot: string, params: unknown, signal?: AbortSignal) => Promise<HistoryResult>;
};

/** The most of git's output a call hands back, in bytes. */
export const OUTPUT_CAP = 65_536;

// Well inside the round's own time bound, so one slow search cannot spend it.
const TIME_LIMIT_MS = 120_000;

// Settings that would run a program, read with the highest precedence git has.
// A diff driver's textconv and command, and an external diff, are closed by
// the flags each subcommand passes instead, since their names are the
// repository's to choose.
const OVERRIDES: readonly string[] = [
  "core.fsmonitor=false",
  "core.attributesFile=/dev/null",
  "log.showSignature=false",
  "color.ui=false",
];

const GLOBAL_ARGUMENTS: readonly string[] = [
  "--no-pager",
  "--literal-pathspecs",
  ...OVERRIDES.flatMap((setting) => ["-c", setting]),
];

/**
 * The environment git runs with: the caller's, less every `GIT_` variable, so
 * none can name another repository, a pager, an external diff or a config of
 * its own.
 */
function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) environment[key] = value;
  }
  return {
    ...environment,
    // The system and user configs are not the repository's, but either can
    // name a program too, and the tools need nothing from them.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    // A partial clone fetches a missing object on demand, through whatever
    // transport the repository's config names.
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    // A read that refreshes the index would otherwise write it.
    GIT_OPTIONAL_LOCKS: "0",
  };
}

type Ran =
  | { readonly ran: true; readonly stdout: string; readonly cut: boolean }
  | {
      readonly ran: false;
      readonly reason: string;
      /** Whether git ran to an exit status, rather than being stopped or never starting. */
      readonly exited: boolean;
    };

function runGit(snapshot: string, args: readonly string[], signal: AbortSignal | undefined): Promise<Ran> {
  return new Promise((done) => {
    execFile(
      "git",
      [...GLOBAL_ARGUMENTS, ...args],
      {
        cwd: snapshot,
        env: gitEnvironment(),
        encoding: "buffer",
        maxBuffer: OUTPUT_CAP,
        timeout: TIME_LIMIT_MS,
        ...(signal === undefined ? {} : { signal }),
      },
      (error, stdout, stderr) => {
        const out = decode(stdout);
        if (error === null) return done({ ran: true, stdout: out, cut: false });
        // Past the cap Node stops git and hands back what it had, which is the
        // answer, cut.
        if ("code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && stdout.length > 0) {
          return done({ ran: true, stdout: out, cut: true });
        }
        const exited = "code" in error && typeof error.code === "number" && error.name !== "AbortError";
        done({ ran: false, reason: describeFailure(error, decode(stderr)), exited });
      },
    );
  });
}

function decode(bytes: Buffer): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function describeFailure(error: Error, stderr: string): string {
  const said = stderr.trim();
  if (error.name === "AbortError") return "git was stopped";
  if ("killed" in error && error.killed === true) {
    return `git ran past its ${TIME_LIMIT_MS / 1000} seconds and was stopped`;
  }
  const code = "code" in error ? error.code : undefined;
  const exit = typeof code === "number" ? `git exited ${code}` : `git could not be run: ${error.message}`;
  return said === "" ? exit : `${exit}: ${said}`;
}

function answer(tool: string, ran: Ran): HistoryResult {
  if (!ran.ran) return { text: ran.reason, failed: true };
  if (!ran.cut) return { text: ran.stdout, failed: false };
  return {
    text: `${ran.stdout}\n[${tool} output cut at ${OUTPUT_CAP.toLocaleString("en-US")} bytes; the rest was not read]\n`,
    failed: false,
  };
}

function refused(reason: string): HistoryResult {
  return { text: reason, failed: true };
}

/**
 * The string `params[key]` holds, or why it cannot be used. An empty string
 * and one holding a NUL, which no argument can carry, are refused.
 */
function stringArgument(params: unknown, key: string): string | { readonly reason: string } {
  const value = typeof params === "object" && params !== null ? (params as Record<string, unknown>)[key] : undefined;
  if (typeof value !== "string" || value === "") return { reason: `${key} must be a non-empty string` };
  if (value.includes("\0")) return { reason: `${key} must not contain a NUL character` };
  return value;
}

export const gitLogSearch: HistoryTool = {
  name: "git_log_search",
  description:
    "Find the commits that added or removed a string, newest first, with each commit's message and the files it changed. Runs `git log -S<term>` from the commit under review. The term is matched as literal text.",
  parameters: {
    type: "object",
    properties: { term: { type: "string", description: "The literal text to search the history for." } },
    required: ["term"],
  },
  run: async (snapshot, params, signal) => {
    const term = stringArgument(params, "term");
    if (typeof term !== "string") return refused(term.reason);
    const ran = await runGit(
      snapshot,
      [
        "log",
        "--no-textconv",
        "--no-ext-diff",
        "--no-show-signature",
        "--no-decorate",
        "--no-abbrev-commit",
        "--format=medium",
        "--date=iso",
        "--name-status",
        // Stuck to its flag, the term is the flag's value whatever it starts with.
        `-S${term}`,
        "--end-of-options",
        "HEAD",
      ],
      signal,
    );
    if (ran.ran && ran.stdout === "") return { text: `No commit added or removed ${JSON.stringify(term)}.`, failed: false };
    return answer(gitLogSearch.name, ran);
  },
};

export const gitBlame: HistoryTool = {
  name: "git_blame",
  description:
    "Name the commit that last changed one line of a file, with its author and date. Runs `git blame` on the file as the commit under review holds it.",
  parameters: {
    type: "object",
    properties: {
      file: { type: "string", description: "The file's path, relative to the repository root." },
      line: { type: "integer", minimum: 1, description: "The line number, counting from 1." },
    },
    required: ["file", "line"],
  },
  run: async (snapshot, params, signal) => {
    const file = stringArgument(params, "file");
    if (typeof file !== "string") return refused(file.reason);
    const line = typeof params === "object" && params !== null ? (params as Record<string, unknown>)["line"] : undefined;
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
      return refused("line must be a whole number from 1");
    }
    const outside = escapes(snapshot, file);
    if (outside !== undefined) return refused(outside);

    // Blaming `HEAD` reads the file from the commit, never from the working
    // tree, so no clean filter runs and nothing written to the snapshot since
    // is blamed as committed.
    const ran = await runGit(
      snapshot,
      [
        "blame",
        "--no-textconv",
        "--no-ignore-revs-file",
        "-l",
        "--date=iso",
        "-L",
        `${line},${line}`,
        "HEAD",
        "--",
        file,
      ],
      signal,
    );
    return answer(gitBlame.name, ran);
  },
};

/**
 * Why `file` is outside `snapshot`, or undefined where it is inside.
 *
 * An absolute path and one whose `..` climbs out are refused as written. A path
 * that exists on disk is refused where a symbolic link on the way resolves it
 * outside.
 */
function escapes(snapshot: string, file: string): string | undefined {
  const refusal = `${file} is outside the snapshot; name a file by its path from the repository root`;
  if (isAbsolute(file)) return refusal;
  const lexical = relative(snapshot, resolve(snapshot, file));
  if (lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) return refusal;
  let real: string;
  try {
    real = realpathSync(join(snapshot, file));
  } catch {
    return undefined;
  }
  const rooted = relative(realpathSync(snapshot), real);
  if (rooted === ".." || rooted.startsWith(`..${sep}`) || isAbsolute(rooted)) return refusal;
  return undefined;
}

export const gitShow: HistoryTool = {
  name: "git_show",
  description:
    "Show one commit: its author, date and message, and the change it made. Runs `git show` on a commit, named by its hash or by a revision such as `HEAD~2` that resolves to one. A range, a tree or a file at a revision is refused.",
  parameters: {
    type: "object",
    properties: { commit: { type: "string", description: "The commit's hash, or a revision naming one commit." } },
    required: ["commit"],
  },
  run: async (snapshot, params, signal) => {
    const commit = stringArgument(params, "commit");
    if (typeof commit !== "string") return refused(commit.reason);

    // A revision can name a blob, a tree or a range as well as a commit. Only
    // what peels to one commit is shown, by its full name, which git cannot
    // read as anything else.
    const resolved = await runGit(
      snapshot,
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${commit}^{commit}`],
      signal,
    );
    // Only a git that ran and found no commit says the argument is wrong.
    if (!resolved.ran && !resolved.exited) return refused(resolved.reason);
    const name = resolved.ran ? resolved.stdout.trim() : "";
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(name)) {
      return refused(`${commit} is not a commit in the snapshot's repository`);
    }

    const ran = await runGit(
      snapshot,
      [
        "show",
        "--no-textconv",
        "--no-ext-diff",
        "--no-show-signature",
        "--no-decorate",
        "--format=medium",
        "--date=iso",
        "--end-of-options",
        name,
      ],
      signal,
    );
    return answer(gitShow.name, ran);
  },
};

/** In the order the grant carries them. */
export const historyTools: readonly HistoryTool[] = Object.freeze([gitLogSearch, gitBlame, gitShow]);
