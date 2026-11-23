---
settles: "§ 5 Adapters: what the reporting server must check of each call under Copilot"
issue: 458
recorded: 2026-10-06
versions: { copilot: 1.0.91, model: gpt-5-mini, node: 24.15.0, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.91, or starts validating MCP tool arguments
---

# Copilot passes an MCP call through unvalidated

## Intent

- Whether Copilot validates a call to an MCP server's tool against the tool's
  JSON schema before it runs, as `pi` validates an extension's.

## Decisions

- **Have the reporting server validate every call against its own schema, and
  refuse a bad one with `isError: true`.** Copilot validated nothing. A server
  whose schema required `title`, `severity` and `line`, with `severity` an
  `enum` and `line` an `integer`, received `"severity": "critical"`, a call with
  no `title`, and `"line": "12"` exactly as the model sent them, and its answer
  reached the model as a success. A string of digits is not converted to a
  number, as `pi` converts one.
- **Treat the schema the model sees as advice to the model, not a guard, and
  record the value the server accepted.** Given the same schema, the same model
  sent `"critical"` in one run and, in the next, replaced it with `"high"` on
  its own and said so.

## Needs your input

Nothing.

## Reference

The server is started from `--additional-mcp-config`, as JSON or as `@<file>`:

```json
{"mcpServers":{"squiz":{"type":"local","command":"node","args":["…/server.ts"],
  "env":{"…":"…"},"tools":["*"]}}}
```

The `env` reaches the server. Its stdout is the protocol, so it logs to a file.

Copilot speaks newline-delimited JSON-RPC on stdio, opening with
`server/discover`, then `initialize`, `notifications/initialized` and
`tools/list`. A call arrives as `tools/call` with `params.arguments` and a
`_meta.progressToken`.

The model sees a tool as `<server>-<tool>`, such as `squiz-report_finding`.
That is the name `--available-tools` and `tool.execution_start.data.toolName`
use. The stream also carries `mcpServerName` and `mcpToolName`.

An answer with `isError: true` reaches the model as that call's error, prefixed
with the server's name, and `tool.execution_complete` marks it failed:

```json
{"success":false,"error":{"message":"MCP server 'probe': refused: …","code":"failure"},
 "toolTelemetry":{"properties":{"failure_category":"server_error","failure_stage":"invoke"}}}
```

## Limits

- One run sent the invalid arguments, and one drew an `isError` answer.
- Only `required`, `enum` and `type` were tried. `minimum` and
  `additionalProperties: false` were in the schema and never exercised.
