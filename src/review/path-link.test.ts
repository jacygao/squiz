import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { linkOntoPath, thisSquiz } from "./path-link.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "squiz-553-")));

// Every test hands linkOntoPath a PATH and HOME of its own, so the developer's
// own ~/.local/bin must look the same after the run as before it.
const realLink = join(homedir(), ".local", "bin", "squiz");
const realLinkBefore = describeEntry(realLink);

after(() => {
  rmSync(scratch, { recursive: true, force: true });
  assert.equal(describeEntry(realLink), realLinkBefore, "a test wrote into the real ~/.local/bin");
});

function describeEntry(path: string): string {
  try {
    const stat = lstatSync(path);
    return stat.isSymbolicLink() ? `link ${readlinkSync(path)}` : `file ${stat.ino}`;
  } catch {
    return "absent";
  }
}

let made = 0;

/** A directory under the run's scratch space, made fresh. */
function fresh(name: string): string {
  made += 1;
  const path = join(scratch, `${made}-${name}`);
  mkdirSync(path, { recursive: true });
  return path;
}

/** A copy of squiz's plugin layout: a manifest naming squiz, and a bin/squiz. */
function squizCopy(root: string): string {
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "squiz" }), "utf8");
  mkdirSync(join(root, "bin"), { recursive: true });
  const binary = join(root, "bin", "squiz");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return binary;
}

/** A home whose ~/.local/bin exists, and the squiz being linked. */
function sandbox(): { home: string; localBin: string; target: string } {
  const home = fresh("home");
  const localBin = join(home, ".local", "bin");
  mkdirSync(localBin, { recursive: true });
  const target = squizCopy(fresh("this-squiz"));
  return { home, localBin, target };
}

test("with nothing named squiz on PATH, it links ~/.local/bin/squiz to this squiz by its absolute path", () => {
  const { home, localBin, target } = sandbox();
  const link = join(localBin, "squiz");

  const printed = linkOntoPath(target, { PATH: localBin, HOME: home });

  assert.deepEqual(printed, { stdout: `squiz: linked ${link} to ${target}\n`, stderr: "", exit: 0 });
  assert.equal(readlinkSync(link), target);
  assert.ok(isAbsolute(readlinkSync(link)));
});

test("the link it makes runs the real squiz by name from a directory that is not the plugin", () => {
  const { home, localBin } = sandbox();
  const tools = fresh("tools");
  symlinkSync(process.execPath, join(tools, "node"));
  const PATH = `${localBin}:${tools}:/usr/bin:/bin`;

  linkOntoPath(thisSquiz(), { PATH, HOME: home });
  const result = spawnSync("squiz", [], { cwd: fresh("elsewhere"), env: { PATH, HOME: home }, encoding: "utf8" });

  assert.equal(result.error, undefined);
  assert.equal(result.stderr, "squiz: no command. The commands are: hook, threads, reply, status, host, review, init\n");
});

test("this squiz is the real path of bin/squiz in the checkout running the test", () => {
  assert.equal(thisSquiz(), realpathSync(fileURLToPath(new URL("../../bin/squiz", import.meta.url))));
});

test("a second run finds the link already pointing at this squiz and changes nothing", () => {
  const { home, localBin, target } = sandbox();
  const link = join(localBin, "squiz");
  linkOntoPath(target, { PATH: localBin, HOME: home });
  const before = lstatSync(link).ino;

  const printed = linkOntoPath(target, { PATH: localBin, HOME: home });

  assert.deepEqual(printed, {
    stdout: `squiz: ${link} already links to this squiz; nothing changed\n`,
    stderr: "",
    exit: 0,
  });
  assert.equal(lstatSync(link).ino, before);
});

