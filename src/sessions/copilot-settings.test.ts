import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { defaultTokenFile, tokenSource } from "./copilot-settings.ts";

const PLANTED = "gho_planted914";

/** A home directory of the test's own, so the user's real token file is never read. */
function home(t: TestContext): string {
  const made = realpathSync(mkdtempSync(join(tmpdir(), "squiz-copilot-settings-")));
  t.after(() => rmSync(made, { recursive: true, force: true }));
  return made;
}

function plant(at: string, contents: string): string {
  const file = join(at, ".config", "squiz", "copilot-token");
  mkdirSync(join(at, ".config", "squiz"), { recursive: true });
  writeFileSync(file, contents, "utf8");
  return file;
}

test("#914: the default token file is ~/.config/squiz/copilot-token under HOME", (t) => {
  const at = home(t);
  assert.equal(defaultTokenFile({ HOME: at }), join(at, ".config", "squiz", "copilot-token"));
});

test("#914: with no copilotTokenFile, a default file holding one token is the source", (t) => {
  const at = home(t);
  const file = plant(at, `${PLANTED}\n`);
  assert.deepEqual(tokenSource(null, { HOME: at }), { source: "default", file });
});

test("#914: with no copilotTokenFile and no default file, Copilot's own login is the source, with nothing to say", (t) => {
  assert.deepEqual(tokenSource(null, { HOME: home(t) }), { source: "login" });
});

test("#914: a copilotTokenFile wins over the default file, and is not read here", (t) => {
  const at = home(t);
  plant(at, `${PLANTED}\n`);
  assert.deepEqual(tokenSource("/run/secrets/missing", { HOME: at }), { source: "named", file: "/run/secrets/missing" });
});

test("#914: a default file that cannot be used leaves Copilot's own login, with a problem naming the file and no token", (t) => {
  const at = home(t);
  for (const contents of ["", `${PLANTED} ${PLANTED}\n`]) {
    const file = plant(at, contents);
    const source = tokenSource(null, { HOME: at });
    assert.equal(source.source, "login");
    assert.ok(source.source === "login" && source.problem?.includes(file), JSON.stringify(source));
    assert.ok(!JSON.stringify(source).includes(PLANTED), JSON.stringify(source));
  }
  if (process.getuid?.() !== 0) {
    const file = plant(at, `${PLANTED}\n`);
    chmodSync(file, 0o000);
    const source = tokenSource(null, { HOME: at });
    assert.equal(source.source, "login");
    assert.match(source.source === "login" ? (source.problem ?? "") : "", /could not be read/u);
  }
});

test("#914: a default file behind a directory that cannot be searched is a problem naming it, not a missing file", (t) => {
  if (process.getuid?.() === 0) return t.skip("root searches any directory");
  const at = home(t);
  const file = plant(at, `${PLANTED}\n`);
  const directory = join(at, ".config", "squiz");
  chmodSync(directory, 0o000);
  let source;
  try {
    source = tokenSource(null, { HOME: at });
  } finally {
    chmodSync(directory, 0o755);
  }
  assert.equal(source.source, "login");
  assert.match(source.source === "login" ? (source.problem ?? "") : "", new RegExp(`^the Copilot token file ${file} could not be read: `, "u"));
});
