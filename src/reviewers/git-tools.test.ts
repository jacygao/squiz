import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, realpathSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { BASE_REF } from "../worktree/snapshot.ts";
import { changedFiles, changeDiff, gitBlame, gitDiff, gitLogSearch, gitShow, historyTools, OUTPUT_CAP } from "./git-tools.ts";

/** Run git in `directory` and return its stdout, failing the test rather than the fixture. */
function git(directory: string, ...args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** The identity is passed per command so the fixture does not depend on whoever runs it. */
function commit(directory: string, message: string): string {
  git(directory, "add", "--all");
  git(
    directory,
    "-c",
    "user.email=squiz@example.invalid",
    "-c",
    "user.name=Squiz",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--message",
    message,
  );
  return git(directory, "rev-parse", "HEAD").trim();
}

let root = "";
let repo = "";
let outside = "";
let marks = "";
let secret = "";
let first = "";
let second = "";
let signed = "";

/**
 * A repository under review that is as hostile as its own files and its local
 * config can make it.
 *
 * Every driver, hook and helper git could run names `mark`, which leaves a file
 * in `marks` named for the setting that ran it. A tool that ran nothing leaves
 * `marks` empty. `outside` holds a secret the snapshot must not reveal.
 */
before(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), "squiz-git-tools-")));
  repo = join(root, "repo");
  outside = join(root, "outside");
  marks = join(root, "marks");
  await mkdir(repo);
  await mkdir(outside);
  await mkdir(marks);
  secret = join(outside, "secret.txt");
  await writeFile(secret, "SECRET-CONTENT\n");

  const mark = join(outside, "mark");
  await writeFile(
    mark,
    `#!/bin/sh\ntouch "${marks}/$1"\nshift\nif [ $# -gt 0 ] && [ -f "$1" ]; then cat "$1"; fi\nexit 0\n`,
  );
  chmodSync(mark, 0o755);
  // `gpg.program` is run without a shell, so it takes no argument of its own.
  const gpg = join(outside, "gpg");
  await writeFile(gpg, `#!/bin/sh\ntouch "${marks}/gpg"\nexit 1\n`);
  chmodSync(gpg, 0o755);

  git(repo, "init", "--quiet", "--initial-branch", "main");
  await writeFile(join(repo, ".gitattributes"), "* diff=evil filter=evil\n");
  await writeFile(join(repo, "code.txt"), "one\ntwo --exec\nthree\n");
  first = commit(repo, "the first");
  await writeFile(join(repo, "code.txt"), "one\ntwo --exec\nthree -p\n");
  symlinkSync(secret, join(repo, "link.txt"));
  second = commit(repo, "the second");

  // A commit carrying a signature, which `log.showSignature` hands to `gpg.program`.
  const body = git(repo, "cat-file", "commit", "HEAD");
  const withSignature = body.replace(
    /^(committer .*\n)/mu,
    "$1gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQ\n -----END PGP SIGNATURE-----\n",
  );
  const written = spawnSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
    cwd: repo,
    input: withSignature,
    encoding: "utf8",
  });
  signed = written.stdout.trim();
  git(repo, "update-ref", "refs/heads/main", signed);
  // The signed commit replaces the second on the branch, so it is the one history names.
  second = signed;
  // The change under review is everything from the first commit to the head.
  git(repo, "update-ref", BASE_REF, first);

  const hostile: Record<string, string> = {
    "core.pager": `${mark} pager`,
    "core.fsmonitor": `${mark} fsmonitor`,
    "diff.external": `${mark} external`,
    "diff.evil.textconv": `${mark} textconv`,
    "diff.evil.command": `${mark} diffcommand`,
    "filter.evil.clean": `${mark} clean`,
    "filter.evil.smudge": `${mark} smudge`,
    "filter.evil.process": `${mark} process`,
    "log.showSignature": "true",
    "gpg.program": gpg,
    "blame.ignoreRevsFile": secret,
    "alias.show": `!${mark} alias`,
  };
  for (const [key, value] of Object.entries(hostile)) git(repo, "config", key, value);
  // The checkout above ran the smudge filter before the config named it; start counting now.
  for (const name of readdirSync(marks)) await rm(join(marks, name));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function ranNothing(): void {
  assert.deepEqual(readdirSync(marks), [], "git ran a program the repository's config named");
}

