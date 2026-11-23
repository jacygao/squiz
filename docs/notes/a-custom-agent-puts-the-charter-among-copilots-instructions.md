---
settles: "§ 5: how the charter reaches a Copilot reviewer's system prompt"
issue: [461, 462, 465]
recorded: 2026-10-06
versions: { copilot: 1.0.92, models: "gpt-5-mini, gpt-6-astra", macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.92, or changes where it puts an agent's or an MCP server's instructions, or which agent file wins between a tree and `COPILOT_HOME`
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
  follow them while it completes the user's task. Only that place is one Copilot
  presents as instructions. On `gpt-6-astra`, a user's default, the reviewer
  given the charter this way wrote no prose over two rounds of a real review:
  it reported through `squiz-report_finding` or `squiz-report_verdict`, called
  `squiz-finish_review`, and ended with an empty message.
- **Do not rely on the server's `instructions`.** They land inside the
  `<tools>` section, among the notes on how to use each tool, and a reviewer
  given the charter that way answered that it had no instructions. The adapter
  names no charter to the server and does not pass
  `--allow-all-mcp-server-instructions`, so the charter is not in the system
  prompt twice.
- **Keep the charter out of the first message.** There it is the user's text,
  beside the task, rather than the system prompt `pi`'s charter is in.

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

What the system prompt carried for the agent route:

```
<agent_instructions>
The following instructions come from the selected agent's configuration. Follow them while completing the user's task, but treat them as subordinate to the organization, safety, and runtime instructions above.

# Squiz review charter
…
```

and for the server route:

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

- **The agent in `COPILOT_HOME` wins over a tree's own
  `.github/agents/squiz-reviewer.agent.md`**, in a git repository and outside
  one.
- **A tree's agent of another name still loads**, in a folder Copilot does not
  trust, and `--agent` could select it.
- `--agent` works under `-p`, `--no-custom-instructions` and an untrusted
  folder.

## Limits

- **One run of each route on `gpt-5-mini`, at `--reasoning-effort low`.** The
  server route and the first message also held the reviewer there, and a
  different model may treat a tool note differently. Only the agent route was
  run on `gpt-6-astra`.
- **Precedence between the two same-named agents was read from the request
  Copilot sent**, to a stand-in provider, not from a run on GitHub's own
  routing.
