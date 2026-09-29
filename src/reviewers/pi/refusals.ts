/**
 * The reviewer's calls that would change what the coding agent commits, refused
 * inside `pi` before the command runs.
 *
 * `pi` offers every tool call to a handler before it executes it, and executes
 * nothing the handler blocks. So a refused call never reaches a shell, and the
 * reviewer reads the refusal as that call's own error while it is still there to
 * choose something else. A handler that throws refuses the call too: the throw
 * comes back as the call's error result, and the run carries on.
 *
 * Two kinds are refused. The tools a review has no use for go by name, which
 * needs no reading of what they were given. The commands go by what they would
 * do: the ones that move `HEAD` while leaving the worktree byte for byte as it
 * was, which is the change nothing downstream can see.
 *
 * **A command line is split into words, and the split is not a shell.** It
 * refuses a reviewer that is not trying to get around the list, and it does not
 * bound one that is. Quoting, a script file, an encoded string and `sh -c` each
 * defeat it, and a reviewer that means to commit still can. A command handed to
 * another command to run — after `env`, `xargs` or `ssh` — is read as that
 * command's arguments and matches nothing. A heredoc's body is not told from the
 * script around it, so a line inside one that reads as a refused command is
 * refused. What keeps the gap small is that the tools needing no matching go by
 * name, and that the list only has to cover the commands which move `HEAD`
 * without touching the tree.
 *
 * `pi` is not a dependency of this package and nothing here may make it one, so
 * the call and the answer are described structurally, as the extension's own
 * types are.
 */

/** One tool call, as `pi` offers it to a handler before running it. */
export type ToolCall = {
  readonly toolName: string;
  /** Whatever the tool takes. `bash` takes a `command`, and nothing else is read. */
  readonly input: unknown;
};

/** What stops the call. The reason is what the reviewer reads in its place. */
export type Refusal = {
  readonly block: true;
  readonly reason: string;
};

/**
 * The tools refused by name.
 *
 * A review reports through the calls and writes nothing, so a round that grants
 * either of these grants a write primitive for nothing. The grant withholds them
 * as well; this is what holds if a grant ever stops being passed.
 */
export const refusedTools: readonly string[] = Object.freeze(["edit", "write"]);

/**
 * One command refused in `bash`, and what it takes to recognise it.
 *
 * `named` is the reason's own words for what the reviewer reached for, written
 * out rather than built from the other two, so that running it back through the
 * matcher says whether the two agree.
 */
export type RefusedCommand = {
  /** The command as a person writes it, which is what the reviewer is told. */
  readonly named: string;
  /** The subcommand, wherever it lands after `git`'s own options. */
  readonly subcommand: string;
  /** Where the subcommand alone is not the mutation, the flag that makes it one, wherever it sits. */
  readonly flag?: string;
};

/**
 * The commands refused in `bash`: the ones that change the commit and leave the
 * worktree as it was.
 *
 * `git commit` already covers the amend, and the amend is listed anyway so that
 * removing either one still leaves the other refused. It sits first because the
 * first entry that matches is the one the reason names, and naming the amend
 * tells the reviewer which call of its own was stopped.
 */
export const refusedCommands: readonly RefusedCommand[] = Object.freeze([
  { named: "git commit --amend", subcommand: "commit", flag: "--amend" },
  { named: "git commit", subcommand: "commit" },
  { named: "git reset --soft", subcommand: "reset", flag: "--soft" },
  { named: "git checkout -B", subcommand: "checkout", flag: "-B" },
  { named: "git update-ref", subcommand: "update-ref" },
  { named: "git push", subcommand: "push" },
]);

/**
 * What every refusal opens with.
 *
 * It is the only thing that tells a call refused here from a tool that failed on
 * its own, and the round counts its refusals by it.
 */
const REFUSED = "squiz refused this call: ";

/** The tool whose command is read. Every other tool is refused or passed by name. */
const SHELL = "bash";

/** The command whose subcommands are on the list. */
const GIT = "git";

/**
 * `git`'s own options that take the word after them, which is therefore not the
 * subcommand.
 *
 * The `--option=value` spellings need no entry here: a word opening with `-` is
 * an option, and the subcommand is the first word that is not one.
 */
const GIT_OPTIONS_TAKING_A_VALUE: readonly string[] = [
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
];

/** Where one command ends and the next one begins. */
const ENDS_A_COMMAND: ReadonlySet<string> = new Set([";", "\n", "|", "&", "(", ")"]);

/**
 * The words that can stand in front of a command without being the command.
 *
 * Each is stepped over, and the command is whatever follows it.
 */
const STANDS_BEFORE_A_COMMAND: ReadonlySet<string> = new Set([
  "!",
  "{",
  "}",
  "time",
  "if",
  "then",
  "elif",
  "else",
  "do",
  "while",
  "until",
]);

/** `GIT_AUTHOR_NAME=squiz git commit` runs git, with the assignment in front of it. */
const AN_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/**
 * One word of a command line.
 *
 * A word that carried a quote or a backslash is not plain, and nothing matches
 * against it: what the shell would make of it is more than splitting can say.
 */
type Word = {
  readonly text: string;
  readonly plain: boolean;
};

/** A `git` call, read down to the subcommand. */
type GitCall = {
  readonly subcommand: string;
  /** Everything after the subcommand, which is where a listed flag is looked for. */
  readonly arguments: readonly Word[];
};

/**
 * Refuse the call, or let it through.
 *
 * `undefined` is a call nothing here objects to, which is what `pi` needs to run
 * it. Never throws; a throw would refuse the call as well, but it would refuse a
 * call this was going to allow.
 */