test("git_show shows a commit, whole", async () => {
  const result = await gitShow.run(repo, { commit: first });
  assert.equal(result.failed, false, result.text);
  assert.match(result.text, new RegExp(`^commit ${first}`, "u"));
  assert.match(result.text, /\+two --exec/u);
});

test("git_show runs no program the repository's config names", async () => {
  const result = await gitShow.run(repo, { commit: "HEAD" });
  assert.equal(result.failed, false, result.text);
  assert.match(result.text, new RegExp(`^commit ${signed}`, "u"));
  ranNothing();
});

test("git_show reads a commit that looks like an option as a commit, and writes nothing", async () => {
  const target = join(outside, "written");
  const result = await gitShow.run(repo, { commit: `--output=${target}` });
  assert.equal(result.failed, true);
  assert.match(result.text, /not a commit/u);
  assert.equal(existsSync(target), false, "git show wrote where the argument said");
});

test("git_show refuses a revision that names a file or a range rather than a commit", async () => {
  for (const commit of ["HEAD:code.txt", `HEAD:../outside/secret.txt`, `${first}..${second}`, "HEAD^{tree}"]) {
    const result = await gitShow.run(repo, { commit });
    assert.equal(result.failed, true, `${commit} was shown: ${result.text}`);
    // Where git explains the refusal itself, its explanation is what the reviewer reads.
    assert.match(result.text, /not a commit|is outside repository|expected commit type/u, commit);
    assert.doesNotMatch(result.text, /SECRET-CONTENT/u);
  }
});

test("git_show answers an unknown commit with git's own error, not a throw", async () => {
  const result = await gitShow.run(repo, { commit: "0123456789abcdef0123456789abcdef01234567" });
  assert.equal(result.failed, true);
  assert.match(result.text, /0123456789abcdef/u);
});

test("git_show answers a snapshot that is no repository with git's error, not as a bad commit", async () => {
  const result = await gitShow.run(outside, { commit: "HEAD" });
  assert.equal(result.failed, true);
  assert.match(result.text, /not a git repository/u);
});

test("git_show cuts its output at the cap and says so", async () => {
  const big = await mkdtemp(join(root, "big-"));
  git(big, "init", "--quiet", "--initial-branch", "main");
  await writeFile(join(big, "big.txt"), "x".repeat(99) + "\n".repeat(1) + ("y".repeat(99) + "\n").repeat(3000));
  commit(big, "a large commit");
  const result = await gitShow.run(big, { commit: "HEAD" });
  assert.equal(result.failed, false);
  assert.ok(result.text.length < OUTPUT_CAP + 500, `the output ran to ${result.text.length} characters`);
  assert.match(result.text, new RegExp(`cut at ${OUTPUT_CAP.toLocaleString("en-US")} bytes`, "u"));
});

test("git_log_search names the commits that added or removed the term", async () => {
  const result = await gitLogSearch.run(repo, { term: "three -p" });
  assert.equal(result.failed, false, result.text);
  assert.match(result.text, new RegExp(second, "u"));
  assert.doesNotMatch(result.text, new RegExp(first, "u"));
});

test("git_log_search searches for a term that starts with a dash as text", async () => {
  const exec = await gitLogSearch.run(repo, { term: "--exec" });
  assert.equal(exec.failed, false, exec.text);
  assert.match(exec.text, new RegExp(first, "u"));

  const patch = await gitLogSearch.run(repo, { term: "-p" });
  assert.equal(patch.failed, false, patch.text);
  assert.match(patch.text, new RegExp(second, "u"));
  assert.doesNotMatch(patch.text, /^diff --git/mu, "-p was read as an option");

  const target = join(outside, "searched");
  const output = await gitLogSearch.run(repo, { term: `--output=${target}` });
  assert.equal(output.failed, false, output.text);
  assert.equal(existsSync(target), false, "git log wrote where the term said");
});

test("git_log_search runs no program the repository's config names", async () => {
  const result = await gitLogSearch.run(repo, { term: "two" });
  assert.equal(result.failed, false, result.text);
  ranNothing();
});

test("git_blame names the commit that last changed the line", async () => {
  const result = await gitBlame.run(repo, { file: "code.txt", line: 3 });
  assert.equal(result.failed, false, result.text);
  assert.match(result.text, new RegExp(`^${second}`, "u"));
  assert.match(result.text, /three -p/u);
  assert.doesNotMatch(result.text, /two --exec/u);
});

