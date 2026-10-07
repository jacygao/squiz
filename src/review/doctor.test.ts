import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { standIn } from "../testing/stand-in.ts";
import { CHECKS, pathLink, squizDoctor, type Check, type DoctorContext } from "./doctor.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "squiz-653-doctor-")));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let made = 0;

const SIGNED_IN = JSON.stringify({
  hosts: { "github.com": [{ state: "success", active: true, host: "github.com", login: "ana", tokenSource: "keyring" }] },
});

/** What each fake prints, keyed by its name. A name left out has no fake, so nothing by that name is on `PATH`. */
type Fakes = Partial<Record<"git" | "gh" | "claude" | "tmux" | "herdr" | "pi" | "copilot", string>>;

// Every call but the version goes to the real git, so the reviewer's row finds the repository it runs in.
const GIT = 'if [ "$1" = "--version" ]; then echo "git version 2.51.0 (Apple Git-157)"; exit 0; fi\nexec /usr/bin/git "$@"';

const EVERY_FAKE: Fakes = {
  git: GIT,
  gh: ghAnswering(SIGNED_IN),
  claude: 'echo "2.4.1 (Claude Code)"',
  tmux: 'echo "tmux 3.7b"',
  herdr: 'echo "herdr 0.9.3"',
  pi: 'echo "0.85.1"',
};

/** A `gh` that prints its version, and answers `gh auth status --json hosts --active` with `json`. */
function ghAnswering(json: string): string {
  return [
    'if [ "$1" = "--version" ]; then echo "gh version 2.97.0 (2026-07-31)"; exit 0; fi',
    'if [ "$1 $2 $3 $4 $5" = "auth status --json hosts --active" ]; then',
    `  printf '%s\\n' '${json}'`,
    "  exit 0",
    "fi",
    'echo "unexpected: $*" >&2',
    "exit 64",
  ].join("\n");
}

/**
 * A directory holding only the fakes named, and a context whose `PATH` is that
 * directory alone, so no tool installed on this machine can answer. `HOME` is an
 * empty directory of its own, and the check runs outside any repository.
 */
function context(fakes: Fakes, overrides: Partial<DoctorContext> = {}): DoctorContext {
  made += 1;
  const bin = join(scratch, `bin-${made}`);
  const home = join(scratch, `home-${made}`);
  const outside = join(scratch, `outside-${made}`);
  for (const directory of [bin, home, outside]) mkdirSync(directory);
  for (const [name, script] of Object.entries(fakes)) standIn(bin, name, script);
  return {
    environment: { PATH: bin, HOME: home },
    directory: outside,
    nodeVersion: "24.6.0",
    boundMs: 10_000,
    platform: "darwin",
    ...overrides,
  };
}

test("every dependency present prints a line each and exits 0", () => {
  const printed = squizDoctor(context(EVERY_FAKE));

  assert.equal(
    printed.stdout,
    [
      "git 2.51.0",
      "gh 2.97.0, signed in as ana",
      "Claude Code 2.4.1",
      "Node 24.6.0",
      "tmux 3.7b",
      "Herdr 0.9.3",
      NO_LINK,
      "Reviewer pi 0.85.1, model unknown: neither .squiz.json nor pi's settings name one",
      "",
    ].join("\n"),
  );
  assert.equal(printed.stderr, "");
  assert.equal(printed.exit, 0);
});

test("nothing on PATH names every required dependency as not found and exits 1", () => {
  const printed = squizDoctor(context({}));

  assert.equal(
    printed.stdout,
    [
      "git: not found",
      "gh: not found",
      "Claude Code: not found",
      "Node 24.6.0",
      "tmux: not found. Not required: without tmux or Herdr, reviews run detached",
      "Herdr: not found. Not required: without tmux or Herdr, reviews run detached",
      NO_LINK,
      "Reviewer: the repository could not be found: git is not on PATH",
      "",
    ].join("\n"),
  );
  assert.equal(printed.exit, 1);
});

test("neither tmux nor Herdr being installed is not a failure", () => {
  const { tmux: _tmux, herdr: _herdr, ...required } = EVERY_FAKE;

  const printed = squizDoctor(context(required));

  assert.match(printed.stdout, /^tmux: not found\. Not required/mu);
  assert.match(printed.stdout, /^Herdr: not found\. Not required/mu);
  assert.equal(printed.exit, 0, "a multiplexer is optional, so its absence must not fail the check");
});

test("a gh with no login is unauthenticated, not missing", () => {
  const printed = squizDoctor(context({ ...EVERY_FAKE, gh: ghAnswering('{"hosts":{}}') }));

  assert.match(printed.stdout, /^gh 2\.97\.0: not signed in\. Run gh auth login$/mu);
  assert.doesNotMatch(printed.stdout, /gh: not found/u);
  assert.equal(printed.exit, 1);
});

