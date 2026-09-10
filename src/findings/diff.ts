/**
 * The anchor validator: a unified-diff parser answering whether a `file` and
 * `line` is one the change touched.
 *
 * An inline comment is anchored to a line the change touched, and GitHub
 * refuses an anchor outside the diff, so a finding whose anchor this rejects is
 * reported as a general finding instead.
 * (review-harness-spec, "Pull request comments")
 *
 * The diff arrives as a string. Nothing here reaches GitHub, the network or the
 * filesystem.
 */

/**
 * A diff this parser cannot read.
 *
 * Thrown rather than answered, because a diff that cannot be read and a diff
 * that does not contain the line are different facts. If both were `false`, a
 * format nobody anticipated would reroute every finding into the summary and
 * the round would still look clean.
 */
export class DiffParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DiffParseError";
  }
}

/**
 * The lines a change added, keyed by the path each file has on the new side.
 *
 * Line numbers are the new file's, because an anchor is a line in the file as
 * it now stands. A removed line is in no set here: it exists only on the old
 * side, so nothing can be anchored to it.
 */
export type ChangedLines = ReadonlyMap<string, ReadonlySet<number>>;

/**
 * Read a unified diff into the lines it added.
 *
 * Throws `DiffParseError` on anything it cannot account for: a hunk header it
 * cannot read, a hunk that delivers a different number of lines than it
 * declares, a body line with no marker, a combined diff, or text naming no file
 * at all. Being loud is the point — see the class.
 *
 * Paths are repository-relative, as the diff names them on its new side.
 */
export function parseDiff(diff: string): ChangedLines {
  const added = new Map<string, Set<number>>();

  // Null while the current file has no new side, which is how a deletion looks.
  // Its hunks are still read, so that a miscount cannot run past the file.
  let path: string | null = null;
  let sawNewSide = false;
  let sawFile = false;
  let hunk: Hunk | null = null;

  for (const line of splitLines(diff)) {
    if (hunk !== null) {
      // "\ No newline at end of file" annotates the line before it and is not
      // a line of either side.
      if (line.startsWith("\\")) continue;

      const marker = line.charAt(0);
      if (marker === "+") {
        if (path !== null) linesOf(added, path).add(hunk.nextLine);
        hunk.nextLine += 1;
        hunk.fromNew -= 1;
      } else if (marker === " ") {
        hunk.nextLine += 1;
        hunk.fromNew -= 1;
        hunk.fromOld -= 1;
      } else if (marker === "-") {
        hunk.fromOld -= 1;
      } else {
        // Git writes an empty context line as a single space, so a line with no
        // marker is a shape this parser does not know.
        throw new DiffParseError(
          `${describe(line)} is inside a hunk and starts with no marker`,
        );
      }

      if (hunk.fromOld < 0 || hunk.fromNew < 0) {
        throw new DiffParseError(
          `a hunk delivers more lines than its header declares, at ${describe(line)}`,
        );
      }
      if (hunk.fromOld === 0 && hunk.fromNew === 0) hunk = null;
      continue;
    }

    if (line.startsWith("@@@")) {
      // A merge's combined diff carries one marker column per parent, so every
      // count this parser keeps would be off by a column.
      throw new DiffParseError(`a combined diff cannot be read: ${describe(line)}`);
    }

    if (line.startsWith("@@")) {
      if (!sawNewSide) {
        throw new DiffParseError(`a hunk arrives before any file: ${describe(line)}`);
      }
      hunk = hunkOf(line);
      if (hunk.fromOld === 0 && hunk.fromNew === 0) hunk = null;
    } else if (line.startsWith("+++ ")) {
      path = newSidePathOf(line);
      sawNewSide = true;
      sawFile = true;
    } else if (line.startsWith("diff --git ")) {
      path = null;
      sawNewSide = false;
      sawFile = true;
    }
  }

  if (hunk !== null) {
    throw new DiffParseError(
      "the diff ends inside a hunk that has not delivered the lines it declares",
    );
  }
  // A diff with no changes is empty. Text that is neither is not a diff, and
  // answering "no" for every line of it would hide that.
  if (!sawFile && diff.trim() !== "") {
    throw new DiffParseError("the diff names no file");
  }

  return added;
}