test("git_blame runs no program the repository's config names, and reads no file it names", async () => {
  const result = await gitBlame.run(repo, { file: "code.txt", line: 2 });
  assert.equal(result.failed, false, result.text);
  assert.doesNotMatch(result.text, /SECRET-CONTENT/u);
  ranNothing();
});

test("git_blame reads a file that looks like an option as a file", async () => {
  const result = await gitBlame.run(repo, { file: `--contents=${secret}`, line: 1 });
  assert.equal(result.failed, true);
  assert.match(result.text, /no such path --contents=/u);
  assert.doesNotMatch(result.text, /SECRET-CONTENT/u);
});

test("git_blame refuses a file outside the snapshot before git runs", async () => {
  for (const file of [secret, "../outside/secret.txt", "sub/../../outside/secret.txt", "link.txt"]) {
    const result = await gitBlame.run(repo, { file, line: 1 });
    assert.equal(result.failed, true, `${file} was blamed: ${result.text}`);
    assert.match(result.text, /outside the snapshot/u, file);
    assert.doesNotMatch(result.text, /SECRET-CONTENT/u);
  }
});

test("git_blame answers a line past the end with git's own error, not a throw", async () => {
  const result = await gitBlame.run(repo, { file: "code.txt", line: 40 });
  assert.equal(result.failed, true);
  assert.match(result.text, /has only 3 lines/u);
});

test("each tool refuses arguments of the wrong shape before git runs", async () => {
  const refused = [
    await gitShow.run(repo, {}),
    await gitShow.run(repo, { commit: "" }),
    await gitLogSearch.run(repo, { term: 7 }),
    await gitLogSearch.run(repo, { term: "" }),
    await gitLogSearch.run(repo, { term: "a\0b" }),
    await gitBlame.run(repo, { file: "code.txt", line: 0 }),
    await gitBlame.run(repo, { file: "code.txt", line: 1.5 }),
    await gitBlame.run(repo, { file: "code.txt", line: "1" }),
    await gitBlame.run(repo, { file: "", line: 1 }),
  ];
  for (const result of refused) {
    assert.equal(result.failed, true, result.text);
    assert.match(result.text, /^(commit|term|line|file) must /u);
  }
});