test("a gh whose login GitHub refused is unauthenticated, with the host and account named", () => {
  const refused = JSON.stringify({
    hosts: {
      "github.com": [{ state: "error", error: "non-200 OK status code: 401 Unauthorized", active: true, host: "github.com", login: "ana" }],
    },
  });

  const printed = squizDoctor(context({ ...EVERY_FAKE, gh: ghAnswering(refused) }));

  assert.match(
    printed.stdout,
    /^gh 2\.97\.0: not signed in: the login ana on github\.com failed its check: non-200 OK status code: 401 Unauthorized$/mu,
  );
  assert.equal(printed.exit, 1);
});

test("a gh whose sign-in check exits non-zero says it could not be checked, and fails", () => {
  // A gh older than `auth status --json` refuses the flag rather than answering.
  const old = 'if [ "$1" = "--version" ]; then echo "gh version 2.20.0"; exit 0; fi\necho "unknown flag: --json" >&2\nexit 1';

  const printed = squizDoctor(context({ ...EVERY_FAKE, gh: old }));

  assert.match(printed.stdout, /^gh 2\.20\.0: its sign-in could not be checked: gh exited 1: unknown flag: --json$/mu);
  assert.doesNotMatch(printed.stdout, /signed in as/u);
  assert.equal(printed.exit, 1);
});

test("a gh whose sign-in check prints something other than JSON fails", () => {
  const printed = squizDoctor(context({ ...EVERY_FAKE, gh: ghAnswering("not json") }));

  assert.match(printed.stdout, /^gh 2\.97\.0: its sign-in could not be checked: gh printed something other than JSON$/mu);
  assert.equal(printed.exit, 1);
});

test("a git that runs and exits non-zero is reported as failing to run, not as missing or present", () => {
  const printed = squizDoctor(context({ ...EVERY_FAKE, git: 'echo "xcrun: error: invalid active developer path" >&2\nexit 1' }));

  assert.match(printed.stdout, /^git: could not be run: git exited 1: xcrun: error: invalid active developer path$/mu);
  assert.doesNotMatch(printed.stdout, /^git: not found/mu);
  assert.equal(printed.exit, 1);
});

test("a tool that prints no version it can read is not reported as present", () => {
  const printed = squizDoctor(context({ ...EVERY_FAKE, claude: 'echo "hello"' }));

  assert.match(printed.stdout, /^Claude Code: could not be run: claude printed no version: hello$/mu);
  assert.equal(printed.exit, 1);
});

test("a tool that does not answer within its bound is named, and fails", () => {
  const printed = squizDoctor(context({ ...EVERY_FAKE, git: "/bin/sleep 5" }, { boundMs: 300 }));

  assert.match(printed.stdout, /^git: could not be run: git did not answer within 0\.3 seconds$/mu);
  assert.equal(printed.exit, 1);
});

test("an installed tmux that fails to run is a warning, and the check still exits 0", () => {
  const printed = squizDoctor(context({ ...EVERY_FAKE, tmux: 'echo "dyld: Library not loaded" >&2\nexit 134' }));

  assert.match(printed.stdout, /^tmux: warning: could not be run: tmux exited 134: dyld: Library not loaded$/mu);
  assert.equal(printed.exit, 0);
});

test("a Node older than 24 is named as too old, with the version found", () => {
  const printed = squizDoctor(context(EVERY_FAKE, { nodeVersion: "23.6.0" }));

  assert.match(printed.stdout, /^Node 23\.6\.0: too old\. Squiz needs Node 24 or later$/mu);
  assert.equal(printed.exit, 1);
});

test("a row a later check adds prints after the others, and only a failed one changes the exit", () => {
  const warned: Check = () => ({ level: "warning", line: "Copilot: warning: its experimental features are off" });
  const failed: Check = () => ({ level: "failed", line: "pi: not found" });

  const warning = squizDoctor(context(EVERY_FAKE), [...CHECKS, warned]);
  const failure = squizDoctor(context(EVERY_FAKE), [...CHECKS, failed]);

  assert.match(warning.stdout, /\nCopilot: warning: its experimental features are off\n$/u);
  assert.equal(warning.exit, 0, "a warning never changes the exit status");
  assert.match(failure.stdout, /\npi: not found\n$/u);
  assert.equal(failure.exit, 1);
});

// Copilot as a coding agent.

const COPILOT_1_2 = 'echo "GitHub Copilot CLI 1.2.0."';

const FEATURES_OFF =
  "warning: copilot 1.2.0 has experimental features off. If Copilot writes your code, it is never woken when a review finishes. Run /experimental on in Copilot, or start it once with copilot --experimental";

/** Every line that is about Copilot as a coding agent: those naming copilot, but not the reviewer's. */
function copilotLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => /copilot/iu.test(line) && !line.startsWith("Reviewer"));
}

