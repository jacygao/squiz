/**
 * The MCP server Copilot starts to serve the three reporting calls, over
 * standard input and output in newline-delimited JSON-RPC 2.0.
 *
 * Nothing in the harness runs this. Copilot starts it by path, with the Node
 * the harness runs on, and Node strips its types and those of the modules it
 * imports. It implements as much of MCP as Copilot asks of a server that offers
 * tools and nothing else, by hand, because the harness has no runtime
 * dependencies.
 *
 * Copilot validates no call against its schema, so the report checks see the
 * arguments exactly as the model sent them, and nothing here converts one.
 *
 * Standard output is the protocol, and a line on it that is not a message
 * breaks the session. Everything else goes to standard error.
 *
 * It exits when its standard input closes. `SIGTERM` and `SIGHUP` end it by
 * Node's default, which a handler for either would replace.
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { type ReportCalls, reportCalls } from "../report-calls.ts";
import { reportFileAt, REPORTS_VARIABLE } from "../report-file.ts";

/** The variable naming the charter file, which the server hands Copilot as its instructions. */
export const CHARTER_VARIABLE = "SQUIZ_CHARTER";

/** The protocol versions this server can speak, the latest first. */
const PROTOCOL_VERSIONS: readonly string[] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type Id = string | number;

type Message = Readonly<Record<string, unknown>>;

/** A request's outcome: a result, or a JSON-RPC error. */
type Outcome =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } };

/** Where the server reads its charter and writes its reports. */
type Setting = { readonly charter: string | undefined; readonly reports: string | undefined };

/** Answer every request on standard input, and nothing else, on standard output. */
function serve(setting: Setting): void {
  const reporting = reportCalls(reportFileAt(setting.reports));
  const write = (message: Message): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  // Copilot gone is a pipe closed under a write, and nobody left to answer.
  process.stdout.on("error", () => process.exit(0));

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    const message = messageIn(line);
    if (message === undefined) return;
    const id = message["id"];
    const method = message["method"];
    // A notification is never answered, and this server sends no requests to
    // be answered itself, so a message without both an id and a method needs
    // nothing back.
    if (typeof method !== "string") {
      if (id !== undefined) warn(`a message with id ${JSON.stringify(id)} names no method`);
      return;
    }
    if (id === undefined) return;
    if (typeof id !== "string" && typeof id !== "number") {
      warn(`${method} carries an id that is neither a string nor a number`);
      return;
    }
    write({ jsonrpc: "2.0", id, ...outcomeOf(method, message["params"], reporting, setting) });
  });
  lines.on("close", () => process.exit(0));
}

/** The line read as one JSON-RPC message, or `undefined`, said on stderr, where it is none. */
function messageIn(line: string): Message | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    warn(`${PARSE_ERROR}: a line that is not JSON: ${line.slice(0, 200)}`);
    return undefined;
  }
  // MCP sends no batches, so an array is as malformed as a number.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warn(`${INVALID_REQUEST}: a line that is not one message: ${line.slice(0, 200)}`);
    return undefined;
  }
  return parsed as Message;
}

/** What one request is answered with. A throw from anything it runs is an internal error. */
function outcomeOf(method: string, params: unknown, reporting: ReportCalls, setting: Setting): Outcome {
  try {
    switch (method) {
      case "initialize":
        return initialized(params, setting.charter);
      case "ping":
        return { result: {} };
      case "tools/list":
        return {
          result: {
            tools: reporting.calls.map((call) => ({
              name: call.name,
              description: call.description,
              inputSchema: call.parameters,
            })),
          },
        };
      case "tools/call":
        return called(params, reporting);
      default:
        return { error: { code: METHOD_NOT_FOUND, message: `no method ${method}` } };
    }
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    warn(`${method} failed: ${reason}`);
    return { error: { code: INTERNAL_ERROR, message: reason } };
  }
}

/**
 * The answer to `initialize`, carrying the charter as the instructions.
 *
 * A charter named and unreadable refuses the whole session rather than serving
 * the calls to a reviewer that was never told what to review for.
 */
function initialized(params: unknown, charterPath: string | undefined): Outcome {
  const asked = fieldOf(params, "protocolVersion");
  const protocolVersion =
    typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];

  let instructions: string | undefined;
  if (charterPath !== undefined && charterPath !== "") {
    try {
      instructions = readFileSync(charterPath, "utf8");
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      warn(`the charter could not be read: ${reason}`);
      return { error: { code: INTERNAL_ERROR, message: `the charter could not be read: ${reason}` } };
    }
  }

  return {
    result: {
      protocolVersion,
      capabilities: { tools: {} },
      // The protocol requires a name and a version. Neither is the release's.
      serverInfo: { name: "squiz", version: "1" },
      ...(instructions === undefined ? {} : { instructions }),
    },
  };
}

/**
 * The answer to `tools/call`.
 *
 * A refused report is a result with `isError`, which reaches the model as the
 * call's own error so that it can make the call again. Only a tool this server
 * does not serve is a protocol error.
 */
function called(params: unknown, reporting: ReportCalls): Outcome {
  const name = fieldOf(params, "name");
  const call = reporting.calls.find((each) => each.name === name);
  if (call === undefined) {
    return { error: { code: INVALID_PARAMS, message: `no tool ${String(name)}` } };
  }
  let text: string;
  let isError = false;
  try {
    text = call.answer(fieldOf(params, "arguments")).text;
  } catch (cause) {
    text = cause instanceof Error ? cause.message : String(cause);
    isError = true;
  }
  return { result: { content: [{ type: "text", text }], ...(isError ? { isError } : {}) } };
}

function fieldOf(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Message)[field];
}

function warn(text: string): void {
  process.stderr.write(`squiz reporting server: ${text}\n`);
}

if (import.meta.main) {
  serve({ charter: process.env[CHARTER_VARIABLE], reports: process.env[REPORTS_VARIABLE] });
}