test("each tool ignores the git environment it inherits", async () => {
  const other = await mkdtemp(join(root, "other-"));
  git(other, "init", "--quiet", "--initial-branch", "main");
  await writeFile(join(other, "code.txt"), "elsewhere\n");
  commit(other, "another repository");
  const saved = { ...process.env };
  process.env["GIT_DIR"] = join(other, ".git");
  process.env["GIT_EXTERNAL_DIFF"] = join(outside, "mark");
  process.env["GIT_PAGER"] = `${join(outside, "mark")} envpager`;
  try {
    const result = await gitShow.run(repo, { commit: second });
    assert.equal(result.failed, false, result.text);
    assert.match(result.text, /three -p/u);
    ranNothing();
  } finally {
    for (const key of ["GIT_DIR", "GIT_EXTERNAL_DIFF", "GIT_PAGER"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("git_show fetches no missing object, so no transport the config names runs", async () => {
  const partial = await mkdtemp(join(root, "partial-"));
  git(partial, "init", "--quiet", "--initial-branch", "main");
  git(partial, "config", "core.repositoryformatversion", "1");
  git(partial, "config", "extensions.partialClone", "origin");
  git(partial, "config", "remote.origin.url", "ssh://example.invalid/repo");
  git(partial, "config", "remote.origin.promisor", "true");
  git(partial, "config", "core.sshCommand", `${join(outside, "mark")} lazyfetch`);
  const made = spawnSync("git", ["mktree", "--missing"], {
    cwd: partial,
    input: "100644 blob 0123456789abcdef0123456789abcdef01234567\tmissing.txt\n",
    encoding: "utf8",
  });
  assert.equal(made.status, 0, made.stderr);
  const tree = made.stdout.trim();
  const orphan = git(
    partial,
    "-c",
    "user.email=squiz@example.invalid",
    "-c",
    "user.name=Squiz",
    "commit-tree",
    tree,
    "-m",
    "a commit whose blob is missing",
  ).trim();
  const result = await gitShow.run(partial, { commit: orphan });
  assert.equal(existsSync(join(marks, "lazyfetch")), false, `a lazy fetch ran: ${result.text}`);
  ranNothing();
  // The commit resolved and show reached the blob, so the fetch was refused rather than never asked for.
  assert.equal(result.failed, true);
  assert.match(result.text, /^git exited \d+: .*0123456789abcdef0123456789abcdef01234567/su);
});

test("a tool whose signal is aborted stops git and says so", async () => {
  for (const [tool, params] of [
    [gitLogSearch, { term: "two" }],
    [gitBlame, { file: "code.txt", line: 1 }],
    [gitShow, { commit: "HEAD" }],
    [gitDiff, { path: "code.txt" }],
  ] as const) {
    const stop = new AbortController();
    stop.abort();
    const result = await tool.run(repo, params, stop.signal);
    assert.deepEqual(result, { text: "git was stopped", failed: true }, tool.name);
  }
});

test("the four tools are named as the grant names them, each with an object schema", () => {
  assert.deepEqual(
    historyTools.map((tool) => tool.name),
    ["git_log_search", "git_blame", "git_show", "git_diff"],
  );
  for (const tool of historyTools) {
    assert.equal((tool.parameters as { type: string }).type, "object");
    assert.ok(tool.description.length > 0);
  }
});

test("git_diff with no path lists each changed file with its status and its lines added and removed", async () => {
  const result = await gitDiff.run(repo, {});
  assert.equal(result.failed, false, result.text);
  assert.equal(result.text, "M  code.txt  +1 -1\nA  link.txt  +1\n");
  ranNothing();
});

test("git_diff with a path shows that file's hunks, and runs no program the repository's config names", async () => {
  const result = await gitDiff.run(repo, { path: "code.txt" });
  assert.equal(result.failed, false, result.text);
  assert.match(result.text, /^diff --git a\/code\.txt b\/code\.txt$/mu);
  assert.match(result.text, /^-three$/mu);
  assert.match(result.text, /^\+three -p$/mu);
  assert.doesNotMatch(result.text, /link\.txt/u, "a path narrows the diff to that file");
  ranNothing();
});

test("git_diff names the changed file whose diff it showed, under its name after the change, and none for a listing", async () => {
  assert.equal((await gitDiff.run(repo, { path: "code.txt" })).read, "code.txt");
  assert.equal((await gitDiff.run(repo, {})).read, undefined);
  assert.equal((await gitDiff.run(repo, { path: ".gitattributes" })).read, undefined);
});

test("git_diff shows a link's change as the link, never the file it points at", async () => {
  const result = await gitDiff.run(repo, { path: "link.txt" });
  assert.equal(result.failed, false, result.text);
  assert.match(result.text, /^new file mode 120000$/mu);
  assert.doesNotMatch(result.text, /SECRET-CONTENT/u);
});

test("git_diff says so where the path is not among the files the pull request changes", async () => {
  const result = await gitDiff.run(repo, { path: ".gitattributes" });
  assert.equal(result.failed, false, result.text);
  assert.match(result.text, /^`\.gitattributes` is not among the files this pull request changes/u);
});

test("git_diff reads no path outside the change, and none that looks like an option", async () => {
  const target = join(outside, "diffed");
  for (const path of [secret, "../outside/secret.txt", `--output=${target}`]) {
    const result = await gitDiff.run(repo, { path });
    assert.match(result.text, /is not among the files/u, path);
    assert.doesNotMatch(result.text, /SECRET-CONTENT/u);
  }
  assert.equal(existsSync(target), false, "git diff wrote where the path said");
});

test("git_diff refuses a path of the wrong shape", async () => {
  for (const params of [{ path: 7 }, { path: "" }, { path: "a\0b" }]) {
    const result = await gitDiff.run(repo, params);
    assert.equal(result.failed, true, result.text);
    assert.match(result.text, /^path must /u);
  }
});

test("git_diff shows a renamed file as a rename, named by either of its paths", async () => {
  const moved = await mkdtemp(join(root, "moved-"));
  git(moved, "init", "--quiet", "--initial-branch", "main");
  const lines = Array.from({ length: 20 }, (_, at) => `line ${at + 1}`);
  await writeFile(join(moved, "old.txt"), `${lines.join("\n")}\n`);
  const base = commit(moved, "the base");
  await rm(join(moved, "old.txt"));
  await writeFile(join(moved, "new.txt"), `${lines.join("\n")}\nline 21\n`);
  commit(moved, "the move");
  git(moved, "update-ref", BASE_REF, base);

  const listed = await gitDiff.run(moved, {});
  assert.equal(listed.text, "R  old.txt -> new.txt  +1\n");
  for (const path of ["new.txt", "old.txt"]) {
    const result = await gitDiff.run(moved, { path });
    assert.equal(result.failed, false, result.text);
    assert.match(result.text, /^rename from old\.txt$/mu, path);
    assert.match(result.text, /^\+line 21$/mu, path);
  }
});

test("a change whose list of files runs past the cap is listed whole to the harness, and cut for the reviewer", async () => {
  const many = await mkdtemp(join(root, "many-"));
  git(many, "init", "--quiet", "--initial-branch", "main");
  await writeFile(join(many, "keep.txt"), "kept\n");
  const base = commit(many, "the base");
  // 400 names of over 200 bytes each, past the 65,536 bytes a tool answers with.
  const directory = join(many, "d".repeat(100), "e".repeat(100));
  await mkdir(directory, { recursive: true });
  for (let at = 1; at <= 400; at += 1) await writeFile(join(directory, `file-${at}.txt`), `${at}\n`);
  commit(many, "four hundred files");
  git(many, "update-ref", BASE_REF, base);

  const files = await changedFiles(many);
  assert.ok(Array.isArray(files), JSON.stringify(files));
  assert.equal((files as readonly string[]).length, 400);
  const listed = await gitDiff.run(many, {});
  assert.equal(listed.failed, false, listed.text.slice(0, 200));
  assert.ok(listed.text.length < OUTPUT_CAP + 500, `the listing ran to ${listed.text.length} characters`);
  assert.match(listed.text, /cut at 65,536 bytes/u);
  const last = (files as readonly string[]).at(-1) ?? "";
  const shown = await gitDiff.run(many, { path: last });
  assert.equal(shown.failed, false, shown.text);
  assert.equal(shown.read, last);
});

test("git_diff says the snapshot names no base where it has none, rather than diffing against something else", async () => {
  const unbased = await mkdtemp(join(root, "unbased-"));
  git(unbased, "init", "--quiet", "--initial-branch", "main");
  await writeFile(join(unbased, "a.txt"), "a\n");
  commit(unbased, "only");
  const result = await gitDiff.run(unbased, {});
  assert.equal(result.failed, true);
  assert.match(result.text, /names no base/u);
});

test("changeDiff is git's three-dot diff from the base, whole, whatever the user's config says", async () => {
  const big = await mkdtemp(join(root, "whole-"));
  git(big, "init", "--quiet", "--initial-branch", "main");
  await writeFile(join(big, "keep.txt"), "kept\n");
  const base = commit(big, "the base");
  // Past the cap a tool's answer is cut at, which the harness's own read must not be.
  await writeFile(join(big, "big.txt"), ("y".repeat(99) + "\n").repeat(3000));
  commit(big, "a large change");
  git(big, "update-ref", BASE_REF, base);
  const expected = spawnSync("git", ["diff", `${base}...HEAD`], {
    cwd: big,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    maxBuffer: 16 * 1024 * 1024,
  }).stdout;

  const saved = process.env["GIT_CONFIG_GLOBAL"];
  const global = join(outside, "global-config");
  await writeFile(global, "[diff]\n\tnoprefix = true\n\trenames = false\n[color]\n\tui = always\n");
  process.env["GIT_CONFIG_GLOBAL"] = global;
  try {
    const result = await changeDiff(big);
    assert.equal(result.failed, false, result.text);
    assert.ok(result.text.length > OUTPUT_CAP, "the whole diff, not a cut one");
    assert.equal(result.text, expected);
  } finally {
    if (saved === undefined) delete process.env["GIT_CONFIG_GLOBAL"];
    else process.env["GIT_CONFIG_GLOBAL"] = saved;
  }
});

test("changeDiff runs no program the repository's config names", async () => {
  const result = await changeDiff(repo);
  assert.equal(result.failed, false, result.text);
  assert.match(result.text, /^\+three -p$/mu);
  ranNothing();
});