/**
 * Whether the change touched this line of this file.
 *
 * True only for a line the change added, which is what an inline comment is
 * anchored to. A context line answers false: the change did not touch it, and
 * whether GitHub would nonetheless accept it as an anchor is open (#61).
 *
 * A file the diff does not name answers false rather than throwing.
 */
export function touchesLine(changed: ChangedLines, file: string, line: number): boolean {
  return changed.get(file)?.has(line) ?? false;
}

/** What a hunk header declares, counted down as the hunk's body is read. */
type Hunk = {
  nextLine: number;
  fromOld: number;
  fromNew: number;
};

// A count is absent for a range of one line: "@@ -1 +1 @@".
const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function hunkOf(line: string): Hunk {
  const header = hunkHeader.exec(line);
  if (header === null) {
    throw new DiffParseError(`a hunk header this parser cannot read: ${describe(line)}`);
  }
  return {
    nextLine: Number(header[3]),
    fromOld: header[2] === undefined ? 1 : Number(header[2]),
    fromNew: header[4] === undefined ? 1 : Number(header[4]),
  };
}

function linesOf(added: Map<string, Set<number>>, path: string): Set<number> {
  const existing = added.get(path);
  if (existing !== undefined) return existing;
  const lines = new Set<number>();
  added.set(path, lines);
  return lines;
}

/** The path a `+++` header names, or null where it names `/dev/null`. */
function newSidePathOf(header: string): string | null {
  const rest = header.slice("+++ ".length);

  // Git appends a tab to a name holding a space, quoted or not, so that the
  // name's end can be found. Verified against git 2.50.1.
  const tab = rest.indexOf("\t");
  const name = tab === -1 ? rest : rest.slice(0, tab);

  const path = name.startsWith(`"`) ? unquote(name) : name;
  if (path === "/dev/null") return null;
  return path.startsWith("b/") ? path.slice(2) : path;
}

const escapes = new Map<string, number>([
  ["a", 0x07],
  ["b", 0x08],
  ["t", 0x09],
  ["n", 0x0a],
  ["v", 0x0b],
  ["f", 0x0c],
  ["r", 0x0d],
  [`"`, 0x22],
  ["\\", 0x5c],
]);

const octal = /^[0-7]{1,3}/;

/**
 * Read a path git wrote in C quoting, which it does for a name holding a
 * control character, a quote, a backslash or any byte above ASCII.
 *
 * The escapes are bytes rather than characters: git writes one `\ooo` per byte,
 * so a two-byte character arrives as two escapes and only becomes itself once
 * the bytes are decoded together.
 */
function unquote(name: string): string {
  if (!name.endsWith(`"`) || name.length < 2) {
    throw new DiffParseError(`a quoted path that does not close its quote: ${describe(name)}`);
  }

  const body = name.slice(1, -1);
  const encoder = new TextEncoder();
  const bytes: number[] = [];

  let at = 0;
  while (at < body.length) {
    const character = body.charAt(at);
    if (character !== "\\") {
      for (const byte of encoder.encode(character)) bytes.push(byte);
      at += 1;
      continue;
    }

    const escape = escapes.get(body.charAt(at + 1));
    if (escape !== undefined) {
      bytes.push(escape);
      at += 2;
      continue;
    }

    const digits = octal.exec(body.slice(at + 1));
    if (digits === null) {
      throw new DiffParseError(
        `a quoted path with an escape this parser cannot read: ${describe(name)}`,
      );
    }
    bytes.push(Number.parseInt(digits[0], 8));
    at += 1 + digits[0].length;
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
}

function splitLines(diff: string): string[] {
  const lines = diff.split("\n");
  // The final newline ends the last line rather than starting an empty one.
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Shows the text as it was written, short enough to fit in a message. */
function describe(text: string): string {
  const shown = text.length > 60 ? `${text.slice(0, 57)}...` : text;
  return JSON.stringify(shown);
}
