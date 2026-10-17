import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { standIn } from "../../testing/stand-in.ts";
import type { ThinkingAsked } from "../adapter.ts";
import { runsAt } from "./thinking.ts";

/** What pi 0.85.1 answers in RPC mode for DeepSeek V4 Pro asked for `medium`, cut to the fields read. */
const DEEPSEEK_MEDIUM = [
  '{"id":"levels","type":"response","command":"get_available_thinking_levels","success":true,"data":{"levels":["off","high","max"]}}',
  '{"id":"state","type":"response","command":"get_state","success":true,"data":{"model":{"id":"deepseek-v4-pro","provider":"deepseek"},"thinkingLevel":"high","isStreaming":false}}',
  "",
].join("\n");

type Fixture = { readonly asked: ThinkingAsked; readonly ran: string; readonly read: string };

/**
 * A tree, and a stand-in `pi` first on the path that records its working
 * directory, its arguments and what it read, then prints `answer` and exits
 * `status`.
 */
function fixture(t: TestContext, answer: string, status = 0): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "squiz-709-thinking-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tree = join(root, "tree");
  const bin = join(root, "bin");
  mkdirSync(tree);
  mkdirSync(bin);
  writeFileSync(join(root, "answer"), answer);
  const ran = join(root, "ran");
  const read = join(root, "read");
  standIn(
    bin,
    "pi",
    [
      `{ pwd; printf "%s\\n" "$@"; } > '${ran}'`,
      `cat > '${read}'`,
      `cat '${join(root, "answer")}'`,
      `[ ${status} -eq 0 ] || echo 'Error: Model "nope/nothing" not found.' >&2`,
      `exit ${status}`,
    ].join("\n"),
  );
  const asked: ThinkingAsked = {
    directory: tree,
    environment: { PATH: `${bin}:/usr/bin:/bin`, HOME: root },
    thinking: "medium",
    model: null,
    boundMs: 10_000,
  };
  return { asked, ran, read };
}

test("the level pi runs at and the levels the model offers are read from pi's own state, not taken from the level asked (#709)", (t) => {
  const { asked } = fixture(t, DEEPSEEK_MEDIUM);

  assert.deepEqual(runsAt(asked), { outcome: "known", level: "high", offered: ["off", "high", "max"] });
});

test("pi is asked in RPC mode with the round's level and model, no session and the project untrusted, and sent no prompt", (t) => {
  const { asked, ran, read } = fixture(t, DEEPSEEK_MEDIUM);

  runsAt({ ...asked, model: "deepseek/deepseek-v4-pro" });

  const [directory, ...args] = readFileSync(ran, "utf8").trimEnd().split("\n");
  assert.equal(directory, asked.directory);
  assert.deepEqual(args, [
    "--mode",
    "rpc",
    "--no-session",
    "--no-approve",
    "--no-extensions",
    "--thinking",
    "medium",
    "--model",
    "deepseek/deepseek-v4-pro",
  ]);
  const commands = readFileSync(read, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => (JSON.parse(line) as { type: string }).type);
  assert.deepEqual(commands, ["get_available_thinking_levels", "get_state"], "a prompt command would reach the model");
});

test("with no model configured, no --model reaches pi, so it reads its own default as a round does", (t) => {
  const { asked, ran } = fixture(t, DEEPSEEK_MEDIUM);

  runsAt(asked);

  assert.ok(!readFileSync(ran, "utf8").includes("--model"));
});

test("a pi that exits non-zero leaves the level unknown, with what it said", (t) => {
  const { asked } = fixture(t, "", 1);

  assert.deepEqual(runsAt(asked), { outcome: "unknown", reason: 'pi exited 1: Error: Model "nope/nothing" not found.' });
});

test("a pi that answers without its state leaves the level unknown, rather than read as the level asked", (t) => {
  const { asked } = fixture(t, "0.85.1\n");

  assert.deepEqual(runsAt(asked), { outcome: "unknown", reason: "pi did not report its thinking level" });
});

test("a level pi reports that squiz has no name for leaves the level unknown, naming it", (t) => {
  const { asked } = fixture(t, DEEPSEEK_MEDIUM.replace('"thinkingLevel":"high"', '"thinkingLevel":"ultra"'));

  assert.deepEqual(runsAt(asked), { outcome: "unknown", reason: 'pi reported the thinking level "ultra", which squiz does not know' });
});
