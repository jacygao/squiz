---
settles: "§ 4 — how a Copilot reviewer in a pane is started and how it ends"
issue: 458
recorded: 2026-10-06
versions: { copilot: 1.0.91, model: gpt-5-mini, tmux: 3.7b, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.91, or its folder-trust dialog or -p output changes
---

# `copilot -i` waits for input, and `copilot -p` in a pane exits

## Intent

- Whether `copilot -i` exits once the review is finished, or waits for input.

## Decisions

- **Run Copilot in a pane with `-p`, not `-i`.** `copilot -i` finished its task,
  replied `DONE`, and then sat at its prompt until it was signalled 77 seconds
  later. No flag ends it, and no extension can, as one ends `pi`. `copilot -p`
  in the same kind of pane printed each call and its answer as text, then its
  usage summary, and exited 0 on its own:

  ```
  ● report_finding (MCP: probe) · line: 1, severity: "low", title: "pane test"
    └ accepted: {"line":1,"severity":"low","title":"pane test"}
  DONE
  Changes    +0 -0
  AI Credits 0.08 (7s)
  Tokens     ↑ 5.3k (4.1k cached) • ↓ 220 (128 reasoning)
  Resume     copilot --resume=99b4a257-0666-4e1f-a9a2-94d9c79b14be
  ```

  A person can watch that pane and cannot type into it. The `Resume` line is the
  session a person resumes afterwards.
- **Never start `copilot -i` in a folder Copilot does not trust.** It opens a
  "Confirm folder trust" dialog before running anything, and waits there.
  Escape exits with status 1, having made no model call. `--allow-all` does not
  skip the dialog. Trusting the folder is what lets the project's hooks and MCP
  servers run, as `a-project-copilot-trusts-runs-its-hooks-and-mcp-servers.md`
  records, so the dialog cannot be answered safely either. `-p` shows no dialog.

## Needs your input

Nothing.

## Reference

`copilot -i` on SIGTERM while idle exited 0, printed the same summary, and
sent `SIGTERM` to its MCP server.

The interactive footer shows the session's credits as it goes, for example
`Session: 0.25 AIC used`.

Under `-i`, `--available-tools` warned `Unknown tool name in the tool allowlist:
"probe-report_finding"` and the tool was still granted and called. Under `-p`
no warning was printed, and the tool was listed among the tools.

## Limits

- One pane run under each of `-i` and `-p`, in tmux. Herdr was not tried.
- Whether `-p`'s text output ever pauses for input was not tested beyond these
  runs, which carried `--no-ask-user` and `--allow-all-tools`.
- The `-i` wait was watched for 77 seconds, not indefinitely.
