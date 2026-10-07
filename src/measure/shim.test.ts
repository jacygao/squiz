import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { shimScript } from "./shim.ts";

test("a path holding shell syntax reaches the shim as it is", () => {
  const out = join(mkdtempSync(join(tmpdir(), "measure-shim-")), "run $HOME `x` 'q'");
  mkdirSync(out);
  const real = join(out, "real cli");
  writeFileSync(real, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  chmodSync(real, 0o755);
  const shim = join(out, "cli");
  const granted = join(out, "granted.txt");
  const stream = join(out, "stream.jsonl");
  writeFileSync(shim, shimScript({ real, flags: ["--mode", "json $x"], granted, stream }));
  chmodSync(shim, 0o755);

  execFileSync(shim, ["--print", "a'b"], { env: { ...process.env, SQUIZ_ROUND: "{}" } });

  assert.equal(readFileSync(stream, "utf8"), "--mode\njson $x\n--print\na'b\n");
  assert.equal(readFileSync(granted, "utf8"), "--print\na'b\nSQUIZ_ROUND={}\n");
});