test("a link to another squiz checkout is left in place, and named with what to do", () => {
  const { home, localBin, target } = sandbox();
  const other = squizCopy(fresh("other-checkout"));
  const link = join(localBin, "squiz");
  symlinkSync(other, link);

  const printed = linkOntoPath(target, { PATH: localBin, HOME: home });

  assert.deepEqual(printed, {
    stdout: "",
    stderr: `squiz: made no link: ${link} links to another squiz, ${other}. To use this one instead, remove ${link} and run squiz init again\n`,
    exit: 1,
  });
  assert.equal(readlinkSync(link), other);
});

test("an unrelated file named squiz on PATH is left alone, and named", () => {
  const { home, localBin, target } = sandbox();
  const elsewhere = fresh("usr-local-bin");
  const unrelated = join(elsewhere, "squiz");
  writeFileSync(unrelated, "#!/bin/sh\necho a different program\n", { mode: 0o755 });

  const printed = linkOntoPath(target, { PATH: `${elsewhere}:${localBin}`, HOME: home });

  assert.deepEqual(printed, {
    stdout: "",
    stderr: `squiz: made no link: ${unrelated} is not squiz, and squiz leaves it alone. Move it off PATH, then run squiz init again\n`,
    exit: 1,
  });
  assert.equal(existsSync(join(localBin, "squiz")), false);
});

test("an unrelated program later on PATH is not shadowed by a link ahead of it", () => {
  const { home, localBin, target } = sandbox();
  const later = fresh("later");
  writeFileSync(join(later, "squiz"), "#!/bin/sh\n", { mode: 0o755 });

  const printed = linkOntoPath(target, { PATH: `${localBin}:${later}`, HOME: home });

  assert.equal(printed.exit, 1);
  assert.equal(existsSync(join(localBin, "squiz")), false);
});

test("a link to something that is not squiz is left alone, and named with where it goes", () => {
  const { home, localBin, target } = sandbox();
  const program = join(fresh("program"), "squiz");
  writeFileSync(program, "#!/bin/sh\n", { mode: 0o755 });
  const link = join(localBin, "squiz");
  symlinkSync(program, link);

  const printed = linkOntoPath(target, { PATH: localBin, HOME: home });

  assert.equal(
    printed.stderr,
    `squiz: made no link: ${link} links to ${program}, which is not squiz, and squiz leaves it alone. Move it off PATH, then run squiz init again\n`,
  );
  assert.equal(readlinkSync(link), program);
});

test("a link whose target is gone is left alone, and named", () => {
  const { home, localBin, target } = sandbox();
  const gone = join(scratch, "gone", "bin", "squiz");
  const link = join(localBin, "squiz");
  symlinkSync(gone, link);

  const printed = linkOntoPath(target, { PATH: localBin, HOME: home });

  assert.deepEqual(printed, {
    stdout: "",
    stderr: `squiz: made no link: ${link} links to ${gone}, which does not exist. Remove ${link}, then run squiz init again\n`,
    exit: 1,
  });
  assert.equal(readlinkSync(link), gone);
});

test("a squiz in a relative PATH entry is read from the working directory, and stops the link", () => {
  const { home, localBin, target } = sandbox();
  const working = fresh("working");
  mkdirSync(join(working, "tools"));
  writeFileSync(join(working, "tools", "squiz"), "#!/bin/sh\n", { mode: 0o755 });

  const printed = linkOntoPath(target, { PATH: `${localBin}:./tools`, HOME: home }, working);

  assert.equal(printed.exit, 1);
  assert.match(printed.stderr, /tools\/squiz is not squiz/u);
  assert.equal(existsSync(join(localBin, "squiz")), false);
});

test("a squiz in the working directory is read where PATH has an empty entry, and stops the link", () => {
  const { home, localBin, target } = sandbox();
  const working = fresh("working");
  writeFileSync(join(working, "squiz"), "#!/bin/sh\n", { mode: 0o755 });

  const printed = linkOntoPath(target, { PATH: `${localBin}::/usr/bin`, HOME: home }, working);

  assert.equal(printed.exit, 1);
  assert.equal(existsSync(join(localBin, "squiz")), false);
});

