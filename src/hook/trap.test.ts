import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const trapModule = new URL("./trap.ts", import.meta.url).href;
const reportModule = new URL("./report.ts", import.meta.url).href;

type Run = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * Run `source` as a module in a child process and collect everything it left
 * behind.
 *
 * The exit code, the stream a line landed on and whether it arrived at all are
 * all properties of a process rather than of a function, and none of them can
 * be observed from inside the process under test. The child's stdout and stderr
 * are pipes, which is how Claude Code runs the hook, and which is the case
 * where output written but not flushed is lost.
 */
async function runInChild(source: string): Promise<Run> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-hook-"));
  try {
    const file = join(directory, "hook.mjs");
    await writeFile(file, source, "utf8");
    return await new Promise<Run>((resolve, reject) => {
      const child = spawn(process.execPath, [file]);
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * A hook whose entry point is `body`, run under the trap. `reportFailure` is in
 * scope for the fixtures that report a failure they saw coming.
 */
function hook(body: string): string {
  return [
    `import { runUnderTrap } from ${JSON.stringify(trapModule)};`,
    `import { reportFailure } from ${JSON.stringify(reportModule)};`,
    `await runUnderTrap(${body});`,
    "",
  ].join("\n");
}

test("a throw beneath the trap exits 0 and names what failed on stderr", async () => {
  const run = await runInChild(
    hook(`() => {
      throw new Error("the reviewer is not installed");
    }`),
  );

  assert.equal(run.code, 0, "a non-zero exit stops the coding agent finishing its turn");
  assert.equal(run.stderr, "squiz: the hook failed: Error: the reviewer is not installed\n");
  assert.equal(run.stdout, "", "the runtime reads the two streams differently");
});

test("a rejection the entry point awaits is trapped", async () => {
  const run = await runInChild(
    hook(`async () => {
      await Promise.reject(new TypeError("gh returned nothing"));
      return 0;
    }`),
  );

  assert.equal(run.code, 0);
  assert.equal(run.stderr, "squiz: the hook failed: TypeError: gh returned nothing\n");
  assert.equal(run.stdout, "");
});

test("a throw from a callback the entry point has stopped awaiting is trapped", async () => {
  // A try/catch around the entry point does not see this one: the throw happens
  // on a later turn of the event loop, after the call has already returned.
  const body = `() => {
      setTimeout(() => {
        throw new Error("the reviewer exited after the round did");
      }, 0);
      return 0;
    }`;

  const untrapped = await runInChild(
    `const main = ${body};\nmain();\n`,
  );
  assert.notEqual(untrapped.code, 0, "the hazard is real: Node's own default is a non-zero exit");

  const trapped = await runInChild(hook(body));
  assert.equal(trapped.code, 0);
  assert.equal(
    trapped.stderr,
    "squiz: the hook failed: Error: the reviewer exited after the round did\n",
  );
  assert.equal(trapped.stdout, "");
});

test("a rejection nobody awaited is trapped", async () => {
  const body = `() => {
      void Promise.reject(new Error("the summary comment was never posted"));
      return 0;
    }`;

  const untrapped = await runInChild(
    `const main = ${body};\nmain();\n`,
  );
  assert.notEqual(untrapped.code, 0, "the hazard is real: Node's own default is a non-zero exit");

  const trapped = await runInChild(hook(body));
  assert.equal(trapped.code, 0);
  assert.equal(
    trapped.stderr,
    "squiz: the hook failed: Error: the summary comment was never posted\n",
  );
  assert.equal(trapped.stdout, "");
});

test("a round that fails nothing writes nothing", async () => {
  const run = await runInChild(hook("() => 0"));

  assert.equal(run.code, 0);
  assert.equal(run.stderr, "", "silence is what a clean review looks like, so nothing else may use it");
  assert.equal(run.stdout, "");
});

test("a round that blocks keeps its exit 2, and no failure pointer joins its reason", async () => {
  // The other of the hook's two stderr channels. It is the round's own text, it is
  // several lines, and the trap neither writes it nor interferes with it.
  const reason = [
    "Squiz reviewed the change on this branch and left 3 comments on PR #6.",
    "",
    "  gh pr view 6 --comments",
    "",
    "Address what applies, reply on anything you disagree with, then finish.",
    "",
  ].join("\n");

  const run = await runInChild(
    hook(`() => {
      process.stderr.write(${JSON.stringify(reason)});
      return 2;
    }`),
  );

  assert.equal(run.code, 2);
  assert.equal(run.stderr, reason);
  assert.equal(run.stdout, "");
});

test("a failure the round handles itself goes out through the same one line", async () => {
  // How every later milestone reports a failure it saw coming: report, then
  // exit 0 on its own terms rather than by throwing.
  const run = await runInChild(
    hook(`() => {
      reportFailure("round 3 found 3 findings and could not post them to PR #142");
      return 0;
    }`),
  );

  assert.equal(run.code, 0);
  assert.equal(
    run.stderr,
    "squiz: round 3 found 3 findings and could not post them to PR #142\n",
  );
  assert.equal(run.stdout, "");
});

test("a pointer that cannot be written does not become a failure of its own", async () => {
  // Nothing is left to report with once stderr has gone, and a reporter that
  // threw here would take the exit code with it — turning the one failure the
  // trap exists for into the one exit a hook must never make.
  const run = await runInChild(
    hook(`async () => {
      const { closeSync } = await import("node:fs");
      closeSync(2);
      throw new Error("nowhere left to report this");
    }`),
  );

  assert.equal(run.code, 0);
  assert.equal(run.stdout, "");
});

test("the pointer arrives in full through a pipe the process does not wait for", async () => {
  // `process.exit` does not drain a pipe. On macOS a write through
  // `process.stderr` is queued rather than performed, and everything past one
  // pipe buffer — 64 KiB, measured on this machine — is lost when the process
  // goes. The fixture writes through `process.stderr` first, which is what puts
  // the descriptor in non-blocking mode, and then fails with a message far
  // larger than that buffer. A pointer that was merely queued arrives cut off.
  const size = 256 * 1024;
  const run = await runInChild(
    hook(`() => {
      process.stderr.write("");
      throw new Error("x".repeat(${size}));
    }`),
  );

  assert.equal(run.code, 0);
  assert.equal(run.stderr, `squiz: the hook failed: Error: ${"x".repeat(size)}\n`);
  assert.equal(run.stdout, "");
});
