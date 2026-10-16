# Adapters

An adapter is the code that knows how to drive one reviewer CLI. There are two,
for `pi` and for the GitHub Copilot CLI, and `reviewer` in [Configuration](adoption.md#configuration) chooses
between them. A further reviewer means writing a further adapter and changing
nothing else. An adapter implements four things:

| | |
|---|---|
| `argv(opts)` | Build the command line from a working directory, a charter file, a prompt, a session directory, the thinking level and the model. |
| `confine(opts)` | Put in place whatever the CLI is handed outside its command line, check what the CLI cannot be trusted to refuse, and return what to add to its environment. A CLI handed nothing returns an empty environment and writes no file. |
| `read(reports)` | Report each finding and each verdict as the run makes it, from the file the reviewer reports into, and return the run's cost where the CLI reports one, with the models the CLI reported that cost against. A run the CLI reports as failed is told apart from one that reported no findings. |
| `grants` | The tools the CLI is given, as one list in the CLI's own names: the reading tools, the reporting calls and the history tools, as [Tools](reviewer.md#tools) sets out. |

**A configured model runs the round, or the round fails at setup.** The adapter
passes it as an argument of its own, never through a shell's parsing. Where no
model is configured, the command line and the environment are exactly what they
are without the setting. A CLI that falls back to another model when handed one
it does not offer is checked in `confine` first; one that refuses such a model
before its first request is left to refuse it. Either way the round fails as a
setup problem, with no review run and nothing spent, and the reason names
`model` and its value:

```
"model" in .squiz.json is "openai/gpt-5", which is not a model pi offers; it must be a provider and model as pi --list-models lists them, such as "openai/gpt-5-mini"
```

Where a run with a configured model completed no message, the round adds the
model to the reason, because a CLI in a pane that refused the model leaves the
round nothing else to say:

```
the reviewer completed no message; "model" in .squiz.json is "gpt-5-nano", which the reviewer's CLI may not offer
```

**An adapter may ship files its CLI runs**, where reporting a finding or running a
history tool needs one:
an extension the CLI loads, or a server it starts. Each is the adapter's own, it
is named on the command line `argv` builds, and the names it registers are in
`grants`. Nothing above the adapter knows it exists. The `pi` adapter ships an
extension, and the Copilot adapter ships a server.

**Every reporting call is checked by the harness's own report checks, whatever
serves it.** They decide what a report must carry, and refuse one the harness
could not compose a comment or a mutation from. A CLI that validates a call
against its schema first, as `pi` does, may convert an argument before the checks
see it. A CLI that validates nothing, as Copilot does, hands the checks the
arguments exactly as the model sent them, so the checks are the only validation
the call gets. The schema the model is shown guides the model and guards
nothing.

**A finding reaches the harness as `read` reads it out of the report file, and
so does the run's cost.** An adapter whose CLI has no way to report a finding
before the run ends reports them all at the end, which is a working adapter whose
rounds keep nothing when they are killed.

An adapter whose CLI reports its cost only once the run is over writes the cost
into the file then. A run stopped before that writes none, and has no cost.

**A reviewer CLI must exit on `SIGTERM`, and so must every process it starts.**
That is what the time bound rests on: the round signals the reviewer's process
group and waits a grace before escalating, and a command stopped from outside
may never reach its own escalation. A CLI that ignores `SIGTERM` runs on
after the round that started it, spending against the model API with no episode
left to record it. An adapter for such a CLI is not one this harness can hold.

**The exit status does not say how a run ended.** A CLI can exit 0 when it was
stopped, as Copilot does. A run declared its review finished where the report
file holds the finish, and the round knows when it stopped a run itself, because
the stop is its own. Nothing else is read for it.

**The history tools run inside the reviewer's own group**: in the extension `pi`
loads, and in the server the Copilot adapter ships. The `git` each one starts is
in that group too, so the signal that stops the reviewer stops it. No CLI is
granted a shell, so nothing the reviewer starts leads a group of its own.

**Each adapter tells the history tools where the snapshot is**, because they run
in a process the CLI started and the round cannot pass arguments to:

| Adapter | Where the history tools find the snapshot |
|---|---|
| `pi` | The directory `pi` was started in, which is the snapshot, as for the reads the extension confines. |
| Copilot | `SQUIZ_SNAPSHOT`, the snapshot's absolute path, which the adapter puts in the `env` of the reporting server's MCP configuration (The command line, under The Copilot adapter). |

A history tool that finds no snapshot named answers with its error and runs
nothing.

## The `pi` adapter

The adapter `reviewer` chooses by default. It builds this command line:

```bash
pi --session-dir .squiz/<number>/rounds/<k>/session \
   --no-approve \
   --no-extensions --extension <reporting-extension> \
   --tools read,grep,find,ls,report_finding,report_verdict,finish_review,git_log_search,git_blame,git_show \
   --thinking medium \
   --append-system-prompt <charter-file> \
   @.squiz/<number>/rounds/<k>/prompt.md
```

**The task prompt reaches `pi` as a file.** The round writes it to
`rounds/<k>/prompt.md` before `pi` starts, and `pi` reads the file an `@`
argument names into its first message, wrapped in a tag that names the file:

```
<file name="/…/.squiz/41/rounds/2/prompt.md">
# Review pull request #41
…
</file>
```

`pi` exits 1 where the file is missing. The prompt itself has newlines, and a
Herdr pane's shell reads the line as typed, where a newline or a tab is a key,
so no argument on this line carries either.

In a pane `pi` runs interactively, with the pane as its standard input and
output. Detached, the round host adds `--print` and gives it `< /dev/null`. With
stdin inherited, `pi` in print mode blocks forever and emits nothing: no output,
no error, no exit. This holds whether or not any tool is enabled.

`--extension` names the file that registers the three reporting calls and the
three history tools, six tools in all. It ships with the adapter, and `pi`
compiles it and the modules it imports when it loads it. A reporting call
refuses a report the harness could not compose a comment or a mutation from,
and a history tool that refused its arguments or failed throws its error text.
Either way the reviewer reads it as that call's error.

The extension also subscribes the `tool_call` handler that refuses a call to a
tool outside the grant, and a read outside the snapshot, before either runs
([Confinement](reviewer.md#confinement)). The snapshot is the directory `pi` was started in.

`--no-extensions` turns off discovery, so the extension named on the command
line is the only one loaded. An extension installed on the machine or sitting in
the tree under review could otherwise register a tool under a reporting call's
name and take the round's reports.

**The adapter writes none of `pi`'s settings.** `PI_CODING_AGENT_DIR` is left
as the user has it.

`--no-approve` untrusts the tree under review, so none of its own `.pi/`
configuration reaches `pi`. Without it `pi` merges a trusted project's
`.pi/settings.json` over the user's global settings, and a trust decision saved
against any directory above the worktree trusts the worktree.

**The reviewer's reports reach the round through a file, not through `pi`'s
output.** In a pane, `pi`'s output is the screen. The extension appends one line
to `.squiz/<number>/rounds/<k>/reports.jsonl`, which `SQUIZ_REPORTS` names, for
each of these, in the order they happen:

- every report a call accepted, as the extension accepted it;
- every call it refused, with the refusal;
- every assistant message's usage, `stopReason`, `provider` and `model`, with its
  `errorMessage` where it has one;
- the finish, when `finish_review` is called;
- an unfinished end, when the agent settles with no finish recorded.

The adapter reads the file as it grows, so the round holds what the reviewer has
at every moment of the run rather than only at the end of it.

**A report is the value the call accepted.** `pi` converts an argument to the
type the schema declares before the call runs, so the arguments the model sent
and the value the call accepted can differ wherever a conversion rescued a
report. The extension records the accepted value, which is what the reviewer was
told had landed.

A round's cost is the sum of its assistant messages' usage, because cost arrives
once per message rather than once per run. `pi` prices the run itself from a
local catalogue, so a model the catalogue does not cover reports a zero cost
against a non-zero token count. The adapter returns the token count alongside the
cost, which is what tells that case apart from a round that cost nothing.

**A round's models are the ones its messages name.** Each assistant message
names its `provider` and its `model`, and the adapter writes each pair as
`provider/model`, which is how `pi --list-models` lists a model and how `model` in
Configuration names one. A message naming a model and no provider is named by
the model alone, and a blank model names none. The cost carries every model the
run named, in the order it first named each, and a run that named none carries
none. A provider or a model that is not text is a line that cannot be read.

**A round's cost is marked a floor wherever the run's end cannot confirm it as
a total.** A floor is at least what the round spent, and may be less. Three
things leave it unconfirmed:

- **The file's last line is not a message's usage.** Every run ends on an
  assistant message, so a file ending on a report, a refusal or the finish is
  still owed one. A finish proves nothing here. The closing message comes after
  it, and where the file refuses that message's usage, nothing can be written to
  say so.
- **The time bound stopped the reviewer.** A request in flight at the stop was
  spent and is never reported, whatever the file ends on.
- **A line of the file could not be read, or the file could not be read to its
  end.** A last line with no newline is such a line. What was not read may have
  been a message's usage, so the sum may be missing that spend, whatever lines
  follow it.

A round that ran the reviewer twice has a floor where either run does.

An assistant message carries a `stopReason`, and a value of `error` on one of
them does not mean the run failed: `pi` retries a failed request, so a round that
completes a review can carry errored messages among its working ones. Each
carries zero usage, and the cost sum is unaffected.

The run reached no reviewer where no assistant message carries a `stopReason` of
`stop` and no finish was recorded. The reason sits in the errored message's
`errorMessage`. The adapter reports that rather than a review it could not read,
and does not start a second run, because `pi` has already retried the request
itself.

A finished review is a review whatever the messages around it stopped for, so
the run of a completed review need carry no assistant message that stopped for
an answer.

**The extension ends the reviewer.** Interactive `pi` waits for input once its
agent settles, indefinitely, so the extension ends it two ways:

- **After `finish_review`**, it records the finish and calls `ctx.shutdown()`,
  which `pi` defers until it is idle, so the reviewer writes its closing message
  first.
- **On `agent_settled` with no finish recorded**, it records an unfinished end
  and calls `ctx.shutdown()`.

**The round is over when the reviewer's process has exited, or when the time
bound stops it.** What arrives between the finish and the exit is part of the
review: `pi` answers the calls of one message in whatever order they complete, so
a report of the message that finished the review can be answered after the call
that finished it.

**The round's time bound is the only thing that ends a run the reviewer does
not.** A reviewer that reports its review complete and then does not stop is
killed at the bound, exactly as one that reported nothing is.

**A round holding the reviewer's declaration is the review it declared, whatever
ended the run.** The declaration is read before any stop reason, on the path
where the bound ended the run as well as the path where the process exited. A
reviewer that finishes a moment before the deadline and writes its closing
message past it has reviewed, and a round that read the stop instead would keep
the findings and throw the review away.

**A line of the report file the adapter cannot read fails the round, declaration
or not.** The reviewer was told that report had landed, so a line that cannot be
read is not a review that came back one finding short. It is read as output the
adapter could not read, on both paths, so the same file comes to the same thing
whether the run stopped or hung. The reports that were read stand either way.

`pi` discovers and loads `AGENTS.md` and `CLAUDE.md` on its own, so the host
project's conventions reach the reviewer without the charter carrying them.

`--tools` sets the grant, and it filters the extension's calls the same way it
filters the built-in tools. The list above is the whole grant, as [§ 4 Tools](reviewer.md#tools) names it. A name
the grant does not carry is dropped with exit status 0 and an empty stderr, so a
grant short of a reporting call leaves the reviewer no way to report and says
nothing about it.

`--thinking` sets the reasoning effort, and is on every command line. Without it `pi` takes the level from the user's own settings, and the
review a change gets depends on the machine it ran on. A level `pi` does not
recognise is not taken silently: it warns on stderr and is otherwise ignored,
which leaves the round thinking at the level those settings hold.

**A configured model is `provider/id`, exactly as `pi --list-models` lists it**,
such as `openai/gpt-5-mini`, and it goes on the line as `--model
openai/gpt-5-mini`, after `--thinking`. With no model configured there is no
`--model`, and `pi` runs on the user's default, `defaultProvider` and
`defaultModel` in its own settings.

`pi --model` does not refuse every name it does not have. A bare name matches
any model whose name contains it, so `flash` runs on whichever model that
happens to be, and a provider with an unknown id is sent to that provider as a
model id of its own. So `confine` runs `pi --no-approve --no-extensions
--list-models` in the snapshot, with no terminal, and prepares the round only
where the configured model is one of the listed `provider/id` names, matched
exactly. A bare id that is listed under one provider is refused with its full
name in the reason. A `pi` that cannot be started, or exits non-zero listing,
fails `confine` too. `--list-models` lists only the models whose provider has a
credential, and makes no model request.

## The Copilot adapter

The adapter for the GitHub Copilot CLI, which a project chooses with
`"reviewer": "copilot"`. It grants the tools [§ 4 Tools](reviewer.md#tools) names, as The grant sets
out.

### The command line

The line the round starts is one shell line, which `argv` builds:

```bash
sh -c 'prompt=$(cat .squiz/<number>/rounds/<k>/prompt.md && printf .) \
       && copilot -p "${prompt%.}" \
         --agent squiz-reviewer \
         --no-ask-user --allow-all-tools \
         --available-tools=view,grep,glob,squiz-report_finding,squiz-report_verdict,squiz-finish_review,squiz-git_log_search,squiz-git_blame,squiz-git_show \
         --disallow-temp-dir \
         --no-custom-instructions \
         --disable-builtin-mcps \
         --additional-mcp-config "$0" \
         --model "$1" \
         --reasoning-effort medium \
         --usage-output-file .squiz/<number>/rounds/<k>/session/usage.json \
       && usage=$(tr -d "\n" < .squiz/<number>/rounds/<k>/session/usage.json) \
       && printf "{\"type\":\"usage\",\"usage\":%s}\n" "$usage" >> <reports-file>' \
  '{"mcpServers":{"squiz":{"type":"local","command":"<node>","args":["<server>"],"env":{"SQUIZ_REPORTS":"<reports-file>","SQUIZ_SNAPSHOT":"<snapshot>"},"tools":["*"]}}}' \
  gpt-5-mini
```

The line is shown wrapped. As `argv` builds it, the script is one argument with
no newline in it, every path is absolute and single-quoted inside the script,
and the MCP configuration travels as the script's `$0`, so its quotes need no
escaping inside the script. `--model "$1"` and the model after the MCP
configuration are there only where `model` is configured, and the model reaches
Copilot as the script's `$1`, which the shell passes on without reading. `<node>` is the Node the harness runs on,
`<server>` is the reporting server the adapter ships, and `<snapshot>` is the
round's snapshot, each by absolute path.

The environment adds three variables:

- `COPILOT_HOME`, pointing at the round's session directory,
  `.squiz/<number>/rounds/<k>/session/`, which `confine` creates holding the
  reviewer's agent file and nothing else;
- `COPILOT_ALLOW_ALL`, set to the empty string, which Copilot reads as off;
- `COPILOT_MODEL`, the user's default model, where the project configures no
  `model` and the user has a default.

**The task prompt is read from its file by the shell, not carried on the line.**
`-p` takes the prompt as one argument, which the shell reads with `cat` as
Copilot starts. The `.` after it keeps the prompt's trailing newlines, which a
command substitution would otherwise drop, and `${prompt%.}` takes the `.` off
again, so Copilot is handed the file's bytes exactly. The quotes keep it one
word and expand nothing inside it. Where the file cannot be read, Copilot is not
started. No newline from the prompt reaches the line a Herdr pane's shell reads.
The prompt must fit in one argument, which Linux limits to 128 KiB, and nothing
here handles a prompt longer than that.

**The charter reaches Copilot's system prompt as a custom agent's
instructions.** `confine` writes the agent file
`<COPILOT_HOME>/agents/squiz-reviewer.agent.md`, whose body is the charter:

```markdown
---
name: squiz-reviewer
description: Reviews a pull request for squiz.
---

<the charter>
```

`--agent squiz-reviewer` chooses it, and Copilot puts its body in the system
prompt as `<agent_instructions>`, under a preamble telling the model to follow
them. A tree's own agent of the same name, in `.github/agents/`, loses to the
one in `COPILOT_HOME`.

**The usage reaches the report file only where Copilot exits 0 by itself and
wrote a usage file.** The file is several lines of JSON. The first `&&` reads it
into `usage` with its newlines taken out, and fails where there is no file to
read. The second appends it as one usage line, written by one `printf`. Copilot
has stopped the reporting server by then, so nothing else is writing the file.

**Copilot runs with `-p` in a pane and detached alike.** In a pane it exits by
itself once the reviewer's last message is written. `-i` is never used: it waits at its prompt
once the work is done, and no flag or extension ends it. Detached, the round
hands the shell `/dev/null` as standard input, as it does `pi`, and Copilot
inherits it.

| Flag | What it does for the round |
|---|---|
| `--agent` | Chooses the agent whose instructions are the charter. |
| `--no-ask-user`, `--allow-all-tools` | Copilot runs to the end with nobody to answer it. `--allow-all-tools` lets the granted tools run without asking, and `-p` requires it. |
| `--available-tools` | The grant. A tool outside it is disabled, and the model is not shown it. |
| `--disallow-temp-dir` | The reading tools reach the snapshot and nothing else, as [Confinement](reviewer.md#confinement) sets out. |
| `--no-custom-instructions` | Keeps the tree's `AGENTS.md`, `.github/copilot-instructions.md` and `.github/instructions/` out of the system prompt. These load whether or not the folder is trusted. |
| `--disable-builtin-mcps` | The GitHub MCP server is not started for a reviewer that has no GitHub access of its own. |
| `--additional-mcp-config` | Starts the reporting server. |
| `--usage-output-file` | Where Copilot writes the run's usage as it exits. |
| `--model` | The configured model, only where there is one. |
| `--reasoning-effort` | The thinking level, on every command line. |

The tree's `AGENTS.md` still reaches the reviewer, by the charter's instruction
to read it, which it does with `view`.

`--reasoning-effort` takes `thinking` as it is, except that `off` is `none`.

**The reviewer runs on the configured model, or else the user's default.** A
configured `model` is Copilot's own name for it, such as `gpt-5-mini`, and goes
on `--model`. Copilot refuses a model the user cannot use there, before any
request: it exits 1, spending nothing, with `Model "<name>" from --model flag
is not available.` on stderr. `--model` wins over a `COPILOT_MODEL` in the
environment. `COPILOT_MODEL` is never used for a configured model, because
Copilot runs a round on some other model, and exits 0, when that variable names
one it does not have.

With no `model` configured the adapter passes no `--model`. Copilot keeps the
user's default as `model` in the user's own `settings.json`, under
`~/.copilot/`, or under the `COPILOT_HOME` the user set. `confine` reads that one
setting and returns it as `COPILOT_MODEL`. Nothing is written into the adapter's
`COPILOT_HOME` for it. Where the round host's own environment already carries a
`COPILOT_MODEL`, that is the user's default, and `confine` returns it in place of
the setting, so that a pane, which does not inherit the host's environment, runs
it too. A `settings.json` that is there and cannot be read, or does not hold a
JSON object, fails `confine`. Where the user has neither, the round runs on
whatever Copilot falls back to, and nothing makes sure that is a different model
from the coding agent's, as [§ 2](dependencies.md) requires.

### Keeping the project and the user out

**`COPILOT_HOME` is the adapter's own, and holds no trusted folders.** Copilot
runs a project's hooks and starts its MCP servers only in a folder it trusts,
and it trusts a folder below any folder it was told to trust, so a user who
trusted any folder above the snapshots would have trusted every one of them.
Under the adapter's `COPILOT_HOME`, Copilot trusts
nothing, and none of the tree's hooks or MCP servers runs. The reviewer still
signs in through `gh`'s login, which is not kept in `COPILOT_HOME` (Tools).
Whether a login from Copilot's own `/login` survives the change is untested.

`COPILOT_ALLOW_ALL` set to exactly `true` trusts the working directory whatever
`COPILOT_HOME` holds. Empty, it trusts nothing, so the adapter sets it to the
empty string rather than leaving whatever the round host inherited. The empty
value reaches the reviewer through a tmux window's `-e` and a Herdr tab's
`--env` as set and empty, over a server environment that carries `true`.

`-p` never opens the folder-trust dialog, so no answer to it is ever needed.
`--add-dir` is never passed, because it loads the skills and agents of the
directory it names as trusted configuration.

**Skills are kept out by the grant.** A tree's `.github/skills/` and
`.claude/skills/` load whether or not the folder is trusted. The grant leaves out
`skill`, and with it disabled no skill reaches the reviewer.

**None of the user's own Copilot configuration reaches the reviewer except its
default model, where the project configures none**: not its effort level, its hooks, its MCP servers or its skills. The harness
sets the reasoning effort on the command line every round, and the user's MCP
servers and hooks are code that would run with the round's environment.

### The grant

`--available-tools` carries the Copilot column of the grant [§ 4 Tools](reviewer.md#tools) sets out:
`view`, `grep` and `glob`, and the reporting calls and history tools under the
reporting server's `squiz-` prefix.

**No shell tool is granted.** Copilot disables every tool that
`--available-tools` leaves out and does not show it to the model, so a grant of
these names alone leaves Copilot no shell. The model is shown `grep` as `rg`.
Nothing is refused by pattern, so the run's refusals are always zero.

Copilot's own path check, with `--disallow-temp-dir`, confines the three reading
tools to the snapshot, as [Confinement](reviewer.md#confinement) sets out.

### The reporting server

**The reporting calls and the history tools are served by an MCP server the
adapter ships.** Copilot starts it from `--additional-mcp-config` and talks to
it over standard input and output, in newline-delimited JSON-RPC. Its answer to
`initialize` carries the file `SQUIZ_CHARTER` names as its `instructions`, where
that is set, and the adapter never sets it.

The server lists the three reporting calls with the schemas the report checks
declare, and answers each as `pi`'s extension does. It writes the same lines to
the report file that `SQUIZ_REPORTS` names, so the round reads the file as it
reads `pi`'s. It lists the three history tools after the reporting calls, and
runs each in the directory `SQUIZ_SNAPSHOT` names, as [§ 4 Tools](reviewer.md#tools) sets out. A call
to a tool the server does not serve is a protocol error.

**Copilot hands the server its own environment**, with the configuration's
`env` laid over it. So what the round puts on the reviewer's environment reaches
the server as it reaches Copilot, the emptied GitHub credentials among it.

**The server checks every call itself, because Copilot validates none**, as
Adapters sets out:

- a reporting call meets the report checks;
- a history tool's arguments are checked against that tool's schema before it
  runs, and a call they do not match runs nothing.

Either refusal is answered with `isError: true` and the reason as its text.
Copilot hands that to the model as the call's own error, and the model can make
the call again:

```
MCP server 'squiz': git_blame was not run: line must be an integer.
```

Nothing converts an argument first, so the value a report records is always what
the model sent. A history tool that failed, such as `git_show` given a commit the
repository does not have, is answered the same way.

**The server goes on answering while a history tool runs**, and answers each
call when it ends. A `notifications/cancelled` naming a running history tool
stops its `git`, and that call is not answered.

The server exits when its standard input closes, and on `SIGTERM` and `SIGHUP`.
Copilot sends it `SIGTERM` as it exits, and `SIGHUP` where a signal reached
Copilot's own pid rather than its group.

### How the run ends and is read back

**Copilot exits by itself whether or not the reviewer finished its review.** The
finish in the report file is what says it did. A run that exits with no finish
recorded is a review that stopped without finishing, as [§ 7](failure-modes.md) sets out, unless it
reached no model at all.

**The shell records what the run spent once Copilot has exited 0.** It appends
the usage file Copilot wrote to the report file, whole, as one usage line:

```json
{"type":"usage","usage":{"totalNanoAiu":535970000,"modelMetrics":{"gpt-5-mini":{"requests":{"count":5,"cost":0},"usage":{"inputTokens":60586,"outputTokens":521,"cacheReadTokens":48128,"cacheWriteTokens":0,"reasoningTokens":64}}}, …}}
```

The adapter's read takes four things from that line:

| Figure | Read as |
|---|---|
| Tokens | The sum, over every model in `modelMetrics`, of `inputTokens` and `outputTokens`. `inputTokens` already holds cache reads and cache writes. |
| AI credits | `totalNanoAiu`, at 10⁹ to a credit. |
| Messages | The sum, over every model, of `requests.count`. |
| Models | Each model in `modelMetrics` whose name is not blank and whose `requests.count` is a number above zero, in the order the file lists them. |

A Copilot round has no dollar figure. AI credits are shown where `totalNanoAiu`
is there. A usage line with no model in `modelMetrics`, or with a model that
lacks `inputTokens` or `outputTokens`, reports no usable cost: the round records
no cost for it, and reads the rest of the line as the table below does.

Where Copilot could not be started at all, the shell exits 127 having written
nothing to the report file, and its stderr says `copilot` was not found.
Detached, the round adds that stderr to the reason, as it does for any reviewer
whose run completed no message. In a pane, stderr is the screen, and the reason
names no cause. A run whose model provider refused it exits 1, with the provider's
message on stderr, so it too is read as completing no message, and so is a run
whose configured model Copilot refused.

**What the read concludes:**

| The file holds | The run |
|---|---|
| A finish | Reviewed |
| No finish, and a usage line counting at least one request | Stopped without finishing |
| No finish, and no usage line or one counting no request | Completed no message |

**A Copilot round records a cost only where Copilot ended by itself and its
usage line carried token counts.** That cost is Copilot's own total, and is never
marked a floor. A round with no usage line, one whose line carried no token
counts, and one the round stopped all record no cost: not a floor, and not a
figure. Such a round names no model either, because the usage line is the only
place a Copilot run names one.

### Stopping

**`sh` leads the reviewer's group.** It is the tmux window's command, the
program Herdr's gate becomes, and the child the round host starts detached.
Copilot is its child, and the reporting server is Copilot's, all in that group.
Nothing on the line traps a signal.

The round stops a Copilot reviewer as it stops any other: `SIGTERM` to that
group, then `SIGKILL` after the grace for whatever is left.

- **`sh` exits on `SIGTERM`**, which it does not trap, so the append after `&&`
  never runs.
- **Copilot exits on `SIGTERM` at once, and exits 0.** It writes its usage file
  and stops the reporting server as it goes. Nothing reads that file.
- **The reporting server exits on the `SIGTERM` that reaches the group.**
- **After `SIGKILL` nothing is written**, by Copilot or by `sh`.

So a round the round stopped, either way, leaves no usage line, and records no
cost.

**Nothing Copilot starts leaves the group.** Copilot starts no shell, and the
`git` a history tool runs is the reporting server's child, so the signal to the
group reaches it.

### Resuming

Copilot keeps its session under `COPILOT_HOME`, in
`session-state/<session id>/`. The adapter reads the session's
identifier from there, and the round writes the command that resumes it to
`resume.txt`:

```
COPILOT_HOME=.squiz/41/rounds/2/session copilot --resume=99b4a257-0666-4e1f-a9a2-94d9c79b14be
```