/** A context with `copilot` on PATH, a `COPILOT_HOME` of `copilotHome`, and its settings.json, where given, holding `settings`. */
function withCopilot(settings: string | undefined, overrides: Partial<DoctorContext> = {}, copilotHome?: string): DoctorContext {
  const base = context({ ...EVERY_FAKE, copilot: COPILOT_1_2 }, overrides);
  const environment = copilotHome === undefined ? base.environment : { ...base.environment, COPILOT_HOME: copilotHome };
  const home = copilotHome ?? join(String(base.environment.HOME), ".copilot");
  if (settings !== undefined) settingsAt(home, "settings.json", settings);
  return { ...base, environment };
}

test("copilot with experimental features on in the user's settings is an ordinary line after Claude Code's", () => {
  const printed = squizDoctor(withCopilot('// Managed by Copilot\n{"experimental": true}'));

  const lines = printed.stdout.split("\n");
  assert.equal(lines[lines.indexOf("Claude Code 2.4.1") + 1], "copilot 1.2.0, experimental features on");
  assert.equal(printed.exit, 0);
});

test("copilot with no experimental setting is a warning, and the check still exits 0", () => {
  const printed = squizDoctor(withCopilot(undefined));

  assert.ok(copilotLines(printed.stdout).includes(FEATURES_OFF), printed.stdout);
  assert.equal(printed.exit, 0, "features off is a warning, never a failure");
});

test("copilot --no-experimental's false is off", () => {
  const printed = squizDoctor(withCopilot('{"experimental": false, "model": "gpt-6-astra"}'));

  assert.ok(copilotLines(printed.stdout).includes(FEATURES_OFF), printed.stdout);
});

test("the setting is read from COPILOT_HOME where it is set, and not from ~/.copilot", () => {
  const elsewhere = join(scratch, "copilot-home-elsewhere");
  const base = withCopilot('{"experimental": true}', {}, elsewhere);
  settingsAt(String(base.environment.HOME), ".copilot/settings.json", '{"experimental": false}');

  const printed = squizDoctor(base);

  assert.ok(copilotLines(printed.stdout).includes("copilot 1.2.0, experimental features on"), printed.stdout);
});

test("a repository's .github/copilot/settings.json does not turn the features on", () => {
  const project = repository();
  settingsAt(project, ".github/copilot/settings.json", '{"experimental": true}');

  const printed = squizDoctor({ ...withCopilot(undefined), directory: project });

  assert.ok(copilotLines(printed.stdout).includes(FEATURES_OFF), printed.stdout);
  assert.ok(!copilotLines(printed.stdout).includes("copilot 1.2.0, experimental features on"));
});

test("Copilot settings that are not JSON leave the features unknown with the reason, not read as off", () => {
  const base = withCopilot("{ experimental: true");
  const file = join(String(base.environment.HOME), ".copilot", "settings.json");

  const printed = squizDoctor(base);

  const lines = copilotLines(printed.stdout);
  assert.ok(!lines.includes(FEATURES_OFF), "settings that could not be read must not read as off");
  assert.ok(
    lines.some((line) =>
      line.startsWith(`warning: copilot 1.2.0: whether experimental features are on is unknown: the user's Copilot settings ${file} are not JSON: `),
    ),
    printed.stdout,
  );
  assert.equal(printed.exit, 0);
});

test("an experimental setting that is neither true nor false is named, not read as off", () => {
  const printed = squizDoctor(withCopilot('{"experimental": "yes"}'));

  assert.ok(
    copilotLines(printed.stdout).some((line) =>
      line.startsWith('warning: copilot 1.2.0: whether experimental features are on is unknown: "experimental" is "yes" in '),
    ),
    printed.stdout,
  );
});

test("a copilot that is installed and fails to run is a warning", () => {
  const printed = squizDoctor(context({ ...EVERY_FAKE, copilot: 'echo "segfault" >&2\nexit 139' }));

  assert.deepEqual(copilotLines(printed.stdout), ["copilot: warning: could not be run: copilot exited 139: segfault"]);
  assert.equal(printed.exit, 0);
});

/** A COPILOT_HOME, which need not exist, that puts the socket path at exactly `bytes` bytes. */
function copilotHomeFor(bytes: number): string {
  // `/session-state/`, a 36-character session id, and `/squiz.sock`.
  const below = 15 + 36 + 11;
  return `/h${"o".repeat(bytes - below - 2)}`;
}

test("a socket path of 104 bytes fits on macOS, and of 105 is a warning that the extension cannot listen", () => {
  const fits = squizDoctor(withCopilot(undefined, {}, copilotHomeFor(104)));
  const over = squizDoctor(withCopilot(undefined, {}, copilotHomeFor(105)));

  assert.doesNotMatch(fits.stdout, /cannot listen/u);
  assert.ok(
    copilotLines(over.stdout).includes(
      `warning: copilot's extension cannot listen: its socket ${copilotHomeFor(105)}/session-state/<session id>/squiz.sock is 105 bytes, over the 104 macOS allows. Set COPILOT_HOME to a shorter directory`,
    ),
    over.stdout,
  );
  assert.equal(over.exit, 0);
});