test("a link to an earlier version ahead of a link to this one on PATH is moved too", () => {
  const home = fresh("home");
  const localBin = join(home, ".local", "bin");
  const homeBin = join(home, "bin");
  mkdirSync(localBin, { recursive: true });
  mkdirSync(homeBin);
  const install = join(fresh("claude"), "plugins", "cache", "squiz-marketplace", "squiz");
  const earlier = squizCopy(join(install, "0.1.0"));
  const target = squizCopy(join(install, "0.2.0"));
  symlinkSync(earlier, join(homeBin, "squiz"));
  symlinkSync(target, join(localBin, "squiz"));

  const printed = linkOntoPath(target, { PATH: `${homeBin}:${localBin}`, HOME: home });

  assert.equal(printed.exit, 0);
  assert.equal(readlinkSync(join(homeBin, "squiz")), target);
});

test("a relative link in a PATH directory reached through a symlink resolves from the directory's real place", () => {
  const { home, target } = sandbox();
  // tools/bin/squiz -> ../squiz/bin/squiz, which from tools/bin is tools/squiz/bin/squiz.
  const tools = fresh("tools");
  mkdirSync(join(tools, "bin"));
  const copy = squizCopy(join(tools, "squiz"));
  symlinkSync("../squiz/bin/squiz", join(tools, "bin", "squiz"));
  const alias = join(home, "bin");
  symlinkSync(join(tools, "bin"), alias);
  rmSync(target);
  symlinkSync(copy, target);

  const printed = linkOntoPath(realpathSync(target), { PATH: alias, HOME: home });

  assert.deepEqual(printed, {
    stdout: `squiz: ${join(alias, "squiz")} already links to this squiz; nothing changed\n`,
    stderr: "",
    exit: 0,
  });
});

test("another squiz copy's bin/ on PATH, as Claude Code puts an enabled plugin's, stops the link", () => {
  const { home, localBin, target } = sandbox();
  const copy = squizCopy(fresh("plugin-cache-copy"));

  const printed = linkOntoPath(target, { PATH: `${dirname(copy)}:${localBin}`, HOME: home });

  assert.deepEqual(printed, {
    stdout: "",
    stderr: `squiz: made no link: ${dirname(copy)} is another squiz's bin/ on PATH, the way Claude Code puts an enabled plugin's there. Run squiz init by name in that session, so the link points at the squiz it uses\n`,
    exit: 1,
  });
  assert.equal(existsSync(join(localBin, "squiz")), false);
});

test("this squiz's own bin/ on PATH is not a link other agents' shells have, so one is still made", () => {
  const { home, localBin, target } = sandbox();

  const printed = linkOntoPath(target, { PATH: `${dirname(target)}:${localBin}`, HOME: home });

  assert.equal(printed.exit, 0);
  assert.equal(readlinkSync(join(localBin, "squiz")), target);
});

test("a link to an earlier version of the same plugin-cache install is moved to this version", () => {
  const home = fresh("home");
  const localBin = join(home, ".local", "bin");
  mkdirSync(localBin, { recursive: true });
  const install = join(fresh("claude"), "plugins", "cache", "squiz-marketplace", "squiz");
  const earlier = squizCopy(join(install, "0.1.0"));
  const target = squizCopy(join(install, "0.2.0"));
  const link = join(localBin, "squiz");
  symlinkSync(earlier, link);

  const printed = linkOntoPath(target, { PATH: localBin, HOME: home });

  assert.deepEqual(printed, {
    stdout: `squiz: linked ${link} to ${target}, in place of ${earlier}, an earlier version of this install\n`,
    stderr: "",
    exit: 0,
  });
  assert.equal(readlinkSync(link), target);
});

