/**
 * Copilot's command line, and the tools it is granted at each depth.
 *
 * The line is one `sh -c` script, the same in a pane and with no terminal. The
 * shell reads the prompt from its file, so no newline of it reaches a Herdr
 * pane's line, and appends Copilot's usage to the report file once Copilot has
 * exited 0, because Copilot reports its usage only into a file of its own. The
 * MCP configuration is the script's `$0`, so its quotes are never the script's.
 *
 * The grant is the confinement. Copilot hides from the model every tool
 * `--available-tools` leaves out, so `--available-tools` is on every line, and
 * nothing is granted at `deep`.
 *
 * Nothing here runs a process.
 */

import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import type { Depth, Thinking } from "../../config/config.ts";
import type { CommandLine, Invocation } from "../adapter.ts";
import { REPORTS_VARIABLE } from "../report-file.ts";
import { reportingTools } from "../reporting.ts";

/** The custom agent whose instructions are the charter, which `confine` writes. */
export const AGENT_NAME = "squiz-reviewer";

/** What Copilot calls the reporting server, and so the prefix of each call's name. */
const SERVER_NAME = "squiz";

/** The reporting server, which ships beside this, by absolute path. */
export const serverFile = fileURLToPath(new URL("server.ts", import.meta.url));

/**
 * The tools Copilot is given at each depth.
 *
 * `skill` is left out, which is what keeps the tree's skills away from the
 * reviewer, since they load whether or not the folder is trusted.
 */
export const grants: Readonly<Record<Depth, readonly string[]>> = Object.freeze({
  read: Object.freeze(["view", "grep", "glob", ...reportingTools.map((call) => `${SERVER_NAME}-${call}`)]),
  deep: Object.freeze([]),
});

/** The file Copilot writes the run's usage into, in the session directory. */
export function usageFile(invocation: Invocation): string {
  return join(resolve(invocation.directory, invocation.sessionDirectory), "usage.json");
}

/**
 * Build the line for one round, for a reviewer in a pane or one with no
 * terminal.
 *
 * Throws at `deep`. The configuration refuses `deep` for Copilot before any
 * round starts, and `confine` refuses it first, so reaching this at `deep` is a
 * bug: the only line there is to build grants the reviewer what `read` does,
 * which is the adapter choosing a depth.
 */
export function argv(invocation: Invocation): CommandLine {
  if (invocation.depth !== "read") {
    throw new Error(`the Copilot adapter grants nothing at ${invocation.depth}`);
  }
  const prompt = quoted(resolve(invocation.directory, invocation.promptFile));
  const reports = resolve(invocation.directory, invocation.reportsFile);
  const usage = quoted(usageFile(invocation));
  const config = {
    mcpServers: {
      [SERVER_NAME]: {
        type: "local",
        command: process.execPath,
        args: [serverFile],
        env: { [REPORTS_VARIABLE]: reports },
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
    `--available-tools=${grants.read.join(",")}`,
    "--no-custom-instructions",
    "--disable-builtin-mcps",
    '--additional-mcp-config "$0"',
    `--reasoning-effort ${effortOf(invocation.thinking)}`,
    `--usage-output-file ${usage}`,
    // An assignment fails where its substitution does, so a missing usage file
    // appends nothing. The file is indented JSON, and the report file takes one line.
    `&& usage=$(tr -d '\\n' < ${usage})`,
    `&& printf '{"type":"usage","usage":%s}\\n' "$usage" >> ${quoted(reports)}`,
  ].join(" ");
  return {
    command: "sh",
    args: ["-c", script, JSON.stringify(config)],
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
