/**
 * Copilot's command line, and the tools it is granted.
 *
 * The line is one `sh -c` script, the same in a pane and with no terminal. The
 * shell reads the prompt from its file, so no newline of it reaches a Herdr
 * pane's line, and appends Copilot's usage to the report file once Copilot has
 * exited 0, because Copilot reports its usage only into a file of its own. The
 * MCP configuration is the script's `$0`, so its quotes are never the script's.
 *
 * A configured model goes on `--model`, which refuses a model Copilot does not
 * offer before any request. `COPILOT_MODEL` set to such a model runs the round on
 * another one and exits 0, so it carries only the user's own default.
 *
 * The grant and Copilot's own path check are the confinement. Copilot hides
 * from the model every tool `--available-tools` leaves out, so
 * `--available-tools` is on every line, and no shell tool is on it. The path
 * check keeps the reading tools inside the snapshot. The history tools are the
 * reporting server's, which runs them in the snapshot its MCP `env` names.
 *
 * Nothing here runs a process.
 */

import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import type { Thinking } from "../../config/config.ts";
import type { CommandLine, Invocation } from "../adapter.ts";
import { historyTools } from "../git-tools.ts";
import { REPORTS_VARIABLE } from "../report-file.ts";
import { reportingTools } from "../reporting.ts";
import { SNAPSHOT_VARIABLE } from "./server.ts";

/** The custom agent whose instructions are the charter, which `confine` writes. */
export const AGENT_NAME = "squiz-reviewer";

/** What Copilot calls the reporting server, and so the prefix of each call's name. */
const SERVER_NAME = "squiz";

/** The reporting server, which ships beside this, by absolute path. */
export const serverFile = fileURLToPath(new URL("server.ts", import.meta.url));

/**
 * The tools Copilot is given: the reading tools, and the reporting calls and
 * history tools under the reporting server's prefix.
 *
 * `skill` is left out, which is what keeps the tree's skills away from the
 * reviewer, since they load whether or not the folder is trusted.
 */
export const grants: readonly string[] = Object.freeze([
  "view",
  "grep",
  "glob",
  ...[...reportingTools, ...historyTools.map((tool) => tool.name)].map((call) => `${SERVER_NAME}-${call}`),
]);

/** The file Copilot writes the run's usage into, in the session directory. */
export function usageFile(invocation: Invocation): string {
  return join(resolve(invocation.directory, invocation.sessionDirectory), "usage.json");
}

/** Build the line for one round, for a reviewer in a pane or one with no terminal. */
export function argv(invocation: Invocation): CommandLine {
  const prompt = quoted(resolve(invocation.directory, invocation.promptFile));
  const reports = resolve(invocation.directory, invocation.reportsFile);
  const usage = quoted(usageFile(invocation));
  const config = {
    mcpServers: {
      [SERVER_NAME]: {
        type: "local",
        command: process.execPath,
        args: [serverFile],
        env: { [REPORTS_VARIABLE]: reports, [SNAPSHOT_VARIABLE]: resolve(invocation.directory) },
        tools: ["*"],
      },
    },
  };
  const script = [
    // The `.` keeps the prompt's trailing newlines, which `$(…)` would drop, and
    // `cat` failing leaves Copilot unstarted rather than run with no prompt.
    `prompt=$(cat ${prompt} && printf .)`,
    `&& copilot -p "\${prompt%.}"`,
    `--agent ${AGENT_NAME}`,
    "--no-ask-user --allow-all-tools",
    `--available-tools=${grants.join(",")}`,
    // Copilot refuses a path outside the snapshot, symlinks resolved, except
    // in the system's temporary directory, where every snapshot is made. This
    // closes that directory, leaving the reviewer its own snapshot only.
    "--disallow-temp-dir",
    "--no-custom-instructions",
    "--disable-builtin-mcps",
    '--additional-mcp-config "$0"',
    // The model is the script's `$1`, so the shell passes it on without reading it.
    ...(invocation.model === null ? [] : ['--model "$1"']),
    `--reasoning-effort ${effortOf(invocation.thinking)}`,
    `--usage-output-file ${usage}`,
    // An assignment fails where its substitution does, so a missing usage file
    // appends nothing. The file is indented JSON, and the report file takes one line.
    `&& usage=$(tr -d '\\n' < ${usage})`,
    `&& printf '{"type":"usage","usage":%s}\\n' "$usage" >> ${quoted(reports)}`,
  ].join(" ");
  return {
    command: "sh",
    args: ["-c", script, JSON.stringify(config), ...(invocation.model === null ? [] : [invocation.model])],
    directory: invocation.directory,
    stdin: invocation.terminal === "none" ? "/dev/null" : "terminal",
    environment: {},
  };
}

function effortOf(thinking: Thinking): string {
  return thinking === "off" ? "none" : thinking;
}

/** `text` as one word to `sh`, expanding nothing. */
function quoted(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}
