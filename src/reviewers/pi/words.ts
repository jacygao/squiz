/**
 * A command line, read as the commands it runs and the words of each.
 *
 * This is splitting, and it is not a shell. It expands nothing: a substitution,
 * a variable, a glob and a tilde come back as the characters they were written
 * with, and a word built out of any of them is a word whose value splitting
 * cannot know. What it does read is the quoting, so that a separator written
 * inside an argument stays inside it and one written outside it ends a command.
 */

/**
 * One word of a command line.
 *
 * A word that carried a quote or a backslash is not plain, and a caller that
 * matches names should leave it alone: what the shell would make of it is more
 * than splitting can say.
 */
export type Word = {
  readonly text: string;
  readonly plain: boolean;
};

/** Where one command ends and the next one begins. */
const ENDS_A_COMMAND: ReadonlySet<string> = new Set([";", "\n", "|", "&", "(", ")"]);

const SINGLE_QUOTE = "'";
const DOUBLE_QUOTE = '"';
const BACKSLASH = "\\";
const COMMENT = "#";

/**
 * What a backslash escapes inside double quotes.
 *
 * Before anything else it stands for itself, so the argument written `"a\nb"`
 * is the four characters `a`, `\`, `n` and `b`.
 */
const ESCAPED_IN_DOUBLE_QUOTES: ReadonlySet<string> = new Set([DOUBLE_QUOTE, BACKSLASH, "$", "`"]);

/**
 * The line as the commands it runs, each one its own words.
 *
 * The quoting rules, in the three states a character can be read in:
 *
 * - Outside quotes, a backslash escapes whatever follows it, a separator
 *   included, and a quote opens a quoted run.
 * - Inside single quotes, every character stands for itself. Only another
 *   single quote closes them.
 * - Inside double quotes, a backslash escapes `"`, `\`, `$` and a backtick, and
 *   stands for itself before anything else. Only an unescaped double quote
 *   closes them.
 *
 * A `#` where a word starts opens a comment, and the shell reads the rest of the
 * line as nothing: a quote inside it opens nothing and a separator inside it
 * ends no command. Written anywhere else it is a character of the word — quoted,
 * escaped, or against a word already begun, as in `--grep=x#y`.
 *
 * A quoted empty string is a word: `git -C "" commit` is four words, and the
 * third of them is empty. A quote left open runs to the end of the line, which
 * is a line no shell would run.
 */
export function splitIntoCommands(line: string): readonly (readonly Word[])[] {
  const commands: Word[][] = [];
  let words: Word[] = [];
  let text = "";
  let plain = true;
  // A word can be open and still empty, which is what makes `""` an argument.
  let open = false;
  let quote: string | null = null;

  function take(char: string): void {
    text += char;
    open = true;
  }

  function endWord(): void {
    if (open) words.push({ text, plain });
    text = "";
    plain = true;
    open = false;
  }

  function endCommand(): void {
    endWord();
    if (words.length !== 0) commands.push(words);
    words = [];
  }

  for (let at = 0; at < line.length; at += 1) {
    const char = line[at] ?? "";

    if (quote === SINGLE_QUOTE) {
      if (char === SINGLE_QUOTE) quote = null;
      else take(char);
      continue;
    }

    if (quote === DOUBLE_QUOTE) {
      if (char === DOUBLE_QUOTE) {
        quote = null;
        continue;
      }
      if (char !== BACKSLASH) {
        take(char);
        continue;
      }
      const escaped = line[at + 1];
      // A backslash ending the line escapes nothing and is a character of its own.
      if (escaped === undefined) {
        take(char);
        continue;
      }
      at += 1;
      // A backslash before a newline joins the two lines, inside these quotes as outside them.
      if (escaped === "\n") continue;
      if (ESCAPED_IN_DOUBLE_QUOTES.has(escaped)) {
        take(escaped);
        continue;
      }
      take(char);
      take(escaped);
      continue;
    }

    // A word already begun takes the `#` as one of its characters, so only an
    // unquoted `#` with no word open is a comment.
    if (char === COMMENT && !open) {
      const newline = line.indexOf("\n", at + 1);
      if (newline === -1) break;
      // The newline closes the comment, and the next pass reads it as the separator it is.
      at = newline - 1;
      continue;
    }

    if (char === SINGLE_QUOTE || char === DOUBLE_QUOTE) {
      quote = char;
      plain = false;
      open = true;
      continue;
    }

    if (char === BACKSLASH) {
      const escaped = line[at + 1];
      at += 1;
      // A backslash before a newline joins the two lines and leaves no word behind.
      if (escaped === undefined || escaped === "\n") continue;
      plain = false;
      take(escaped);
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

    take(char);
  }

  endCommand();
  return commands;
}
