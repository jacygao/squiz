/**
 * The anchor validator: a unified-diff parser answering whether a `file` and
 * `line` is one the change touched, and whether the diff carries the file at
 * all.
 *
 * An inline comment is anchored to a line the change touched, and GitHub
 * refuses an anchor outside the diff, so a finding whose anchor this rejects is
 * posted on its file instead, and on nothing where the diff does not carry the
 * file either.
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
 *
 * A key is every file the diff leaves a new side of, so a file whose change
 * added no line is present with an empty set. The keys therefore answer which
 * files the diff carries, which is what a comment on a file as a whole needs.
 */
export type ChangedLines = ReadonlyMap<string, ReadonlySet<number>>;

/**
 * Read a unified diff into the lines it added, keyed by the files it carries.
 *
 * A file is keyed whether or not it has a `+++` header. A binary file, a mode
 * change and an added empty file carry none, and all three are files a comment
 * can hang on.
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
  // The file entry being read, while it has shown no `+++` header. Held to the
  // end of the entry, because the headers that decide whether it has a new side
  // arrive in no fixed order.
  let entry: Entry | null = null;

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
      // A file the change only removed lines from is still a file a comment can
      // hang on, and it would reach no hunk body that keys it.
      if (path !== null) linesOf(added, path);
      sawNewSide = true;
      sawFile = true;
      // The header says what the file is called and whether it has a new side,
      // so the entry's other headers decide nothing.
      entry = null;
    } else if (line.startsWith("diff --git ")) {
      keyEntry(added, entry);
      entry = { name: sameNameOf(line), changed: false, deleted: false };
      path = null;
      sawNewSide = false;
      sawFile = true;
    } else if (entry !== null) {
      readEntryHeader(entry, line);
    }
  }

  if (hunk !== null) {
    throw new DiffParseError(
      "the diff ends inside a hunk that has not delivered the lines it declares",
    );
  }
  keyEntry(added, entry);
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
 * anchored to. A context line answers false. GitHub would take one as an
 * anchor, but no finding is anchored there: a finding is anchored to the
 * changed line that caused it.
 *
 * A file the diff does not name answers false rather than throwing.
 */
export function touchesLine(changed: ChangedLines, file: string, line: number): boolean {
  return changed.get(file)?.has(line) ?? false;
}

/**
 * Whether the change touched this file, on any line of it.
 *
 * True for a file the diff gives a new side, whether or not the change added a
 * line to it, because a comment on a file as a whole hangs on the file rather
 * than on a line. A file the change deleted answers false: it has no new side
 * left to comment on.
 */
export function touchesFile(changed: ChangedLines, file: string): boolean {
  return changed.has(file);
}

/**
 * What a file entry's headers say, while it has shown no `+++` of its own.
 *
 * `changed` is true once a header shows the file was added, or that its content
 * or its mode changed. It is what separates a file that has a new side to
 * comment on from a rename that moved the same bytes to a new name.
 */
type Entry = {
  name: string | null;
  changed: boolean;
  deleted: boolean;
};

/** Take what one header line of a file entry says about the file's new side. */
function readEntryHeader(entry: Entry, line: string): void {
  if (line.startsWith("deleted file mode ")) {
    entry.deleted = true;
  } else if (line.startsWith("rename to ")) {
    // Where the new side of a rename is named, since no other header of one
    // yields it.
    entry.name = pathOf(line.slice("rename to ".length));
  } else if (
    line.startsWith("Binary files ") ||
    line.startsWith("new mode ") ||
    line.startsWith("new file mode ")
  ) {
    // An added empty file is all header: git writes its mode and its index and
    // stops, having no content to show.
    entry.changed = true;
  }
}

/**
 * Key a file the diff carries with no `+++` header: a binary file, a mode
 * change, or an added empty file.
 *
 * A deletion keys nothing, because it leaves no new side to comment on, and
 * neither does an entry showing no change at all, which is what a rename that
 * moved the file unaltered is. A file whose name could not be read keys
 * nothing either: that costs one finding its thread, where a throw would cost
 * the round every thread it had.
 */
function keyEntry(added: Map<string, Set<number>>, entry: Entry | null): void {
  if (entry === null || entry.deleted || !entry.changed || entry.name === null) return;
  linesOf(added, entry.name);
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
  const path = pathOf(tab === -1 ? rest : rest.slice(0, tab));
  if (path === "/dev/null") return null;
  return unprefixed(path);
}

/**
 * The path a `diff --git` line names, where both of its sides name the same
 * one, and null where they do not.
 *
 * Neither side is terminated, so the space between them reads like one inside a
 * name that holds a space. Splitting the line down its middle finds the
 * separator for a file named the same on both sides, which is every entry but a
 * rename. A rename is read from its `rename to` header instead.
 */
function sameNameOf(header: string): string | null {
  const rest = header.slice("diff --git ".length);
  const middle = (rest.length - 1) / 2;
  if (!Number.isInteger(middle) || rest.charAt(middle) !== " ") return null;

  const oldSide = rest.slice(0, middle);
  const newSide = rest.slice(middle + 1);
  // Where the split landed right, the two sides are the same text but for the
  // letter git prefixes each with, which follows the quote on a quoted name.
  const letter = newSide.startsWith(`"`) ? 1 : 0;
  if (oldSide.charAt(letter) !== "a" || newSide.charAt(letter) !== "b") return null;
  if (oldSide.slice(letter + 1) !== newSide.slice(letter + 1)) return null;

  return unprefixed(pathOf(newSide));
}

/** A path as a diff header wrote it, with git's quoting read where it quoted. */
function pathOf(name: string): string {
  return name.startsWith(`"`) ? unquote(name) : name;
}

/** A path on the new side, with the `b/` prefix git gives that side removed. */
function unprefixed(path: string): string {
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
