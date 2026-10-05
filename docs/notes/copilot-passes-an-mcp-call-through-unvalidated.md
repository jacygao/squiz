---
settles: "§ 4 — whether Copilot validates a reporting call, and so what the reporting MCP server must check itself"
issue: 458
recorded: 2026-10-06
versions: { copilot: 1.0.91, model: gpt-5-mini, node: 24.15.0, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.91, or starts validating MCP tool arguments
---

# Copilot passes an MCP call through unvalidated

## Intent

- Whether a tool an MCP server registers is validated against its JSON schema
  before it runs, as `pi` validates an extension's.

## Decisions

- **Have the reporting MCP server validate every call against its own schema,
  and refuse with `isError: true`.** Copilot validated nothing. A server whose
  schema required `title`, `severity` and `line`, with `severity` an `enum` and
  `line` an `integer`, was sent each of these unchanged, and its answer reached
  the model as a success:

  | Arguments the model sent | What the server received |
  |---|---|
  | `"severity": "critical"` | `"severity": "critical"` |
  | no `title` | no `title` |
  | `"line": "12"` | `"line": "12"`, a string |

  This contradicts § 4 Adapters, which describes a reporting call "the CLI
  validates". Under Copilot the server is the only check, and a string of digits
  is not converted to a number for it, as `pi` converts one.
- **Treat the schema the model sees as advice to the model, not a guard.** Given
  the same schema, the same model sent `"critical"` in one run and, in the next,
  replaced it with `"high"` on its own and said so. A report the reviewer
  reshaped is still accepted, so the server records the value it accepted, as
  `pi`'s extension does.

## Needs your input

Nothing.

## Reference

The server is started from `--additional-mcp-config`, as JSON or as `@<file>`:

```json
{"mcpServers":{"probe":{"type":"local","command":"node","args":["…/server.mjs"],
  "env":{"PROBE_LOG":"…"},"tools":["*"]}}}
```

Copilot opened with `server/discover`, then `initialize`,
`notifications/initialized` and `tools/list`, over newline-delimited JSON-RPC
on stdio. A call arrived as `tools/call` with `params.arguments` and a
`_meta.progressToken`.

The model sees the tool as `probe-report_finding`, which is the name
`--available-tools` and `tool.execution_start.data.toolName` use. The stream
also carries `mcpServerName` and `mcpToolName`.

A server's answer with `isError: true` reaches the model as that call's error,
prefixed with the server's name, and the stream marks it failed:

```json
{"success":false,"error":{"message":"MCP server 'probe': refused: …","code":"failure"},
 "toolTelemetry":{"properties":{"failure_category":"server_error","failure_stage":"invoke"}}}
```

That is `tool.execution_complete`. A refusal by `--deny-tool` carries `"code":
"denied"` instead, so the two can be counted apart.

The server's `env` reached it. Its stdout is the protocol, so it logs to a file.

## Limits

- One run sent the invalid arguments, and one run drew an `isError` answer.
- Only `required`, `enum` and `type` were tried. `minimum` and
  `additionalProperties: false` were in the schema and were never exercised.