test("an earlier version that Claude Code has since removed is moved too", () => {
  const home = fresh("home");
  const localBin = join(home, ".local", "bin");
  mkdirSync(localBin, { recursive: true });
  const install = join(fresh("claude"), "plugins", "cache", "squiz-marketplace", "squiz");
  const target = squizCopy(join(install, "0.2.0"));
  const link = join(localBin, "squiz");
  symlinkSync(join(install, "0.1.0", "bin", "squiz"), link);

  const printed = linkOntoPath(target, { PATH: localBin, HOME: home });

  assert.equal(printed.exit, 0);
  assert.equal(readlinkSync(link), target);
});

test("the same plugin installed from another marketplace is another squiz", () => {
  const home = fresh("home");
  const localBin = join(home, ".local", "bin");
  mkdirSync(localBin, { recursive: true });
  const cache = join(fresh("claude"), "plugins", "cache");
  const other = squizCopy(join(cache, "another-marketplace", "squiz", "0.1.0"));
  const target = squizCopy(join(cache, "squiz-marketplace", "squiz", "0.2.0"));
  const link = join(localBin, "squiz");
  symlinkSync(other, link);

  const printed = linkOntoPath(target, { PATH: localBin, HOME: home });

  assert.equal(printed.exit, 1);
  assert.equal(readlinkSync(link), other);
});

test("a link to this squiz behind another squiz on PATH is reported, because the other one runs", () => {
  const { home, localBin, target } = sandbox();
  symlinkSync(target, join(localBin, "squiz"));
  const ahead = fresh("ahead");
  const other = squizCopy(fresh("other-checkout"));
  symlinkSync(other, join(ahead, "squiz"));

  const printed = linkOntoPath(target, { PATH: `${ahead}:${localBin}`, HOME: home });

  assert.equal(printed.exit, 1);
  assert.match(printed.stderr, /links to another squiz/u);
});

test("with no writable directory on PATH it makes no link, creates nothing, and says which to add", () => {
  const home = fresh("home");
  const target = squizCopy(fresh("this-squiz"));
  // Writable and on PATH, but not a directory squiz puts things into.
  const shared = fresh("usr-local-bin");

  const printed = linkOntoPath(target, { PATH: shared, HOME: home });

  assert.deepEqual(printed, {
    stdout: "",
    stderr: `squiz: made no link: neither ${home}/.local/bin nor ${home}/bin is a directory on PATH that you can write to. Add ${home}/.local/bin to PATH, creating it if it does not exist, then run squiz init again\n`,
    exit: 1,
  });
  assert.equal(existsSync(join(home, ".local")), false);
  assert.equal(existsSync(join(shared, "squiz")), false);
});

test("a ~/.local/bin that is on PATH but not writable is passed over", () => {
  const { home, localBin, target } = sandbox();
  chmodSync(localBin, 0o555);
  try {
    const printed = linkOntoPath(target, { PATH: localBin, HOME: home });

    assert.equal(printed.exit, 1);
    assert.match(printed.stderr, /^squiz: made no link: neither /u);
  } finally {
    chmodSync(localBin, 0o755);
  }
});

test("~/bin takes the link where ~/.local/bin is not on PATH", () => {
  const { home, target } = sandbox();
  const homeBin = join(home, "bin");
  mkdirSync(homeBin);

  const printed = linkOntoPath(target, { PATH: homeBin, HOME: home });

  assert.equal(printed.exit, 0);
  assert.equal(readlinkSync(join(homeBin, "squiz")), target);
  assert.equal(existsSync(join(home, ".local", "bin", "squiz")), false);
});

test("~/.local/bin is chosen over ~/bin where both are on PATH, whatever their order", () => {
  const { home, localBin, target } = sandbox();
  const homeBin = join(home, "bin");
  mkdirSync(homeBin);

  linkOntoPath(target, { PATH: `${homeBin}:${localBin}`, HOME: home });

  assert.equal(readlinkSync(join(localBin, "squiz")), target);
  assert.equal(existsSync(join(homeBin, "squiz")), false);
});
