/**
 * Nothing under this directory may import from the rest of `src/`, so that it
 * can be lifted out whole.
 *
 * The imports are read as text rather than through a compiler, so the reading
 * errs toward refusing: a specifier it cannot resolve to a file inside this
 * directory, or a dynamic import whose argument is not a string literal, is a
 * failure.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { test } from "node:test";

const here = import.meta.dirname;

/** One import that leaves the directory, worded for the failure message. */
type Breach = { readonly file: string; readonly specifier: string };

/** Every import in `source`, a file at `file`, that reaches outside `root`. */
function breaches(root: string, file: string, source: string): readonly Breach[] {
  const found: Breach[] = [];
  const leaves = (specifier: string): void => {
    if (!staysInside(root, file, specifier)) found.push({ file, specifier });
  };

  // `import ... from`, `import type ... from` and `export ... from`, across lines.
  for (const match of source.matchAll(/\b(?:import|export)\b[^;"'`]*?\bfrom\s*(["'])(.*?)\1/gsu)) {
    leaves(match[2] ?? "");
  }
  // An import run only for its side effects.
  for (const match of source.matchAll(/\bimport\s*(["'])(.*?)\1/gu)) {
    leaves(match[2] ?? "");
  }
  // A dynamic import or a require, whose argument must be a literal to be checked at all.
  for (const match of source.matchAll(/\b(?:import|require)\s*\(\s*([^)]*?)\s*\)/gsu)) {
    const argument = match[1] ?? "";
    const literal = /^(["'`])([^"'`$]*)\1$/u.exec(argument);
    if (literal === null) found.push({ file, specifier: argument });
    else leaves(literal[2] ?? "");
  }
  return found;
}

// A builtin is no part of `src/`. Any other bare name is a package, which this
// directory may not depend on either.
function staysInside(root: string, file: string, specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  if (!specifier.startsWith(".")) return false;
  const path = relative(root, resolve(dirname(file), specifier));
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

function sourcesUnder(directory: string): readonly string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.[cm]?ts$/u.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

test("nothing under src/sessions/ imports from the rest of src/", () => {
  const files = sourcesUnder(here);
  assert.ok(files.length > 0, `no .ts file was found under ${here}`);

  const found = files.flatMap((file) => breaches(here, file, readFileSync(file, "utf8")));

  assert.deepEqual(
    found.map(({ file, specifier }) => `${relative(here, file)} imports ${specifier}`),
    [],
    "src/sessions/ must import nothing outside itself but node: builtins",
  );
});

// The quotes and the parentheses below are escaped so that this file's own
// reading does not find these examples in it.
test("every form an import takes is read", () => {
  const file = join(here, "example.ts");
  const outside = [
    "import { loadConfig } from \u0022../config/config.ts\u0022;",
    "import type { Config } from \u0022../config/config.ts\u0022;",
    "import {\n  type Config,\n} from \u0027../config/config.ts\u0027;",
    "import \u0022../config/config.ts\u0022;",
    "const config = await import\u0028\u0022../config/config.ts\u0022);",
    "export { loadConfig } from \u0022../config/config.ts\u0022;",
    "export * from \u0022../config/config.ts\u0022;",
    "export type { Config } from \u0022../config/config.ts\u0022;",
    "import { x } from \u0022./../config/config.ts\u0022;",
    "import { x } from \u0022some-package\u0022;",
    "const loaded = await import\u0028name);",
  ];
  for (const line of outside) {
    assert.equal(breaches(here, file, line).length, 1, `not read as leaving: ${line}`);
  }

  const inside = [
    "import { spawnSync } from \u0022node:child_process\u0022;",
    "import { identityOf } from \u0022./process.ts\u0022;",
    "export { identityOf } from \u0022./nested/../process.ts\u0022;",
    "const loaded = await import\u0028\u0022./process.ts\u0022);",
  ];
  for (const line of inside) {
    assert.deepEqual(breaches(here, file, line), [], `read as leaving: ${line}`);
  }
});
