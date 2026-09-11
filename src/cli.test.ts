import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const shim = fileURLToPath(new URL("../bin/squiz", import.meta.url));
const cliModule = new URL("./cli.ts", import.meta.url).href;
const hookModule = new URL("./hook/hook.ts", import.meta.url).href;

// Anywhere that is not the plugin. The hook is given the session's directory,
// which is not even the worktree root, so every run here starts somewhere the
// entry point cannot be reached from by a relative path.
//
// Its HEAD is detached, which is the one shape of working directory the gate
// answers without asking GitHub anything. These tests are about the binary, and
// a fixture that reached the network would be about something else.
let elsewhere = "";

before(async () => {
  elsewhere = await mkdtemp(join(tmpdir(), "squiz-elsewhere-"));
  const identity = ["-c", "user.email=squiz@example.invalid", "-c", "user.name=Squiz"];
  git(["init", "--quiet", "--initial-branch", "main"]);
  git([...identity, "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "x"]);
  git(["checkout", "--quiet", "--detach"]);
});

after(async () => {
  await rm(elsewhere, { recursive: true, force: true });
});

function git(args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd: elsewhere, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

type Run = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * Run `command` with `args` and collect everything it left behind.
 *
 * The exit code and the stream a line landed on are properties of a process,
 * and the shim is a process rather than a function: what it resolves, and
 * whether it resolves at all, cannot be observed from inside this one.
 */
async function run(
  command: string,
  args: readonly string[],
  options: { cwd: string; path?: string },
): Promise<Run> {
  return await new Promise<Run>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.path === undefined ? {} : { PATH: options.path }) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test("the shim resolves the entry point from a working directory that is not the plugin", async () => {
  const result = await run(shim, ["hook"], { cwd: elsewhere });

  assert.equal(result.code, 0, `the shim did not run: ${result.stderr}`);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("a round that finds nothing to say writes nothing", async () => {
  const result = await run(shim, ["hook"], { cwd: elsewhere });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "", "silence is what a clean review looks like");
  assert.equal(result.stdout, "", "the runtime reads the two streams differently");
});

test("the binary runs by name off PATH, through a symlink to the shim", async () => {
  // How a plugin's bin/ reaches an agent's PATH is the runtime's business, and
  // a directory of symlinks is one of the shapes it can take. `dirname $0` in
  // the shim would look for src/ beside the link.
  const directory = await mkdtemp(join(tmpdir(), "squiz-bin-"));
  try {
    await symlink(shim, join(directory, "squiz"));
    const result = await run("squiz", ["hook"], {
      cwd: elsewhere,
      // node has to stay reachable: the shim execs it.
      path: `${directory}:${process.env["PATH"] ?? ""}`,
    });

    assert.equal(result.code, 0, `squiz did not resolve or did not run: ${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a command the binary does not have is named on stderr, and still exits 0", async () => {
  const result = await run(shim, ["frobnicate"], { cwd: elsewhere });

  assert.equal(result.code, 0, "the binary is the hook entry point, and only exit 2 may block a turn");
  assert.equal(result.stderr, 'squiz: no command "frobnicate". The commands are: hook\n');
  assert.equal(result.stdout, "");
});

test("no command at all is reported the same way", async () => {
  const result = await run(shim, [], { cwd: elsewhere });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "squiz: no command. The commands are: hook\n");
  assert.equal(result.stdout, "");
});

test("a throw inside the hook body exits 0 with the failure pointer", async () => {
  // The entry point has to be under the trap, not merely near it. The fixture
  // swaps the hook body for one that throws, which is what the trap is there to
  // survive.
  const directory = await mkdtemp(join(tmpdir(), "squiz-cli-"));
  try {
    const fixture = join(directory, "throwing-hook.mjs");
    await writeFile(
      fixture,
      [
        'import { registerHooks } from "node:module";',
        "registerHooks({",
        "  load(url, context, nextLoad) {",
        `    if (url === ${JSON.stringify(hookModule)}) {`,
        "      return {",
        '        format: "module",',
        "        shortCircuit: true,",
        '        source: \'export function runHook() { throw new Error("the gate exploded"); }\',',
        "      };",
        "    }",
        "    return nextLoad(url, context);",
        "  },",
        "});",
        `await import(${JSON.stringify(cliModule)});`,
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await run(process.execPath, [fixture, "hook"], { cwd: elsewhere });

    assert.equal(result.code, 0, "a non-zero exit stops the coding agent finishing its turn");
    assert.equal(result.stderr, "squiz: the hook failed: Error: the gate exploded\n");
    assert.equal(result.stdout, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the shim is executable", async () => {
  // Tracked mode, not the mode on this disk. A shim committed without the bit
  // is on PATH and still cannot be run, and a hook whose command will not run
  // leaves the same empty transcript as a round with nothing to say.
  const result = await run("git", ["ls-files", "--stage", "--", "bin/squiz"], {
    cwd: dirname(dirname(shim)),
  });

  assert.equal(result.code, 0, `git could not report the tracked mode: ${result.stderr}`);
  assert.match(result.stdout, /^100755 /u, "bin/squiz is tracked without its execute bit");
});