export function refuse(call: ToolCall): Refusal | undefined {
  if (refusedTools.includes(call.toolName)) {
    return refusal(
      `a review has no use for \`${call.toolName}\`, and it changes the code you are reviewing. Report what is wrong with the change instead.`,
    );
  }
  if (call.toolName !== SHELL) return undefined;

  const command = commandOf(call.input);
  // A shell call whose command cannot be read is refused rather than run. The
  // field is `pi`'s, and one it renames would otherwise leave every command
  // matching nothing and the list quietly doing nothing at all.
  if (command === null) {
    return refusal(
      `the command could not be read out of this \`${SHELL}\` call, so nothing here could check it.`,
    );
  }

  const matched = refusedIn(command);
  if (matched === undefined) return undefined;
  return refusal(
    `\`${matched.named}\` changes what the coding agent commits. Report what is wrong with the change instead of changing it.`,
  );
}

/**
 * Whether the call this result answers was refused here.
 *
 * `pi` answers a blocked call with the reason as the result's only text, so the
 * opening of that text is what a reader of the stream has to go on.
 */
export function wasRefused(result: unknown): boolean {
  const content = fieldOf(result, "content");
  if (!Array.isArray(content)) return false;
  const blocks: readonly unknown[] = content;
  return blocks.some((block) => {
    const text = fieldOf(block, "text");
    return typeof text === "string" && text.startsWith(REFUSED);
  });
}

/** One refusal, opened with the marker the round counts by. */
function refusal(said: string): Refusal {
  return { block: true, reason: `${REFUSED}${said}` };
}

/**
 * The first listed command the line invokes, or `undefined` where it invokes
 * none.
 *
 * A listed command has to be invoked to match. One that is only named — as a
 * pattern to search for, or as a string to print — is an argument to whatever
 * command the line does invoke, and that command is read instead.
 */
function refusedIn(line: string): RefusedCommand | undefined {
  for (const words of commandsIn(line)) {
    const git = gitCallIn(words);
    if (git === undefined) continue;
    const matched = refusedCommands.find(
      (command) =>
        command.subcommand === git.subcommand &&
        (command.flag === undefined || carries(git.arguments, command.flag)),
    );
    if (matched !== undefined) return matched;
  }
  return undefined;
}

/** Whether the flag is among the words, as a word of its own and plainly written. */
function carries(words: readonly Word[], flag: string): boolean {
  return words.some((word) => word.plain && word.text === flag);
}

/**
 * The subcommand a `git` call runs, and the words after it.
 *
 * `undefined` where the words are some other command, or where `git`'s
 * subcommand is not plain enough to read. A subcommand that has to be guessed at
 * is left alone rather than guessed at.
 */
function gitCallIn(words: readonly Word[]): GitCall | undefined {
  let at = 0;
  while (at < words.length && standsBeforeACommand(words[at])) at += 1;

  const name = words[at];
  if (name === undefined || !name.plain) return undefined;
  // `/usr/bin/git` runs the same git.
  if (name.text.slice(name.text.lastIndexOf("/") + 1) !== GIT) return undefined;

  at += 1;
  for (let option = words[at]; option?.text.startsWith("-") === true; option = words[at]) {
    at += GIT_OPTIONS_TAKING_A_VALUE.includes(option.text) ? 2 : 1;
  }

  const subcommand = words[at];
  if (subcommand === undefined || !subcommand.plain) return undefined;
  return { subcommand: subcommand.text, arguments: words.slice(at + 1) };
}

/** Whether the word is one of those a command can follow rather than the command. */
function standsBeforeACommand(word: Word | undefined): boolean {
  if (word === undefined) return false;
  if (AN_ASSIGNMENT.test(word.text)) return true;
  return word.plain && STANDS_BEFORE_A_COMMAND.has(word.text);
}

/**
 * The line as the commands it invokes, each one its own words.
 *
 * Quotes are read only far enough to know which characters are text and which
 * separate one command from the next, so that a command named inside an argument
 * stays inside it. A word is what a run of whitespace ends, and the quotes and
 * backslashes themselves are dropped from it.
 */
function commandsIn(line: string): readonly (readonly Word[])[] {
  const commands: Word[][] = [];
  let words: Word[] = [];
  let text = "";
  let plain = true;
  let quote: string | null = null;

  function endWord(): void {
    if (text !== "") words.push({ text, plain });
    text = "";
    plain = true;
  }

  function endCommand(): void {
    endWord();
    if (words.length !== 0) commands.push(words);
    words = [];
  }

  for (let at = 0; at < line.length; at += 1) {
    const char = line[at] ?? "";
    if (quote !== null) {
      if (char === quote) quote = null;
      else text += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      plain = false;
      continue;
    }
    if (char === "\\") {
      at += 1;
      const escaped = line[at];
      // A backslash before a newline joins the two lines and leaves no word behind.
      if (escaped === undefined || escaped === "\n") continue;
      text += escaped;
      plain = false;
      continue;
    }
    if (ENDS_A_COMMAND.has(char)) {
      endCommand();
      continue;
    }
    if (/\s/u.test(char)) {
      endWord();
      continue;
    }
    text += char;
  }
  endCommand();
  return commands;
}

/**
 * The command the shell call was given, or `null` where there is none to read.
 *
 * Read structurally, because `pi`'s own type for it is not something this
 * package may import.
 */
function commandOf(input: unknown): string | null {
  const command = fieldOf(input, "command");
  return typeof command === "string" ? command : null;
}

/** One field of a value that may not be an object at all. */
function fieldOf(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Readonly<Record<string, unknown>>)[field];
}