test("a socket path of 108 bytes fits on Linux, and of 109 is a warning", () => {
  const fits = squizDoctor(withCopilot(undefined, { platform: "linux" }, copilotHomeFor(108)));
  const over = squizDoctor(withCopilot(undefined, { platform: "linux" }, copilotHomeFor(109)));

  assert.doesNotMatch(fits.stdout, /cannot listen/u);
  assert.match(over.stdout, /^warning: copilot's extension cannot listen: .+ is 109 bytes, over the 108 Linux allows\. /mu);
});

test("the socket path is measured in bytes, not characters", () => {
  // 104 characters, which fit, and 105 bytes, which do not.
  const home = `${copilotHomeFor(103)}é`;

  const printed = squizDoctor(withCopilot(undefined, {}, home));

  assert.match(printed.stdout, /^warning: copilot's extension cannot listen: .+ is 105 bytes, over the 104 macOS allows\. /mu);
});

test("with Claude Code missing and copilot installed, Claude Code is not required and the check exits 0", () => {
  const { claude: _claude, ...rest } = EVERY_FAKE;

  const printed = squizDoctor(context({ ...rest, copilot: COPILOT_1_2 }));

  assert.match(printed.stdout, /^Claude Code: not found\. Not required: copilot is installed, and either can be the coding agent$/mu);
  assert.equal(printed.exit, 0, printed.stdout);
});

test("with copilot both the reviewer and installed, the coding agent's row says its features and the reviewer's its model", () => {
  const base = withCopilot('{"experimental": true, "model": "gpt-6-astra"}');

  const printed = squizDoctor({ ...base, directory: repository('{"reviewer":"copilot"}') });

  assert.deepEqual(
    printed.stdout.split("\n").filter((line) => /copilot/iu.test(line) && !/cannot listen/u.test(line)),
    ["copilot 1.2.0, experimental features on", "Reviewer copilot 1.2.0, model gpt-6-astra, Copilot's default. Its sign-in is not checked"],
  );
});

// The reviewer's row.

/** A repository holding `squizJson` as its `.squiz.json`, or none where it is left out. */
function repository(squizJson?: string): string {
  made += 1;
  const root = join(scratch, `repository-${made}`);
  mkdirSync(root);
  const init = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  if (squizJson !== undefined) writeFileSync(join(root, ".squiz.json"), squizJson, "utf8");
  return root;
}

/** Write `settings` as the JSON file at `path` under `root`, making its directories. */
function settingsAt(root: string, path: string, settings: string): void {
  const file = join(root, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, settings, "utf8");
}

/** The reviewer's line, run in `directory` with `fakes` on `PATH`, and the exit. */
function reviewerRow(fakes: Fakes, directory: string, environment: NodeJS.ProcessEnv = {}): { line: string; exit: number } {
  const base = context(fakes);
  const printed = squizDoctor({ ...base, directory, environment: { ...base.environment, ...environment } });
  const line = printed.stdout.split("\n").find((row) => row.startsWith("Reviewer")) ?? "no reviewer line";
  return { line, exit: printed.exit };
}

const COPILOT = 'echo "GitHub Copilot CLI 1.0.92."\necho "Run \'copilot update\' to check for updates."';

test("with no reviewer set, the row names pi and the default model in pi's own settings", () => {
  const base = context(EVERY_FAKE);
  settingsAt(String(base.environment.HOME), ".pi/agent/settings.json", '{"defaultProvider":"deepseek","defaultModel":"deepseek-v4-pro"}');

  const printed = squizDoctor({ ...base, directory: repository() });

  assert.match(printed.stdout, /^Reviewer pi 0\.85\.1, model deepseek\/deepseek-v4-pro, pi's default$/mu);
  assert.equal(printed.exit, 0);
});

test("a model .squiz.json names is the one the row names, over pi's own default", () => {
  const base = context(EVERY_FAKE);
  settingsAt(String(base.environment.HOME), ".pi/agent/settings.json", '{"defaultProvider":"deepseek","defaultModel":"deepseek-v4-pro"}');

  const printed = squizDoctor({ ...base, directory: repository('{"reviewer":"pi","model":"openai/gpt-5-mini"}') });

  assert.match(printed.stdout, /^Reviewer pi 0\.85\.1, model openai\/gpt-5-mini, from \.squiz\.json$/mu);
});

test("pi's default is read from PI_CODING_AGENT_DIR where it is set", () => {
  const agent = join(scratch, "pi-agent-elsewhere");
  settingsAt(agent, "settings.json", '{"defaultProvider":"openrouter","defaultModel":"qwen/qwen3-coder"}');

  const row = reviewerRow(EVERY_FAKE, repository(), { PI_CODING_AGENT_DIR: agent });

  assert.equal(row.line, "Reviewer pi 0.85.1, model openrouter/qwen/qwen3-coder, pi's default");
});

test("a project's own .pi/settings.json is not read as the model, because a review does not apply it", () => {
  const project = repository();
  settingsAt(project, ".pi/settings.json", '{"defaultProvider":"openai","defaultModel":"gpt-5-mini"}');

  const row = reviewerRow(EVERY_FAKE, project);

  assert.equal(row.line, "Reviewer pi 0.85.1, model unknown: neither .squiz.json nor pi's settings name one");
});

test("pi settings that are not JSON leave the model unknown with the reason, as a warning", () => {
  const base = context(EVERY_FAKE);
  const home = String(base.environment.HOME);
  settingsAt(home, ".pi/agent/settings.json", "{ not json");

  const printed = squizDoctor({ ...base, directory: repository() });

  assert.match(
    printed.stdout,
    new RegExp(`^Reviewer pi 0\\.85\\.1: warning: model unknown: pi's settings ${home}/\\.pi/agent/settings\\.json are not JSON: .+$`, "mu"),
  );
  assert.equal(printed.exit, 0);
});

test("a pi that is not installed fails the row and names pi", () => {
  const { pi: _pi, ...rest } = EVERY_FAKE;

  const row = reviewerRow(rest, repository());

  assert.equal(row.line, "Reviewer pi: not found");
  assert.equal(row.exit, 1);
});

test("with copilot as the reviewer, the row names Copilot and its default model, and says its sign-in is not checked", () => {
  const base = context({ ...EVERY_FAKE, copilot: COPILOT });
  settingsAt(String(base.environment.HOME), ".copilot/settings.json", '// Managed by Copilot\n{"model":"gpt-6-astra"}');

  const printed = squizDoctor({ ...base, directory: repository('{"reviewer":"copilot"}') });

  assert.match(printed.stdout, /^Reviewer copilot 1\.0\.92, model gpt-6-astra, Copilot's default\. Its sign-in is not checked$/mu);
  assert.doesNotMatch(printed.stdout, /^Reviewer pi/mu);
  assert.equal(printed.exit, 0);
});

test("Copilot's default is COPILOT_MODEL where the environment sets it", () => {
  const row = reviewerRow({ ...EVERY_FAKE, copilot: COPILOT }, repository('{"reviewer":"copilot"}'), { COPILOT_MODEL: "claude-sonnet-5" });

  assert.equal(row.line, "Reviewer copilot 1.0.92, model claude-sonnet-5, Copilot's default. Its sign-in is not checked");
});

test("with copilot as the reviewer and no model anywhere, the model is unknown", () => {
  const row = reviewerRow({ ...EVERY_FAKE, copilot: COPILOT }, repository('{"reviewer":"copilot"}'));

  assert.equal(
    row.line,
    "Reviewer copilot 1.0.92, model unknown: neither .squiz.json nor Copilot's settings name one. Its sign-in is not checked",
  );
});

test("Copilot settings a round could not read fail the row, because the round would fail on them", () => {
  const base = context({ ...EVERY_FAKE, copilot: COPILOT });
  settingsAt(String(base.environment.HOME), ".copilot/settings.json", "[1, 2]");

  const printed = squizDoctor({ ...base, directory: repository('{"reviewer":"copilot"}') });

  assert.match(printed.stdout, /^Reviewer copilot 1\.0\.92: model unknown: the user's Copilot settings .+ are not an object$/mu);
  assert.equal(printed.exit, 1);
});

test("a model .squiz.json names leaves Copilot's own settings unread, as a round leaves them", () => {
  const base = context({ ...EVERY_FAKE, copilot: COPILOT });
  settingsAt(String(base.environment.HOME), ".copilot/settings.json", "[1, 2]");

  const printed = squizDoctor({ ...base, directory: repository('{"reviewer":"copilot","model":"gpt-5-mini"}') });

  assert.match(printed.stdout, /^Reviewer copilot 1\.0\.92, model gpt-5-mini, from \.squiz\.json\. Its sign-in is not checked$/mu);
  assert.equal(printed.exit, 0);
});

test("a Copilot that is not installed fails the row and names copilot, though pi is installed", () => {
  const row = reviewerRow(EVERY_FAKE, repository('{"reviewer":"copilot"}'));

  assert.equal(row.line, "Reviewer copilot: not found");
  assert.equal(row.exit, 1);
});

test("a .squiz.json the configuration refuses is reported as refused, naming the setting, and is not checked as pi", () => {
  const project = repository('{"reviewer":"claude"}');

  const row = reviewerRow(EVERY_FAKE, project);

  assert.equal(
    row.line,
    `Reviewer: .squiz.json refused: ${project}/.squiz.json: "reviewer" is "claude", but it must be "pi" or "copilot"`,
  );
  assert.equal(row.exit, 1);
});

test("a .squiz.json that is not JSON is refused, not read as no file", () => {
  const project = repository("{ reviewer: copilot");

  const row = reviewerRow(EVERY_FAKE, project);

  assert.match(row.line, new RegExp(`^Reviewer: \\.squiz\\.json refused: ${project}/\\.squiz\\.json is not valid JSON: `, "u"));
  assert.equal(row.exit, 1);
});

test("outside a repository the reviewer is the default, whatever .squiz.json sits in the directory", () => {
  const base = context(EVERY_FAKE);
  writeFileSync(join(base.directory, ".squiz.json"), '{"reviewer":"claude"}', "utf8");

  const printed = squizDoctor(base);

  assert.match(printed.stdout, /^Reviewer pi 0\.85\.1, /mu);
  assert.doesNotMatch(printed.stdout, /refused/u);
});

test("a git that cannot name the repository it runs in fails the row with its reason, rather than reading as outside one", () => {
  const refusing = [
    'if [ "$1" = "--version" ]; then echo "git version 2.51.0"; exit 0; fi',
    `echo "fatal: detected dubious ownership in repository at '$PWD'" >&2`,
    "exit 128",
  ].join("\n");
  const project = repository('{"reviewer":"copilot"}');

  const row = reviewerRow({ ...EVERY_FAKE, git: refusing, copilot: COPILOT }, project);

  assert.equal(
    row.line,
    `Reviewer: the repository could not be found: git exited 128: fatal: detected dubious ownership in repository at '${project}'`,
  );
  assert.equal(row.exit, 1);
});

test("the .squiz.json read is the one at the repository's root, from a directory below it", () => {
  const project = repository('{"reviewer":"copilot"}');
  const below = join(project, "src", "deep");
  mkdirSync(below, { recursive: true });

  const row = reviewerRow({ ...EVERY_FAKE, copilot: COPILOT }, below);

  assert.match(row.line, /^Reviewer copilot 1\.0\.92, /u);
});

// The row naming the project's pi settings a review does not use.

/** Every line of a run in `directory` that names the project's pi settings. */
function projectSettingsRows(directory: string, fakes: Fakes = EVERY_FAKE): { rows: string[]; exit: number } {
  const printed = squizDoctor({ ...context(fakes), directory });
  return { rows: printed.stdout.split("\n").filter((row) => row.startsWith("pi project settings")), exit: printed.exit };
}

test("the project's pi settings are named as unused, with the context file that still reaches the reviewer", () => {
  const project = repository();
  settingsAt(project, ".pi/settings.json", '{"defaultModel":"gpt-5-mini","retry":{"enabled":false}}');
  settingsAt(project, ".pi/SYSTEM.md", "You are a pirate.");
  settingsAt(project, ".agents/skills/deploy/SKILL.md", "# Deploy");
  settingsAt(project, "AGENTS.md", "# Agents");
  settingsAt(project, "CLAUDE.md", "# Claude");

  const { rows, exit } = projectSettingsRows(project);

  assert.deepEqual(rows, [
    "pi project settings: a review does not use .pi/settings.json (defaultModel, retry), .pi/SYSTEM.md or .agents/skills, and takes your own pi settings instead. AGENTS.md still reaches the reviewer",
  ]);
  assert.equal(exit, 0, "a setting a review overrides fails nothing");
});

test("the row prints only where pi reviews a project with settings pi would take from it", () => {
  const settings = '{"defaultModel":"gpt-5-mini"}';
  const piProject = repository();
  settingsAt(piProject, ".pi/settings.json", settings);
  const copilotProject = repository('{"reviewer":"copilot"}');
  settingsAt(copilotProject, ".pi/settings.json", settings);
  const bare = repository();
  mkdirSync(join(bare, ".pi"));
  settingsAt(bare, "AGENTS.md", "# Agents");

  assert.equal(projectSettingsRows(piProject).rows.length, 1, "the pi project's settings are named");
  assert.deepEqual(projectSettingsRows(copilotProject, { ...EVERY_FAKE, copilot: COPILOT }).rows, [], "Copilot does not read .pi/");
  assert.deepEqual(projectSettingsRows(bare).rows, [], "pi itself reads a bare .pi as nothing to trust");
  assert.deepEqual(projectSettingsRows(repository()).rows, []);
});

test("pi settings that are not JSON are named without keys, and a lone CLAUDE.md is the file that reaches the reviewer", () => {
  const project = repository();
  settingsAt(project, ".pi/settings.json", "{ not json");
  mkdirSync(join(project, ".pi", "extensions"));
  settingsAt(project, "CLAUDE.md", "# Claude");

  assert.deepEqual(projectSettingsRows(project).rows, [
    "pi project settings: a review does not use .pi/settings.json or .pi/extensions, and takes your own pi settings instead. CLAUDE.md still reaches the reviewer",
  ]);
});

test("with no context file in the project, the row names none as reaching the reviewer", () => {
  const project = repository();
  settingsAt(project, ".pi/APPEND_SYSTEM.md", "Be terse.");

  assert.deepEqual(projectSettingsRows(project).rows, [
    "pi project settings: a review does not use .pi/APPEND_SYSTEM.md, and takes your own pi settings instead",
  ]);
});

test("the row reads the repository the reviewer's row found, and git is asked for it once", () => {
  const project = repository();
  settingsAt(project, ".pi/settings.json", '{"defaultModel":"gpt-5-mini"}');
  const asked = join(project, ".git", "asked-for-the-root");
  const counting = [
    'if [ "$1" = "--version" ]; then echo "git version 2.51.0"; exit 0; fi',
    `if [ "$1" = "rev-parse" ]; then echo asked >> '${asked}'; fi`,
    'exec /usr/bin/git "$@"',
  ].join("\n");
  const below = join(project, "src");
  mkdirSync(below);

  const { rows } = projectSettingsRows(below, { ...EVERY_FAKE, git: counting });

  assert.equal(rows.length, 1);
  assert.equal(readFileSync(asked, "utf8"), "asked\n", "the root is found once, for both rows");
});

/** Every path under `root` with its size and modification time, so any write shows. */
function snapshot(root: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(root, { recursive: true, encoding: "utf8" }).sort()) {
    const stats = statSync(join(root, name));
    entries.push(`${name} ${stats.size} ${stats.mtimeMs}`);
  }
  return entries;
}

test("squiz doctor through the binary exits as its rows say and writes nothing in the repository", () => {
  const repository = join(scratch, "repository");
  mkdirSync(repository);
  const init = spawnSync("git", ["init", "--quiet", "--initial-branch", "main"], { cwd: repository, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const before = snapshot(repository);

  // The binary's shim runs `node` and `dirname` by name, so those alone are
  // linked in beside the fakes, and nothing else on this machine is reachable.
  const shimNeeds = join(scratch, "shim-needs");
  mkdirSync(shimNeeds);
  symlinkSync(process.execPath, join(shimNeeds, "node"));
  for (const tool of ["dirname", "readlink"]) symlinkSync(join("/usr/bin", tool), join(shimNeeds, tool));
  const shim = fileURLToPath(new URL("../../bin/squiz", import.meta.url));
  const run = (path: string) =>
    spawnSync(shim, ["doctor"], { cwd: repository, encoding: "utf8", env: { PATH: path, HOME: scratch } });

  const present = run(`${String(context(EVERY_FAKE).environment.PATH)}:${shimNeeds}`);
  assert.equal(present.status, 0, present.stdout + present.stderr);
  assert.match(present.stdout, /^gh 2\.97\.0, signed in as ana$/mu);

  const absent = run(shimNeeds);
  assert.equal(absent.status, 1, absent.stdout + absent.stderr);
  assert.match(absent.stdout, /^git: not found$/mu);

  assert.deepEqual(snapshot(repository), before, "squiz doctor must write nothing where it is run");
});

/** A copy of squiz's plugin layout under `root`: a manifest naming squiz, and a bin/squiz. */
function squizCopy(root: string): string {
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "squiz" }), "utf8");
  mkdirSync(join(root, "bin"), { recursive: true });
  const binary = join(root, "bin", "squiz");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return binary;
}

/** A fresh directory under the scratch space, standing in for a directory on `PATH`. */
function directoryOnPath(name: string): string {
  made += 1;
  const path = join(scratch, `${made}-${name}`);
  mkdirSync(path, { recursive: true });
  return path;
}

/** The PATH-link row for `target`, with `path` as the whole of `PATH`. */
function linkRow(target: string, path: string) {
  return pathLink(
    () => target,
    () => scratch,
  )({ environment: { PATH: path, HOME: scratch }, directory: scratch, nodeVersion: "24.6.0", boundMs: 10_000, platform: "darwin" });
}

const NO_LINK =
  "squiz link: none on PATH. Not required in Claude Code, whose own shell runs squiz; for another coding agent, run squiz init";

test("no squiz on PATH is no link, which Claude Code alone does not need, so it is not a failure", () => {
  const target = squizCopy(directoryOnPath("this-squiz"));

  assert.deepEqual(linkRow(target, directoryOnPath("empty")), { level: "present", line: NO_LINK });
});

test("this squiz's own bin/ on PATH, as Claude Code's shell has it, is not read as the link other agents need", () => {
  const target = squizCopy(directoryOnPath("this-squiz"));

  const row = linkRow(target, `${dirname(target)}:${directoryOnPath("empty")}`);

  assert.deepEqual(row, { level: "present", line: NO_LINK }, "Claude Code's own PATH says nothing about another agent's");
});

test("a link to this squiz is named, as squiz init names it", () => {
  const target = squizCopy(directoryOnPath("this-squiz"));
  const localBin = directoryOnPath("local-bin");
  symlinkSync(target, join(localBin, "squiz"));

  assert.deepEqual(linkRow(target, `${dirname(target)}:${localBin}`), {
    level: "present",
    line: `squiz link: ${join(localBin, "squiz")} already links to this squiz`,
  });
});

test("a link to another version of the same plugin-cache install is a warning saying to run squiz init", () => {
  const install = join(directoryOnPath("claude"), "plugins", "cache", "squiz-marketplace", "squiz");
  const earlier = squizCopy(join(install, "0.1.0"));
  const target = squizCopy(join(install, "0.2.0"));
  const localBin = directoryOnPath("local-bin");
  symlinkSync(earlier, join(localBin, "squiz"));

  assert.deepEqual(linkRow(target, localBin), {
    level: "warning",
    line: `squiz link: warning: ${join(localBin, "squiz")} links to ${earlier}, another version of this install. Run squiz init to move it to this one`,
  });
});

test("a link to another squiz is a warning, named with squiz init's own words", () => {
  const target = squizCopy(directoryOnPath("this-squiz"));
  const other = squizCopy(directoryOnPath("other-checkout"));
  const localBin = directoryOnPath("local-bin");
  const link = join(localBin, "squiz");
  symlinkSync(other, link);

  assert.deepEqual(linkRow(target, localBin), {
    level: "warning",
    line: `squiz link: warning: ${link} links to another squiz, ${other}. To use this one instead, remove ${link} and run squiz init again`,
  });
});

test("another squiz's own bin/ on PATH is a warning, even ahead of a link to this squiz", () => {
  const target = squizCopy(directoryOnPath("this-squiz"));
  const other = squizCopy(directoryOnPath("other-plugin"));
  const localBin = directoryOnPath("local-bin");
  symlinkSync(target, join(localBin, "squiz"));

  const row = linkRow(target, `${dirname(other)}:${localBin}`);

  assert.equal(row.level, "warning");
  assert.equal(
    row.line,
    `squiz link: warning: ${dirname(other)} is another squiz's bin/ on PATH, the way Claude Code puts an enabled plugin's there. Run squiz init by name in that session, so the link points at the squiz it uses`,
  );
});

test("something named squiz that is not squiz, or a link to nothing, is a warning", () => {
  const target = squizCopy(directoryOnPath("this-squiz"));
  const unrelated = directoryOnPath("unrelated");
  writeFileSync(join(unrelated, "squiz"), "#!/bin/sh\n", { mode: 0o755 });
  const dangling = directoryOnPath("dangling");
  symlinkSync(join(scratch, "gone", "squiz"), join(dangling, "squiz"));

  assert.deepEqual(linkRow(target, unrelated), {
    level: "warning",
    line: `squiz link: warning: ${join(unrelated, "squiz")} is not squiz, and squiz leaves it alone. Move it off PATH, then run squiz init again`,
  });
  assert.deepEqual(linkRow(target, dangling), {
    level: "warning",
    line: `squiz link: warning: ${join(dangling, "squiz")} links to ${join(scratch, "gone", "squiz")}, which does not exist. Remove ${join(dangling, "squiz")}, then run squiz init again`,
  });
});

test("squiz doctor run through squiz init's link identifies the squiz it runs as this one", () => {
  const shimNeeds = directoryOnPath("shim-needs");
  symlinkSync(process.execPath, join(shimNeeds, "node"));
  for (const tool of ["dirname", "readlink"]) symlinkSync(join("/usr/bin", tool), join(shimNeeds, tool));
  const shim = fileURLToPath(new URL("../../bin/squiz", import.meta.url));
  const fakes = String(context(EVERY_FAKE).environment.PATH);
  const run = (path: string) =>
    spawnSync("squiz", ["doctor"], { cwd: scratch, encoding: "utf8", env: { PATH: path, HOME: scratch } });

  const localBin = directoryOnPath("local-bin");
  const link = join(localBin, "squiz");
  symlinkSync(shim, link);
  const throughLink = run(`${localBin}:${fakes}:${shimNeeds}`);
  assert.equal(throughLink.status, 0, throughLink.stdout + throughLink.stderr);
  assert.match(throughLink.stdout, new RegExp(`^squiz link: ${escaped(link)} already links to this squiz$`, "mu"));

  // As Claude Code's Bash tool runs it: this checkout's own bin/ on PATH, and no link.
  const asClaudeCode = run(`${dirname(shim)}:${fakes}:${shimNeeds}`);
  assert.equal(asClaudeCode.status, 0, asClaudeCode.stdout + asClaudeCode.stderr);
  assert.match(asClaudeCode.stdout, new RegExp(`^${escaped(NO_LINK)}$`, "mu"));
});

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
