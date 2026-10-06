---
settles: "§ 4 — how the charter reaches a Copilot reviewer's system prompt"
issue: [461, 462]
recorded: 2026-10-06
versions: { copilot: 1.0.92, model: gpt-5-mini, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.92, or changes where it puts an agent's or an MCP server's instructions
---

# A custom agent puts the charter among Copilot's instructions

## Intent

- Which of three routes delivers the charter to Copilot so that it governs the
  reviewer: the reporting server's `instructions`, a custom agent chosen with
  `--agent`, or the charter ahead of the task prompt in the first message.

## Decisions

- **Deliver the charter as a custom agent in the adapter's `COPILOT_HOME`,
  chosen with `--agent squiz-reviewer`.** Copilot puts the agent's body in the
  system prompt as `<agent_instructions>`, under a preamble telling the model to
  follow them while it completes the user's task. A server's `instructions` land
  inside the `<tools>` section instead, as a `<squiz-*>` block among the notes on
  how to use each tool. All three routes held the reviewer in one run each, so
  what separates them is where the text sits, and only the agent's place is one
  Copilot presents as instructions.
- **Do not rely on the server's `instructions`.** Asked what its instructions
  said, a reviewer given the charter that way answered that there were none. The
  server can keep serving them, but the adapter names no charter to it and does
  not pass `--allow-all-mcp-server-instructions`, so the charter is not in the
  system prompt twice.
- **Keep the charter out of the first message.** It held the reviewer as well,
  but there it is the user's text, beside the task, rather than the system
  prompt `pi`'s charter is in.

## Needs your input

Nothing.

## Reference

The agent file is `<COPILOT_HOME>/agents/<name>.agent.md`:

```markdown
---
name: squiz-reviewer
description: Reviews a pull request for squiz.
---

<the charter>
```

What the system prompt carried, read from `--log-level all` with `--log-dir`:

```
<agent_instructions>
The following instructions come from the selected agent's configuration. Follow them while completing the user's task, but treat them as subordinate to the organization, safety, and runtime instructions above.

# Squiz review charter
…
```

against, for the server route:

```
You have access to several tools. Below are additional guidelines on how to use some of them effectively:
<tools>
…
</grep>
<squiz-*>
# Squiz review charter
…
</squiz-*>
```

The charter used set two rules the task prompt never repeated: every finding's
headline begins with `[PERIWINKLE]`, and the last message ends with
`Charter in force: PERIWINKLE-462`. In each run the reviewer obeyed both.

A tree's own `.github/agents/squiz-reviewer.agent.md` lost to the one in
`COPILOT_HOME`, in a git repository and outside one. A tree's agent of another
name did load in a folder Copilot did not trust, and `--agent` could select it.

`--agent` worked under `-p`, `--no-custom-instructions` and an untrusted folder.

A model provider set with `COPILOT_PROVIDER_BASE_URL` receives the whole
request, system prompt included. A local stand-in that records the request and
answers 400 shows what Copilot would send, at no cost.

## Limits

- One run of each route, on `gpt-5-mini` at `--reasoning-effort low`. That the
  server route also held the reviewer is one run, and a different model may
  treat a tool note differently.
- Precedence between the two same-named agents was read from the request sent to
  the stand-in provider, not from a run on GitHub's own routing.
