# Requirements of the review harness spec

This is the working list for rewriting `docs/specs/review-harness-spec.md` one H2 per pull request, and it is deleted when the rewrite ends. Each line cites the spec lines it comes from, and `also` names the lines that state it again, which the rewrite removes.

## 1. Purpose

### 1.0 Preamble

- **R1.0.1** When a coding agent finishes a piece of work, a reviewer agent reviews it; the reviewer may run a different model and a different harness from the coding agent. (L7–10)
- **R1.0.2** The two agents work the findings over as many rounds as it takes, and everything they say to each other is kept as review comments on the pull request. (L10–13)

## 2. Dependencies

### 2.0 Preamble

- **R2.0.1** The GitHub venue needs `git` and a signed-in `gh`. (L19–20, L24)
- **R2.0.2** The runtime that runs the coding agent, and starts a review when it finishes, is Claude Code or GitHub Copilot CLI. (L25; also L736–778, L3620)
- **R2.0.3** The reviewer is `pi` or GitHub Copilot CLI, and only the one the `reviewer` setting names has to be installed. (L26)

### 2.1 GitHub access

- **R2.1.1** Squiz reads a pull request's description, base and head refs and their commits, its review threads with whether each is resolved, and its issue-level comments with whether each is hidden. (L36–38, L46)
- **R2.1.2** Squiz posts review comments anchored to a file and line, review comments on a file as a whole with no line, and replies inside an existing review thread. (L39–41)
- **R2.1.3** Squiz resolves review threads and re-opens them. (L42; also L1396)
- **R2.1.4** Squiz posts issue-level comments on the pull request for the summary, for a failed round, and for a finding about the change as a whole and each reply to it. (L43–45; also L1398)

### 2.2 Identity

- **R2.2.1** Every comment is posted with the credentials `gh` holds, so the reviewer, the coding agent and the harness all post as the one account `gh` authenticated. (L55–57)
- **R2.2.2** Each comment's first line opens a bold span with its author's marker: reviewer `**Squiz reviewer · `, coding agent `**Squiz coding agent`, harness at close `**Squiz review — `, harness on a failed round `**Squiz review failed — `. (L59–68; also L1589–1590, L2588, L2598, L2722, L2928, L3182, L3186, L3833, L3847)
- **R2.2.3** A comment carrying none of those markers is read as written by a person. (L70; also L3099–3100)

## 3. The loop

### 3.0 Preamble

No requirement of its own after merging. Its lines are cited under R3.5.1, R7.2.1.

### 3.1 Terminology

- **R3.1.1** An episode is one review of one pull request in one worktree, from first round to close; a worktree holds one live episode at a time and keeps the episodes before it. (L88; also L1169)
- **R3.1.2** An episode is live until its close is recorded; neither whether a round is running nor elapsed time makes it live or over. (L91–93)
- **R3.1.3** An episode closes for one of three reasons: nothing is left open, the round cap is spent, or a round reached the token bound. (L93–94)
- **R3.1.4** A failed round closes nothing: it posts a failure comment (§ 8) and the episode stays live. (L94–96; also L3818ff)
- **R3.1.5** A close is clean where its round left nothing open and no state behind it not reviewed; every other close is at the round cap or token bound and stays closed. (L98–102; also L446–451)

### 3.2 The state file

- **R3.2.1** An episode's state lives in `.squiz/<number>/` inside the worktree, keyed by the pull request's number. (L106–108; also L1394)
- **R3.2.2** Each round's files are under `.squiz/<number>/rounds/<k>/`: the reviewer's task prompt `prompt.md`, its session, `resume.txt`, and, in a headless run, `handoff.md`, `update.md` and `fixer.log`. (L110–119; also L783, L934, L1821, L3450, L3463)
- **R3.2.3** The episode directory also holds `notes/` (notes for the owning sessions), `host.log` (the round host's output), and, in a headless run, `closed.json` once closed and `stopped.json` while stopped short of the close. (L120–124)
- **R3.2.4** Wherever squiz makes an episode directory and `.squiz/.gitignore` is missing, it writes one holding `*`; an existing one is left as it is. (L130–132; also L1394, L1405, L4117–4119)
- **R3.2.5** A reviewed state of the pull request is its head commit plus the latest activity on the reviewer's threads: the newest reply, by anyone other than the reviewer, on a thread the reviewer opened. Replies on a thread a person opened are no activity; editing a reply changes nothing; deleting one can change the newest, which counts as a change. (L145–156; also L1599–1602, L3423, L4285)
- **R3.2.6** Each state's record has one of five statuses: Queued, Reviewing, Reviewed (exit status and open threads; or *reviewed clean, episode open*), Failed (with why), Not reviewed (with why: closed first, or superseded). (L163–171; also § 7 `squiz status`, L3407ff)
- **R3.2.7** A state file missing a field its writer always writes cannot be read, and the reason names the field, e.g. `/work/squiz/.squiz/41/state.json: round 1 has "raised" as undefined`. (L176–184; also L3483, L3784)
- **R3.2.8** A trigger acts on the pull request's current state by its record: no record queues it and starts a round host if none runs; Queued starts a round host if none runs; Reviewing by a live host does nothing; Reviewing by a gone host recovers the round as failed and then acts as for Failed; Reviewed or Not reviewed queues nothing and `squiz review` returns that result with the threads as they stand now. (L190–207)
- **R3.2.9** Where a reviewing record's round host cannot be told running or gone, the trigger recovers, queues and starts nothing; `squiz review` exits 1 naming the host it could not check, and a hook returns. (L200–204; also L3781, L3427)
- **R3.2.10** A failed state is retried only by `squiz review`, never by a hook; the retry is queued behind every state already queued or recorded. (L192–193, L211–215)
- **R3.2.11** A retry that fails again posts its failure comment, exits 1, writes no second note to the owner, and its stderr tells the coding agent not to run the command again. (L215–217; also § 7 `squiz review`)
- **R3.2.12** One state gets one review: repeated triggers for a state already queued or under review post one set of threads and at most one summary. (L219–221; also L3082)
- **R3.2.13** An episode runs one round at a time, oldest queued state first. (L221–222; also L469)
- **R3.2.14** A queued state is never dropped: it is reviewed or given a result of its own. (L224–225)
- **R3.2.15** Where state A's round leaves threads open with rounds remaining, the queued state B is reviewed next. (L230)
- **R3.2.16** Where A's round leaves nothing open with rounds remaining and B is queued, the episode does not close: A gets no exit status, no summary and no owner note, B is reviewed next, and the episode closes from the last round with nothing queued behind it. A `squiz review` waiting on A keeps waiting and returns the final state's result (0 or 3 with the close, 2 where B left threads open), or exits 4 when its wait runs out. (L231; also L3127, L3276–3282)
- **R3.2.17** Where A's round reaches the round cap or token bound with B queued, the episode closes and posts its summary, whose Notes name the cap or bound and each state left not reviewed; B is recorded not reviewed; a `squiz review` waiting on B exits 3 with a line saying why; B's owner gets a note saying the same. (L232; also L2915–2922, L3131–3136, L3236–3246)
- **R3.2.18** A state left not reviewed is named by its short head commit, followed by "with different replies" where the state the closing round reviewed, or one queued ahead of it, has the same commit. (L293–300; also L2918–2922)
- **R3.2.19** A round reviews only the pull request's newest state: a state the pull request has moved past by the round's start is superseded, nothing is reviewed or posted for it, and it is recorded not reviewed with `superseded by 8d21a4f` or `superseded by 3f9c2e0 with different replies`. (L245–254)
- **R3.2.20** A newer state is queued by the next trigger, never by the round host. (L257–259)
- **R3.2.21** A `squiz review` waiting on a superseded state returns the superseding state's result; where that state has no record, it reads the pull request afresh and acts as any trigger; it exits 4 when its wait runs out first. (L259–263; also L3127, L3135, L3135–3136)
- **R3.2.22** Where A was reviewed clean with B queued and B is superseded by A (e.g. the reply that made B is deleted), A closes the episode if no round has run since A's, none of the reviewer's threads is open, and nothing else is queued; otherwise B is recorded superseded and the episode stays open. (L265–275)
- **R3.2.23** A close on A runs no reviewer and spends nothing against the round cap; its summary is posted as § 6 sets out; A's result becomes exit 0 with no threads open, carrying the summary's problem where it was not posted; A's owner gets the close note; `squiz review` waiting on A or B returns A's close. (L275–281; also L2790–2794)
- **R3.2.24** A round's close is recorded before its summary is posted, so a trigger arriving while the summary is posted is not swallowed by that close. (L283–288)
- **R3.2.25** A close at the round cap or token bound stays closed in its worktree: a new commit or reply queues nothing and `squiz review` prints the close; a second episode on that pull request needs another worktree on the same branch. (L311–314; also L3131–3134, L3320–3328, L448–450)
- **R3.2.26** After a clean close, a state with no record on a head other than the one the close reviewed starts a new episode, and a round host is started where none runs; `squiz review` waits on it as on any state. (L320–323; also L101, L451)
- **R3.2.27** After a clean close, a state the closed episode recorded on another head (e.g. a force-push back) queues nothing, and `squiz review` returns that record's result, naming its own head. (L324–326; also L4292)
- **R3.2.28** After a clean close, a record queued after the close is treated as any record (a hook leaves a failed one failed; `squiz review` re-queues it). (L327–328)
- **R3.2.29** After a clean close, new replies on the reviewed head, or a failed record the closed episode wrote, queue nothing, and `squiz review` prints the close. (L329–330)
- **R3.2.30** A new episode archives the closed one in `.squiz/<number>/episodes/<n>/`, numbered from 1 in closing order: its state file, its `rounds/` (each `resume.txt` rewritten to name the session where it now is), its `closed.json`, and the local venue's `summary.md`. (L125–128, L339–343; also L3458–3463)
- **R3.2.31** The new episode carries the reviewer's rulings over, has its own round cap and token bound, posts its own summary, and includes the closed episode's threads on the change; `notes/`, `host.log` and the local venue's files other than `summary.md` stay where they are. (L344–363)
- **R3.2.32** Where a round of the closed episode is still recorded under review, no new episode starts, and each state queued after the close is recorded failed with `no review ran: round 1 of the closed episode is still recorded under review by round host 4242`; `squiz review` retries it as any failed state. (L348–356)
- **R3.2.33** Where the archive cannot be written, the closed episode is left as it was, and the state taken is recorded failed with the reason. (L363–364)
- **R3.2.34** `host.log` names where the closed episode went: `2026-11-08T09:14:02.511Z a new episode starts on a state the clean close never recorded: the closed one is in /work/squiz/.squiz/41/episodes/1`. (L366–370)
- **R3.2.35** A `squiz review` whose state's record or close moved into an archive before it read it reads it there. (L372–373)
- **R3.2.36** The latest activity is the GitHub identifier of the newest reply on the pull request, or none; where the newest reply on a general thread and the newest on any other thread were posted in the same second, it is both identifiers, the other thread's first, separated by a space. (L153–161; also L1596–1603, R4.4.31)

### 3.3 A round, step by step

- **R3.3.1** A trigger reviews pull request `<number>` only where it is open, is not a draft, and has its head branch checked out in the directory the trigger ran in (not another branch, not a detached HEAD); the round host checks open and checked out again when the round starts. Where a check fails, no review runs, nothing is posted and nothing is written to `.squiz/`. (L377–382; also L1393, L4290)
- **R3.3.2** Where the pull request is not open or not checked out, `squiz review` exits 1 and stderr names what it found, as `squiz: no review ran: PR #41's head is "feature-a", and "/work/squiz" has "main" checked out`. (L384–389; also L3371–3372, L4289–4290, L3116, L4290)
- **R3.3.3** Only a reviewer's verdict resolves a thread; the coding agent replies on a thread (to say what it changed, disagree or ask) and never resolves one. (L424–427)

### 3.4 The round cap

- **R3.4.1** A round cap (`rounds`) of R hands open threads back to the coding agent at most R−1 times. (L431–432; also L4226)
- **R3.4.2** A reply on a reviewer's thread with no commit after it starts a round on a new state, which rules on the thread: `withdrawn` where the argument holds, `open` where it does not. (L434–437; also L149–152)
- **R3.4.3** A reply posted while a round runs is not in that round's state, and the next run reviews again. (L437–438)
- **R3.4.4** Every round counts against the cap, whether a commit or a reply started it; a run that returns a recorded result is no round and spends nothing. (L440–444)
- **R3.4.5** Round R is the closing round: it reviews as any round, then closes the episode whatever is open, posts the summary and hands nothing back; unresolved findings stay open and the summary reports them. With a cap of 1 the first round is the closing round. (L446–448; also L3815, L3835)

### 3.5 What starts a round

- **R3.5.1** A round starts only from a trigger: the plugin's `Stop` and `SubagentStop` hooks (Claude Code and Copilot alike), or `squiz review <number>`, which a coordinator or CI job can run from a checkout of the pull request's branch; in a runtime with no hook only `squiz review` starts one. (L455–459; also L77–81)

### 3.6 The round host

- **R3.6.1** The rounds of one episode run one at a time in a round host, `squiz host <number>`, outside every trigger's process. A trigger that queues a state starts one where none runs, detached so it outlives the shell call or hook, and a person never starts one. Its output goes to `.squiz/<number>/host.log`. (L463–467; also L3088, L3382–3383)
- **R3.6.2** The round host exits when nothing is left queued or the worktree it serves is gone. (L469–471)
- **R3.6.3** At most one round host runs per episode; two triggers that each start one leave one running. (L480–482)
- **R3.6.4** After a round host dies, the next trigger starts a host for any queued state. (L484–485; also L3783)
- **R3.6.5** Every trigger, and every round host as it starts, recovers each killed round it finds: it stops the orphaned reviewer whether or not its time bound has passed, confirms it is gone, removes the snapshot, and records the round failed with the reason "the round host died". Nothing the reviewer reported is posted and no failure comment is posted; `squiz review` exits 1 saying the host stopped before its round ended, and a new commit, a reply or `squiz review` retries. (L489–501; also L1961–1963, L3783)
- **R3.6.6** A recovery that cannot confirm the reviewer is gone leaves the snapshot and record, starts nothing for that state, and `squiz review` exits 1 naming the process it could not stop; the next recovery tries again. (L503–505)
- **R3.6.7** While no round host is alive, an orphaned reviewer's time bound is enforced only when the next trigger or `squiz review` runs. (L507–509)

### 3.7 The hooks

- **R3.7.1** `hooks/hooks.json` registers `"${CLAUDE_PLUGIN_ROOT}/bin/squiz" hook`, with the root quoted so a path with a space stays one word under `/bin/sh` and `/bin/bash`, on `Stop`, `SubagentStop`, `SessionStart`, `SubagentStart` and `UserPromptSubmit`. (L513–514, L530–546, L591–593; also L3087, L4027)
- **R3.7.2** A stop firing resolves the pull request whose head is the branch checked out in the payload's `cwd`, records the session that owns the work, queues the state and returns; it never runs a round, never blocks the agent, and exits 0 whatever it found. (L515–519, L636–638; also L3087, L3775, L3813)
- **R3.7.3** A stop that finds no pull request writes the R3.3.2 line on stderr, naming the branch and the directory. (L519–520)
- **R3.7.4** Every hook takes its worktree from the payload's `cwd`, never from the hook process's directory; a stop whose payload has no `cwd`, a non-absolute one, or one in no git worktree queues nothing and says so on stderr. (L523–528, L553, L560)
- **R3.7.5** `SessionStart` and `SubagentStart` do nothing but record the start for the venue (under the GitHub venue, nothing; under the local venue, the base): no pull request is resolved, no owner recorded, nothing queued; a start whose `cwd` is in no git repository records nothing and writes nothing on stderr. (L548–556; also L1391, L1622–1626, L3087)
- **R3.7.6** `UserPromptSubmit` does nothing but hand the payload's `prompt` to the venue (under the GitHub venue, nothing; under the local venue, the change's description), and prints nothing on stdout. (L558–563; also L1392, L1628–1631, L3087)
- **R3.7.7** A `UserPromptSubmit` records nothing and says nothing where the payload carries a non-empty `agent_id`, where the hook's environment has a non-empty `SQUIZ_FIXER`, or where `cwd` is in no git repository. (L572–584; also L924)
- **R3.7.8** A `UserPromptSubmit` with no or an empty `prompt` records nothing and says so on stderr; one whose recording fails writes `no prompt was recorded:` and the reason on stderr; neither line carries the prompt. (L586–589)
- **R3.7.9** The owner a stop records is, for `Stop`, the session itself (`session_id`) with its `CLAUDE_CODE_MESSAGING_SOCKET` where the environment has one, and for `SubagentStop`, the dispatching session (`session_id`) with that socket, plus the subagent (`agent_id`). (L595–598)
- **R3.7.10** A firing is Copilot's where the environment has a non-empty `COPILOT_CLI`. Under Copilot the owner's socket is `squiz.sock` in the directory of the owner's transcript, `<COPILOT_HOME>/session-state/<session id>/events.jsonl`, recorded only where it accepts a connection, and `CLAUDE_CODE_MESSAGING_SOCKET` is never recorded; without an accepted socket the owner is recorded by session id alone. (L600–617)
- **R3.7.12** A `SubagentStop` whose `agent_type` is empty does nothing: resolves nothing, records no owner, queues nothing. (L640–643)
- **R3.7.13** A `Stop` whose `session_id` is not the session its Copilot `transcript_path` names does nothing; a Claude Code `Stop` is never dropped by this rule. (L645–650)

### 3.8 The report

- **R3.8.1** A round's result goes to the session that owns the work and is still alive: a regular session's own work to that session, a subagent's work to the session that dispatched it. (L654–656; also L1633–1635, L4145–4148)
- **R3.8.2** When a round records its result, the round host writes a note for the state's recorded owner, one file in `.squiz/<number>/notes/<session id>/`. (L658–671; also L1419)
- **R3.8.3** A failed state gets one note however many times it fails, a state not reviewed gets one saying why, and a state with no recorded owner gets none. (L671–673)
- **R3.8.4** A note for open threads prints those the round left open that are still open, each as `squiz review` prints it, in GitHub's order, after the line `Squiz reviewed PR #41 at 3f9c2e0, the work of subagent a402ef8f56c1b2ed1: 2 threads are open:`; with rounds left it ends with a paragraph asking to fix, reply with `(cd '<worktree>' && squiz reply <id> <text>)`, commit, push and run `squiz review <number>` again. (L675–697; also L1389)
- **R3.8.5** Where the episode closed with threads open, the first line reads `the episode has closed with N threads open:` and the threads end the text with no paragraph after. (L699–701)
- **R3.8.6** A note prints at most 10 threads, then a line counting the rest: ``3 more threads are open. `squiz review 41` prints them all.`` (L703–704)
- **R3.8.7** Where the threads cannot be listed, or the listing holds none the round left open, the note counts them and points to `squiz review` (`Squiz reviewed PR #41 at 3f9c2e0: 2 threads are open. Run `squiz review 41` to read them.`), and `host.log` says which case and, for a failed listing, why. (L705–712)
- **R3.8.8** A note for a round that closed the episode with nothing open says so and points to `squiz review` for the close. (L714–715)
- **R3.8.9** A note for a failed round gives the reason and names `squiz status`; with a round left under the cap and token bound it says a new commit or one run of `squiz review` retries it, and with none left it ends as the failure comment does, naming the bound that closed the review. (L717–726; also L3826–3835)
- **R3.8.10** Where the hook recorded a Claude Code messaging socket for the owner, the round host moves the note into `delivered/` and posts its text to the socket as one JSON line, `{"type":"user","message":{"role":"user","content":"<text>"}}`, on a connection it ends, reading nothing back; an idle session starts a turn with it. (L728–733)
- **R3.8.11** The plugin ships `extensions/squiz-wake/extension.mjs`, which Copilot starts in each session. It listens on `squiz.sock` in the session's state directory and turns each post into a turn, as a system message carrying the note's text. (L735–743; also L4028, L4151–4160, L3724–3726)
- **R3.8.12** The extension removes any file at the socket path before it listens, and removes the socket when the session shuts down and when Copilot stops the extension. (L745–747)
- **R3.8.13** A post that finds nothing listening fails, the note goes back to wait, and nothing posts it again. (L748–749)
- **R3.8.14** A Copilot owner with no socket (started without experimental features, or with a socket path too long) is woken by nothing; its reviews still run, it learns the result from its own `squiz review`, and one run in the background wakes it when it exits. (L751–755; also L3724–3727, L4170–4176)
- **R3.8.15** A note no wake reached stays where it was written; the owner learns the result from `squiz review` or `squiz status`, and the pull request holds it. `host.log` says when no wake reached the owner or a note could not be written. (L757–759; also L1640, L3814)

### 3.9 Headless runs

- **R3.9.1** A run is headless exactly when `.squiz.json` names a `fixer` (`claude` or `copilot`); squiz never decides it from whether a session is alive, and the hook, the round host and every command read the same setting. (L763–766; also L1641, L4231, L4235–4236)
- **R3.9.2** A headless run is woken by nothing: the round host still writes each note in `notes/`, posts nothing to a socket the stop recorded, and writes `<short head>: no wake: .squiz.json names a fixer, so the run is headless` to `host.log`; a stop that recorded no socket gets no line. (L768–778; also L1638–1640, L757)
- **R3.9.3** A round that leaves threads open with a round remaining writes `rounds/<k>/handoff.md` in any run; in a headless run the fixer starts on it, and in an interactive run nothing reads it. (L782–785; also L115–116, L1040–1042)
- **R3.9.4** The handoff opens with `# Handoff for PR #41 at 3f9c2e0, round 1`, a line counting the open threads (`Squiz reviewed PR #41 at 3f9c2e0 in round 1: 2 threads are open.`), and the venue's `fixerFollowUp` paragraph, which never asks for `squiz review`; it then holds the change's description, each open thread with every reply, each finding no thread holds as its Notes line, each agent's final report, and the diff the reviewer read. (L786–806; also L1390, L1435–1440)
- **R3.9.5** Where the threads cannot be listed or the round kept no diff, the round writes no handoff, and `host.log` says why. (L808–809)
- **R3.9.6** Findings no thread holds (anchored to neither line nor file, or whose comment could not be posted) are listed under `## Findings on no thread` after the open threads, with the line telling the fixer to fix what applies and say in its final message what it changed for each or why not; the count line names them (`…5 threads are open, and 1 finding is on no thread.`); a round with none has no such section and its count line names threads alone. A finding about the change as a whole has its own thread and is handed over among the open threads. (L811–837; also L2690–2692, L3804)
- **R3.9.7** The handoff's `## The description` section holds the change's description (R4.4.17 under the local venue). Where that is the first prompt the worktree's sessions were given, it is preceded by `Nobody wrote a description of this change, so this is the prompt the run was started with:`; with neither, it reads `The change has no description.` (L839–852; also L1412, L1559–1566, L1261–1265)
- **R3.9.8** Each agent's report in the handoff is its transcript path plus its final message where its stop carried one; a Copilot session's report points to its `events.jsonl`, and a Copilot subagent's report, headed `### Subagent <id>, dispatched by session <id>`, reads `Transcript: none of its own. Its events are in its parent's transcript, <path>/events.jsonl`. (L854–867)
- **R3.9.9** Where a subagent and its parent end on one state, the handoff shows the subagent's report, and the parent's stop records nothing. (L869–872)
- **R3.9.10** An episode has one fixer session: the first round that hands threads back starts it in a new session under a UUID squiz chooses, every later round of the episode resumes it, and a new episode starts a new one; the reviewer's session and the coding agent's own session are never resumed. (L876–881)
- **R3.9.11** The fixer runs the CLI `fixer` names, detached, in the change's worktree, on that CLI's default model, with its output in `rounds/<k>/fixer.log`; it loads squiz from the plugin directory of the squiz that starts it, and starting or resuming, it inherits no plugin directory, permission mode, settings or MCP configuration from the run before it. (L883–890; also L116–117)
- **R3.9.12** A Copilot fixer runs with the built-in GitHub MCP server, auto-update and client telemetry turned off, as the Copilot reviewer does. (L901–903)
- **R3.9.13** The fixer may edit files and run `squiz`, `git` and each command `fixerCommands` names, each granted by name with any arguments; the CLI refuses any other command except those it runs without a grant. Without `fixerCommands` the fixer cannot run the project's tests. (L907–921; also L4232, L4239–4243)
- **R3.9.14** The fixer's environment is the round host's, less `CLAUDE_CODE_MESSAGING_SOCKET`, plus `SQUIZ_FIXER=1`, so the fixer's prompt is never recorded as the run's prompt. (L923–925; also L578–582)
- **R3.9.15** A Copilot fixer has `COPILOT_GITHUB_TOKEN` set from `copilotTokenFile` where `.squiz.json` names one, over the round host's; a file that cannot be read or holds anything but one token starts no fixer, and the state's record gives the reason, naming the file. (L925–929; also L2063, L2076, L4233, L4245)
- **R3.9.16** The prompt that starts the fixer names the handoff's path and what it holds, tells it to fix what applies and reply on each thread, not to run `squiz review`, and carries the working rules: check the finding holds before changing code, fix the broken invariant everywhere it must hold, add no machinery, re-trace after editing and remove what the fix left unreachable, then run one focused check or say it could not. (L931–947)
- **R3.9.17** A resumed fixer is handed `rounds/<k>/update.md` holding only what changed since its last handoff: threads newly open (whole), comments posted since on threads still open (rulings included), threads closed since with any new comments, the unchanged open threads by name, and under `## New findings on no thread` each no-thread finding not yet handed (a finding with the same Notes line is not handed twice). It opens with `# Update for PR #41 at 3f9c2e0, round 2`, a count line ending `This holds only what changed since your last handoff.`, and `fixerFollowUp`. (L949–976; also L118)
- **R3.9.18** The resume's prompt names `update.md` first and `handoff.md` second, then gives the same instructions and rules as the starting prompt. (L978–983)
- **R3.9.19** `host.log` says whether the round started or resumed the fixer, naming the session id and, for a resume, the round that started it and the path of the update written. (L985–991)
- **R3.9.20** A round starts a fresh fixer on its whole handoff instead of resuming when `.squiz.json` now names another CLI, when the state it hands back was queued by another session than the fixer's, or when `update.md` could not be written; `host.log` says which. (L1001–1014)
- **R3.9.21** Where no fixer is running, nothing is queued, and the last state's resumed fixer failed (exited non-zero), it is run again as a fresh fixer on that round's `handoff.md` in a new session, with a `host.log` line naming the session and exit status; a fixer started fresh this way is not resumed again in the same round. (L1016–1029)
- **R3.9.22** The fixer's own stop starts the next round, as any stop does. (L1035–1036)
- **R3.9.23** A cap of R runs the fixer at most R−1 times in an episode (each a start or resume); the closing round starts no fixer; the fresh rerun of a failed resume is the one extra run a round can add. (L1040–1045; also L431–432)
- **R3.9.24** No fixer starts while one an earlier round of the episode started is running or cannot be told running or gone, nor in a round with no handoff; the round's record says why. (L1047–1050)
- **R3.9.25** Each round that needed the fixer writes one `host.log` line giving the outcome of its start: started (CLI, pid, session id, and whether resumed), exited, failed, unknown or not started, the last three with why, e.g. `round 1: started the fixer, claude, as process 4200, writing to …/rounds/1/fixer.log`. After an unknown outcome no later round of the episode starts a fixer. (L1052–1063)
- **R3.9.26** In a headless run the round host does not exit while a fixer of its open episode runs; it takes states queued meanwhile, stops waiting at the episode's close, and writes `waiting for the fixer round 1 started, process 4200, to exit, for at most 2700 seconds` to `host.log`. (L1071–1079; also L470–472, L471–472)
- **R3.9.27** The wait on one fixer is bounded by `timeout` × `rounds` seconds (2,700 by default), counted from when the host first waits on it and not restarted by rounds run meanwhile; a fixer that cannot be told running or gone counts toward it; once it passes, the host marks the episode stopped and exits. (L1081–1088)
- **R3.9.28** The round that closes a headless episode writes `closed.json` in the episode's directory once the close is recorded and its summary posted, holding `head`, `exitStatus`, `openThreads` and, where a bound closed it with threads open, `closedAt` (e.g. `"round cap"`); it appears whole, and moves into `episodes/<n>/` with its episode. (L1092–1108; also L123, L126, L1642)
- **R3.9.29** An episode that stops short of its close gets `stopped.json` beside where `closed.json` would be, written as the host exits (no fixer running or the wait's bound passed), only where the episode has not closed and no state is queued or under review; it holds `head`, `stopped` and `reason`, and `stopped` is one of `round failed`, `fixer did not start`, `fixer queued nothing`, `earlier fixer queued nothing`, `fixer outlived its bound`. It appears whole. (L1110–1134; also L124, L1643)
- **R3.9.30** `host.log` records the stop written (`wrote the stop to <path>/stopped.json: fixer queued nothing`), or why it could not be written. (L1134–1141)
- **R3.9.31** `closed.json` and `stopped.json` are never present together: the trigger that next queues a state removes `stopped.json` in the same update; a trigger that cannot remove it queues nothing and fails naming the file; a hook on a failed state leaves it; `stopped.json` never moves into `episodes/<n>/`. (L1143–1150)
- **R3.9.32** A headless episode is left open with neither marker while a fixer whose start could not be told is on its records, when the round host dies or cannot write the state file, and when the last state names no stop (e.g. superseded unreviewed), the last with a `host.log` line `marked no stop: <why>`. (L1152–1162)
- **R3.9.33** Where how a fixer's start went cannot be recorded, no later round of the episode starts a fixer, as after an `unknown` outcome. (L1065–1069)

### 3.10 Parallel coding agents

- **R3.10.1** Each worktree is reviewed on its own: `squiz review` resolves the worktree with `git rev-parse --show-toplevel` from the directory it runs in, and the hook from the payload's `cwd` (for a subagent, fixed when dispatched); one worktree, one branch, one pull request, one live episode. (L1166–1169; also L88, L520–525, L1354–1360)
- **R3.10.2** Squiz never removes a worktree; whatever created it removes it, and the episode's state goes with it. (L1171–1173; also L4196–4197)
- **R3.10.3** Where a tree's `HEAD` moved to another branch while an episode was live, each pull request's episode keeps its state under its own number, and each reviewer reads a snapshot of its own pull request's head. (L1175–1178)
- **R3.10.4** Two coding agents on one branch in one tree share one episode and one round cap, and nothing detects it. (L1180–1181)

## 4. The venue

### 4.0 Preamble

- **R4.0.1** Squiz has two venues. `github` reviews a pull request at its head commit and keeps the record as review threads and comments on it. `local` reviews the working tree against the commit its work started from and keeps the record in `.squiz/local/` in the worktree. (L1185–1192; also L12–15, L4224, L13–15)
- **R4.0.2** The loop is the same in both venues: the state file, the hooks, the queue, the round host, the owner's note and its wake, the round cap and the budget. (L1194–1197)
- **R4.0.3** The local venue needs `git` and does not need `gh`, a remote, a pull request or an issue. (L1404; also L20, L1665, L19–20)

### 4.1 Choosing the venue

- **R4.1.1** The venue comes from `venue` in `.squiz.json`, `github` or `local`. It defaults to `github` where the file does not set it. (L1201–1203; also L4224, L3658)
- **R4.1.2** No environment variable affects the venue choice. A round host started with an empty environment chooses the same venue as the hook that started it. (L1213–1214)
- **R4.1.3** A `.squiz.json` that cannot be read, or whose `venue` is neither `github` nor `local`, chooses no venue, and squiz does not fall back to GitHub. `squiz review` exits 1, and a hook writes one line on stderr and exits 0, such as `squiz: no base was recorded: /work/squiz/.squiz.json: "venue" is "lcoal", but it must be "github" or "local"`. A stop writes the reason after `squiz: nothing was queued:`, and a command after its own prefix, such as `squiz: no threads listed:`. (L1216–1226; also L3666)

### 4.2 The contract

- **R4.2.1** Each change has a name that every message uses: `PR #41` under GitHub, `the working tree` under local. (L1240–1241, L1388)
- **R4.2.2** Each change has a rerun command that reviews it again from any directory, which messages print: `squiz review 41`, or `(cd '/work/squiz-a' && squiz review)`. (L1242, L1388)
- **R4.2.3** Every message that says where the summary is uses the venue's phrase: `on the pull request`, or `in <path>/.squiz/local/summary.md`. (L1244, L1388, L1415; also L2770–2772)
- **R4.2.4** In a note and in `squiz review`'s output, the open threads are followed by a paragraph saying what to fix, how to reply and what to run next. In a fixer's handoff and update the paragraph says what to fix, how to reply and what makes the fix part of the change, and it never asks for `squiz review`. (L1246–1256; also L785–787)
- **R4.2.5** Thread and comment ids are opaque strings that only the issuing venue reads. `squiz threads` prints them, and `squiz reply` takes them back unchanged. (L1335–1337)
- **R4.2.6** A venue stores a comment body exactly as handed over and lists it back the same way, author marker included. A line the venue adds to a comment, such as the GitHub general thread's id line, is removed when the comment is listed. (L1338–1343)
- **R4.2.7** Threads are listed in the order they were opened, and each thread's comments in the order they were written. (L1344–1346)
- **R4.2.8** `squiz reply` acts on a thread of the change in the worktree it is run in. Under GitHub a `G` id names a thread on the open pull request whose head is the branch checked out there. Under local it uses the `.squiz/local/` of `git rev-parse --show-toplevel` for its directory. (L1351–1360)
- **R4.2.9** A summary and a failure comment have the same markdown body in both venues. (L1362–1363; also L2893–2894)
- **R4.2.10** `squiz threads` and `squiz reply` call a GitHub change `#41`, and a local change by its name. (L1369–1370)
- **R4.2.11** A bare `squiz review` reviews the local change where the worktree has a `.squiz/local/` episode, and otherwise prints its usage line. (L1371–1372)
- **R4.2.12** `squiz status` prints a numeric key as `#41`, and any other key as it is. (L1373–1374; also L1663–1664)

### 4.3 The GitHub venue

- **R4.3.1** The GitHub venue is the only venue that runs `gh`. (L1384)
- **R4.3.2** The GitHub `followUp` asks for a commit and a push, and its reply command runs in the pull request's worktree inside a subshell. The GitHub `fixerFollowUp` asks for a commit and a push. (L1389–1390)
- **R4.3.3** Under GitHub the pull request supplies the base and the description, and the run's prompt never stands in for the description. (L1391–1392; also L550–551, L562)
- **R4.3.4** Where `squiz review` is given a number and the pull request checked out has another, there is nothing to review and it exits 1. (L1272–1275, L1393)
- **R4.3.5** Threads, replies, resolve and re-open are review threads on the pull request, with `PRRT_` ids. Outdated and author are what GitHub reports. Threads are listed with the general threads among the review threads, in the order each was opened. (L1396)

### 4.4 The local venue

- **R4.4.1** Everything the local venue writes is in `.squiz/local/` of the worktree, and none of it becomes part of the change. (L1402–1406)
- **R4.4.2** The local episode key is `local` everywhere the pull request's number names the episode, including the episode directory `.squiz/local/`. (L1413)
- **R4.4.3** A failure is written as `.squiz/local/failure-<k>.md`, numbered from 1 in the order written and numbered on from the highest present, and the line that reports it reads `squiz: the failure is posted on the working tree`. (L1416, L1556–1557)
- **R4.4.4** Under local there is no draft or wrong-branch case: the working tree is never held. (L1418)
- **R4.4.5** The local `followUp` names the worktree, asks for no commit or push, and gives every command as a subshell in the reviewed worktree: "Fix what applies in /work/squiz-a, and reply on each thread with `(cd '/work/squiz-a' && squiz reply <id> <text>)` to say what you changed or why you disagree. Then run `(cd '/work/squiz-a' && squiz review)` again." (L1422–1433)
- **R4.4.6** The local `fixerFollowUp` gives the same reply command and runs nothing else, ending "Nothing needs committing: squiz reviews the working tree as it stands." (L1435–1442)
- **R4.4.7** The first session or subagent to start in a worktree records the base in `.squiz/local/base.json`: the worktree's `HEAD` then, and the branches, local and remote-tracking, that point at that commit then, the checked-out one included. An existing record is kept, so a resumed session, a second session or a subagent sharing its parent's directory keeps the first one. A person never sets the base. (L1446–1450, L1459–1461; also L1622)
- **R4.4.8** The base is the newest of the recorded commit and the merge-base of `HEAD` with each recorded branch as it stands now. It leaves out the checked-out branch and its same-named remote-tracking branches (an upstream with another name is kept), branches that no longer exist, and branches whose merge-base does not descend from the recorded commit. Of what remains, the base is the one every other is an ancestor of, else the recorded commit. A worktree rebased onto a moved branch gets that branch's commit as its base. (L1463–1478)
- **R4.4.9** With no `base.json`, or a recorded commit the repository lacks, there is nothing to review: `squiz: no review ran: /work/squiz has no recorded base, which squiz records when a session or subagent starts there`, or `squiz: no review ran: the recorded base <sha> is not a commit in /work/squiz`. (L1480–1486)
- **R4.4.10** The head is a commit built from the working tree on every trigger, before the state is read, holding what `git add --all` in the worktree would take: every tracked file, including a tracked file that `.gitignore` names, and every untracked file that `.gitignore` does not exclude. (L1490–1506)
- **R4.4.11** Building the head changes neither the worktree's index nor the working tree, and writes no object or ref into the repository. Its objects go into `.squiz/local/objects/`. (L1503–1504, L1516–1519)
- **R4.4.12** A worktree of the same repository nested in the working tree, such as a subagent's under `.claude/worktrees/`, is left out of the change unless the base has its path. A submodule, or a separate repository, stays in the tree as a gitlink. (L1509–1515)
- **R4.4.13** Two builds of the same tree against the same base give the same commit, so an unchanged tree is an unchanged state and is not reviewed again. (L1490–1491, L1520–1523)
- **R4.4.14** The reviewer's snapshot holds the built head and the base, and the change is the diff from base to head. (L1525–1528)
- **R4.4.15** A working tree identical to its base is still reviewed, as a round whose change lists no files. (L1530–1531)
- **R4.4.16** `.squiz/local/` holds the live episode and the closed ones, each closed one under `episodes/<n>/` with its state file, rounds and `summary.md`. When a new episode starts, `summary.md` moves into the closed one. `base.json`, `objects/`, `prompt.md`, `threads.json` and the failure files stay in place, and thread and comment ids keep counting across episodes. (L1535–1557; also L123–128, L341–343, L360–363)
- **R4.4.17** The description is `.squiz/local/description.md` where it exists, even empty, else `.squiz/local/prompt.md`, else none. Squiz never writes `description.md`, and reads both on every trigger, so a `description.md` written later wins. The reviewer is handed the one chosen. (L1412, L1559–1564; also L839–841)
- **R4.4.18** `prompt.md` is the first prompt any session in the worktree was given, exactly as the payload carried it, and is never overwritten by a later prompt, session, resume or the fixer. (L1566–1573)
- **R4.4.19** `threads.json` holds every thread, with its id, `path`, `anchor`, `isResolved` and `comments` (each with `id` and `body`), e.g. `{ "id": "T1", "path": "packages/sync/src/queue.ts", "anchor": { "at": "line", "line": 134 }, "isResolved": false, "comments": [{ "id": "C1", "body": "…" }] }`. (L1575–1595)
- **R4.4.20** Thread ids are `T1`, `T2`, … and comment ids `C1`, `C2`, … across all threads, in the order written. Ids start from `T1` in every worktree. (L1597–1598, L1424)
- **R4.4.21** A thread's anchor is a head line (`{ "at": "line", "line": n }`), the file as a whole, or the change as a whole (`{ "at": "change" }`, with no `path`, listed with an empty path). The local venue never refuses a line and always returns the thread id. (L1604–1608; also L2755–2757)
- **R4.4.22** A local thread's URL is the `file://` URL of `threads.json` followed by `#<id>`, such as `file:///work/squiz-a/.squiz/local/threads.json#T1`. (L1609–1610)
- **R4.4.23** A local thread is never outdated, and every comment's author is `local`. (L1611)
- **R4.4.24** After the run, `threads.json` gives each finding with its replies and whether it is resolved, and `summary.md` counts them as § 6 sets out, with a thread that is still open and has a coding-agent reply counted `disputed`. A run that ended before the episode closed has no `summary.md`, and `squiz status` shows where it stopped. (L1613–1618)
- **R4.4.25** A Claude Code subagent dispatched into its own worktree has no description there unless its dispatcher writes `description.md`. (L1628–1631)
- **R4.4.26** `Stop` and `SubagentStop` build the worktree's head, then queue the state and record its owner. A subagent in its own worktree is reviewed in that worktree's `.squiz/local/`, and its result wakes the session that dispatched it. (L1633–1636)
- **R4.4.27** Under `claude -p` or `copilot -p` the review still runs, its threads and summary are written, and its note waits in `.squiz/local/notes/`. With no `fixer`, nothing hands the findings on after the run exits. (L1638–1645; also L123–124)
- **R4.4.28** `squiz review` takes no pull request number under local. Given one, it exits 1 with `squiz: no review ran: the local venue reviews the working tree, and takes no pull request number`. Any key except `local` is not reviewable. (L1417, L1652–1657; also L3082, L3116–3117, L3117–3118)
- **R4.4.29** `squiz reply <id> <text>` adds the coding agent's reply to the thread in that worktree's `threads.json`, and refuses an id it does not hold: `squiz: nothing replied in T9: threads.json holds no thread "T9"`. (L1660–1662)
- **R4.4.30** Under local, `squiz doctor` does not require `gh`: a missing `gh` is reported present, as `gh: not found. Not required under the local venue`, and a `gh` that cannot be used is a warning. (L1665–1672; also L3649)
- **R4.4.31** Every local comment carries the same time, so where both a thread about the change as a whole and another thread hold replies, the latest activity is the newest reply on each, as `C3 C4`, whenever they were written. (L1596–1603)

## 5. The reviewer

### 5.0 Preamble

- **R5.0.1** The reviewer has no GitHub access of its own; it reports each finding through a reporting call, and squiz posts each one as a comment on the pull request. (L1676–1679)

### 5.1 Invocation

- **R5.1.1** Each round starts one fresh reviewer session, which holds no state between rounds and never edits the code under review. (L1683–1687; also L2096)
- **R5.1.2** The reviewer is handed five things: its working directory, the round's snapshot of the head commit; the change (its name, `PR #41` or `the working tree`, the short sha of the base, its description, the files it touches, and the threads the reviewer opened on it, each with its replies and whether it is resolved); the charter, which ships with squiz and is the same every round; the thinking level from `thinking`, set on every run so it never comes from the CLI's own configuration; and the model from `model`, in the CLI's spelling, or none, which leaves the CLI on the user's default. (L1689–1699; also L2238–2240, L4229–4230, L402–404)
- **R5.1.3** The prompt never carries the diff; the reviewer reads each file's change with `git_diff`, and the prompt's size does not grow with the diff (a 3,899-line change to one file adds one line). (L1694, L1713, L1740–1741)
- **R5.1.4** The prompt carries, after the description, a `## History` section telling the reviewer to call `git_log_search`, `git_blame` and `git_show` to learn whether a line was meant, and a `## Changes` section listing the changed files one a line as `git_diff` lists them: status, path (`old -> new` for a rename) and `+N -M`, a zero count left out and `binary` in place of the counts for a binary file. (L1701–1723)
- **R5.1.5** A changed-file list over 65,536 bytes comes in pages of whole lines; every page but the last ends with `[Files 1 to 287 of 400 are listed. To list the rest, call git_diff with from: 288.]`, and the prompt carries the first page. (L1723–1730)
- **R5.1.6** The prompt names the change only in its heading, `# Review PR #41` or `# Review the working tree`, and calls it "the change" elsewhere; a change with no description has `The change has no description.` under `## Description`; threads, where there are any, come last under `## Threads already on this change`. (L1734–1738; also L852)
- **R5.1.7** No stage selects or budgets files for the reviewer; it opens files one call at a time. (L1743–1746)

### 5.2 The reviewer session

- **R5.2.1** The reviewer runs where a person can watch it, in the first that applies: in Herdr (`HERDR_SOCKET_PATH` set), a new unfocused tab labelled `squiz-<number>-r<k>` with the snapshot as its directory; in tmux (`TMUX` set), a detached window named `squiz-<number>-r<k>` in the snapshot; otherwise detached, as a child of the round host with no terminal, with a log holding its progress. (L1750–1757; also L28–30, L3416–3417)
- **R5.2.2** The Herdr tab opens in the workspace named by the triggering process's `HERDR_WORKSPACE_ID`, recorded only when it has the shape `w<number>` (such as `w2`), and in the focused workspace where none was recorded. (L1755, L1762–1766)
- **R5.2.3** Where a pane cannot be opened, including a reviewer command line holding a control character, which squiz treats as a pane Herdr refused, squiz falls through to tmux or a detached child and the round goes on; `squiz status` shows the session as `detached`. (L1798–1801; also L3787)
- **R5.2.4** The variables the round sets (the adapter's, then the GitHub variables of R5.4.6, last) reach the reviewer on every backend over any value the pane's shell or its startup files set. (L1803–1815)
- **R5.2.5** The pane closes when the review ends. Each `pi` round writes its session to `.squiz/<number>/rounds/<k>/session/` and the resume command to `rounds/<k>/resume.txt`, such as `pi --session-dir .squiz/41/rounds/2/session --session 0193f2c4-…`, with paths relative to the coding agent's worktree; `squiz status` prints it on the round's line, and a conversation resumed after the round is not part of the review. (L1817–1832; also L112, L2448–2452, L3450, L3463)
- **R5.2.6** What a person types into a `pi` reviewer's pane reaches `pi` and is not recorded; a Copilot reviewer's pane takes no input. (L1834–1836)
- **R5.2.7** A reviewer in a pane is stopped as a detached one is: at the time bound squiz signals the reviewer's process group, then closes the pane. (L1838–1849; also L3936–3939)

### 5.3 The snapshot

- **R5.3.1** The reviewer never reads the coding agent's worktree; before it starts, squiz clones the repository (from `git rev-parse --git-common-dir`) into the system temporary directory and checks out, detached, the commit GitHub reports as the pull request's head. (L1853–1866)
- **R5.3.2** Where the repository lacks the head or base commit GitHub reports, squiz fetches the missing ones into it in one fetch that writes no ref and no `FETCH_HEAD`. (L1866–1870)
- **R5.3.3** The change's diff is read from the snapshot, never downloaded, is byte for byte the diff GitHub serves for the pull request, and no size of change is refused. (L1880–1885; also L1528)
- **R5.3.4** A diff that cannot be read fails the round before the review and removes the snapshot, with a reason like `no review ran: the diff of PR #142 could not be read: git exited 128: fatal: 7c1e0d3…...HEAD: no merge base`. (L1885–1891)
- **R5.3.5** The snapshot reads the repository's objects and nothing else of it: the repository's local config and hooks never apply in it, its `HEAD` stays at the reviewed commit whatever the worktree checks out, a push to `origin` fails, and a filter or `core.autocrlf` set only in the repository's local config is not applied at checkout. (L1893–1905, L1913–1915)
- **R5.3.6** A branch name given to `git_show` resolves against the clone's copy of the repository's branches (under `refs/remotes/origin/`) and tags; a full commit name or a revision from `HEAD` resolves as in the worktree. (L1907–1911)
- **R5.3.7** The snapshot's path is `<TMPDIR or system default>/squiz-<uid>/<digest>-<number>/rounds/<k>/tree`, where `<digest>` is the first 16 hex digits of the SHA-256 of the coding agent's worktree path; `squiz-<uid>` is readable and writable by that user alone; no component squiz adds begins with a dot; two worktrees or two rounds never share a path, and the same worktree, number and round always give the same one. (L1917–1931)
- **R5.3.8** squiz refuses to make a snapshot where `squiz-<uid>` is a link, is owned by another user, or is writable by group or others, and the round fails before the review. (L1933–1937)
- **R5.3.9** The snapshot holds the commit only: none of the worktree's uncommitted changes, untracked files, build output or dependencies, and it appears in neither `git status` nor `git worktree list`. (L1939–1943)
- **R5.3.10** squiz removes the snapshot once the round has recorded its result, whatever the result, and before it takes the next queued state. It removes nothing but the snapshot and the directories that removing it emptied, and does not need the worktree to exist. (L1945–1950)
- **R5.3.11** A snapshot that cannot be removed stays on disk, the round's result stands, and `host.log` gets a line like `2026-10-07T04:10:09.623Z round 1: the snapshot at /tmp/squiz-501/44df…-142/rounds/1/tree could not be removed: EACCES: …; it stays on disk until it is deleted`. (L1952–1959; also L3794)

### 5.4 Tools

- **R5.4.1** Every reviewer gets the same tools every round, and no setting changes them: reading (`pi`: `read`, `grep`, `find`, `ls`; Copilot: `view`, `grep`, `glob`), reporting (`report_finding`, `report_verdict`, `finish_review`) and history (`git_log_search`, `git_blame`, `git_show`, `git_diff`), the last two kinds prefixed `squiz-` under Copilot, whose MCP server is named `squiz`. Nothing else is granted. (L1982–1996; also L2142)
- **R5.4.2** The history tools behave as follows, all in the snapshot: `git_log_search` takes a term matched as literal text and returns the commits that added or removed it, newest first, each with message and changed files; `git_blame` takes a file and a line and returns the commit that last changed it, with author and date, read from the commit and never the working tree; `git_show` takes one commit and returns its author, date, message and change, refusing a range, a tree or a file at a revision; `git_diff` runs only the pull request's own base...head range, and with no path returns the changed-file list (from file 1 or from `from`), with a changed file's path (either name of a rename) that file's diff, and with any other path a line saying so. (L2002–2007, L2024–2025)
- **R5.4.3** No history-tool argument reaches a shell or reads as an option; an empty argument or one holding a NUL is refused; `git_blame` refuses an absolute path, a `..` path out of the snapshot, and a path whose links resolve outside it; no config, attribute or environment setting in or around the repository makes a history tool run a program, read another repository or read another config. (L1998–2029; also L2119–2120)
- **R5.4.4** A history tool's answer is at most 65,536 bytes of `git` output followed by a line saying it was cut there, and its `git` is stopped after 120 seconds. (L2030–2032)
- **R5.4.5** A refused argument or a failed `git` is returned as the call's error, and the reviewer may call again. (L2034–2035)
- **R5.4.6** The reviewer's environment, under either adapter, has `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` set to the empty string and `GH_CONFIG_DIR` set to `.squiz/<number>/rounds/<k>/gh/`, emptied before the reviewer starts. (L2046–2057; also L112–113, L2391)
- **R5.4.7** Each CLI's model credential is left alone (`pi`'s provider key, Copilot's login). Copilot signs in from the first it finds: `COPILOT_GITHUB_TOKEN`, set from `copilotTokenFile` where `.squiz.json` names one, over the round host's value; the user's own Copilot login; then `gh`'s login. (L2059–2071; also L2331–2333, L4233)
- **R5.4.8** The `copilotTokenFile` token reaches only the environment of the Copilot it signs in: a pane's line carries the file's path, never the token, and no log, record or reason holds it; a file that cannot be read or holds anything but one token fails the round at setup with a reason naming the file. (L2063–2065, L2079–2084; also L926–929, L4245–4254)

### 5.5 Confinement

- **R5.5.1** Under both adapters, every round, with no setting to change it: no granted tool writes or is a shell, and a reporting call writes nothing on disk the coding agent would commit. (L2096–2103; also L1995–1996)
- **R5.5.2** A reading tool refuses, before reading anything, a path whose real path (every link resolved) is outside the snapshot's real path; under Copilot the reviewer can read nothing else in the temporary directory. (L2105–2113)
- **R5.5.3** `pi` resolves a path for the check as `pi` itself does (a leading `@` dropped, `~` as home, a `file://` URL as its path, the rest against the snapshot; a non-string path refused), and the reviewer reads ``squiz refused this call: `<path>` is outside the code under review.`` as the call's error. (L2112)
- **R5.5.4** Under `pi`, a call to any tool outside the grant is refused before it runs, with ``squiz refused this call: `<tool>` is not a tool this review grants.``; Copilot disables every tool outside the grant. (L2122–2128)

### 5.6 Adapters

- **R5.6.1** A configured `model` runs the round or the round fails at setup, with no review run and nothing spent, and a reason naming `model` and its value, such as `"model" in .squiz.json is "openai/gpt-5", which is not a model pi offers; it must be a provider and model as pi --list-models lists them, such as "openai/gpt-5-mini"`. With no `model`, the reviewer's command line and environment are exactly as without the setting. (L2144–2155; also L4230, L4258–4260)
- **R5.6.2** A run that completed no message has a reason that adds what the reviewer said on stderr, in a pane as detached. Where the adapter recognises the cause, the reason is the adapter's (R5.8.11); otherwise it adds the model the run was handed, configured or the user's default: `the reviewer completed no message; "model" in .squiz.json is "gpt-5-nano", which the reviewer's CLI may not offer`, or `…; .squiz.json sets no "model", and the user's default, "gpt-6-astra", may not be one the reviewer's CLI offers`. (L2157–2177; also L2356–2360, L2433–2436, L3789)
- **R5.6.3** Every reporting call is checked by squiz's own report checks whatever CLI serves it, and a report squiz could not build a comment or a mutation from is refused. (L2185–2189; also L2393–2396)
- **R5.6.4** A killed round keeps what was reported before it was killed, except under a CLI that reports only at the end; a run stopped before its CLI reports its cost has no cost. (L2191–2195; also L1684–1685, L2437–2441)
- **R5.6.5** Stopping the reviewer stops every process it started, the history tools' `git` included. (L2197–2200, L2207–2209; also L2444–2446)
- **R5.6.6** A run counts as having finished its review only where it made the finish call; its exit status is not read for how it ended. (L2202–2205)

### 5.7 The `pi` adapter

- **R5.7.1** Every `pi` round runs at the thinking level squiz sets, never the one in the user's `pi` settings; a model that does not offer that level runs at another. (L2238–2240; also L1696, L3682)
- **R5.7.2** No `.pi/` configuration in the tree under review reaches the reviewer, and squiz writes none of the user's `pi` settings; `pi` still loads the tree's `AGENTS.md` and `CLAUDE.md`. (L2234–2237)
- **R5.7.3** A `pi` reviewer has exactly the tools § 5 Tools names, and no `pi` extension runs but squiz's own. (L2227–2233; also L1988)
- **R5.7.4** `pi` runs interactively when the reviewer is in a pane, and in print mode with no standard input when detached. (L2241–2242)
- **R5.7.5** An interactive `pi` exits by itself: once its closing message after `finish_review` is written, or once its agent settles without finishing. (L2243–2246)
- **R5.7.6** For `pi`, `model` is `provider/id` exactly as `pi --list-models` lists it (such as `openai/gpt-5-mini`). A bare id listed under exactly one provider is refused with its full name in the reason, and a `pi` that cannot list its models fails the round at setup. With no `model`, `pi` runs on the user's default. (L2248–2254; also L2150–2156, L4230)
- **R5.7.7** A `pi` round's cost is the sum of its assistant messages' usage, reported with the token count, and its models are the `provider/model` (or the model alone where no provider is named) of each message, in the order first named. (L2270–2275; also L2960, L2984)
- **R5.7.8** A `pi` round's cost is a floor ("at least") where the run did not end on a message's usage, where the time bound stopped the reviewer (which is charged the cost of its completed messages), or where a line of the report file, or the file to its end, could not be read; a round that ran the reviewer twice is a floor where either run is. (L2277–2285; also L2984, L3030–3031, L3979, L3905–3906)
- **R5.7.9** A `pi` message that ended in error, in a run that completed others, counts zero usage and does not fail the round. (L2289–2290; also L3789)
- **R5.7.10** A `pi` run where no message ended normally and no finish was recorded completed no message: the round's reason is the errored message's error text, and the reviewer is not run a second time. (L2291–2293; also L3789)
- **R5.7.11** Reports that arrive after `finish_review` and before `pi` exits are part of the review. (L2294–2296)
- **R5.7.12** A `pi` round that holds the reviewer's finish is the review it declared, whatever ended the run, unless a line of its report file cannot be read, which fails the round with the reports already read still standing. (L2297–2300; also L3790, L3792)

### 5.8 The Copilot adapter

- **R5.8.1** Copilot runs non-interactively in a pane and detached alike, and exits by itself once the reviewer's last message is written. (L2307–2309)
- **R5.8.2** The reviewer receives the prompt byte for byte, and the prompt must fit in one argument (128 KiB on Linux). (L2310–2313)
- **R5.8.3** A Copilot reviewer runs under the charter as its system prompt, which a same-named agent in the tree cannot override. (L2314–2316)
- **R5.8.4** A Copilot reviewer has exactly the tools § 5 Tools names, and no other: `skill` and every shell tool are off. (L2317–2318; also L1988)
- **R5.8.5** A Copilot reviewer reads only inside the snapshot, with the temporary directory excluded. (L2319–2320; also § 5.5)
- **R5.8.6** None of the tree's Copilot configuration reaches the reviewer: none of its hooks, MCP servers, custom instruction files, skills or agents, and the built-in GitHub MCP server is off. From the user's own Copilot configuration only the default model (where the project sets none) and the signed-in user reach it; tokens and trusted folders do not. The reviewer reads the tree's `AGENTS.md` itself. (L2321–2337; also L2067–2070, L2117)
- **R5.8.7** A user's Copilot `config.json` or `settings.json` that exists and cannot be read, or does not hold a JSON object, fails the round at setup. (L2335–2336, L2377–2378)
- **R5.8.8** A Copilot run auto-updates nothing and sends no client telemetry, so it reaches only Copilot's own host and its model's. (L2338–2344)
- **R5.8.9** A Copilot round runs at the reasoning effort squiz sets on every run: the thinking level as it is, and `off` as `none`. (L2345–2346)
- **R5.8.10** What Copilot writes to stderr reaches the round's own stderr when Copilot exits, in a pane as detached, and a non-zero exit from Copilot is the run's exit status. (L2351–2354; also L2158–2162)
- **R5.8.11** A Copilot run whose stderr holds `Error: No authentication information found.` is a reviewer not signed in: the reason quotes the line and names no model, as `the reviewer is not signed in to Copilot: it said "Error: No authentication information found."`. Any other wording gets the round's ordinary reason with what Copilot said. (L2356–2360; also L2166–2169, L3789)
- **R5.8.12** A Copilot reviewer runs on the configured `model`, in Copilot's own spelling such as `gpt-5-mini`, or else on the user's default; a model Copilot does not offer fails the round at setup, whichever named it, in a pane as detached. (L2362–2369, L2375–2376; also L4230)
- **R5.8.13** With no `model` configured, the user's default is `COPILOT_MODEL` in the environment squiz runs in, or else `model` in the user's `settings.json` under `~/.copilot/` or the user's `COPILOT_HOME`. With neither, the round runs on whatever Copilot falls back to. (L2371–2381; also L3711, L3725)
- **R5.8.14** A refused call to the reporting server (a report failing the report checks, history tool arguments not matching their schema, or a history tool that failed) is answered to the reviewer as the call's error, carrying the reason, such as `MCP server 'squiz': git_blame was not run: line must be an integer.` (L2393–2401)
- **R5.8.15** A Copilot round reads its figures from Copilot's usage line: tokens are input plus output tokens summed over every model; AI credits are `totalNanoAiu` at 10⁹ to a credit; messages are the requests summed over every model; models are those with a non-blank name and at least one request, in Copilot's order. A Copilot round has no dollar figure, and a usage line with no model or a model lacking token counts reports no usable cost. (L2412–2425; also L3007, L3010–3014)
- **R5.8.16** A Copilot run with a finish is reviewed; with no finish and a usage line counting at least one request, it stopped without finishing; with neither, or with nothing written, it completed no message, and the reason adds what Copilot said on stderr. (L2427–2436; also L3789, L3791)
- **R5.8.17** A Copilot round records a cost and names a model only where Copilot exited 0 by itself with token counts, and a non-zero exit contributes no usage even where it left a usage line; that cost is never a floor. A round the time bound stopped, and any other, records no cost and names no model. (L2438–2442; also L2349–2350)
- **R5.8.18** A Copilot round's `resume.txt` holds the command that resumes its session: `COPILOT_HOME=.squiz/41/rounds/2/session copilot --resume=<session id>`. (L2448–2452; also L1821, L3450, L3463)
- **R5.8.19** The reporting server goes on answering while a history tool runs; a `notifications/cancelled` naming a running history tool stops its `git` and that call is not answered; the server exits when its standard input closes, and on `SIGTERM` and `SIGHUP`. (L2405–2408)

### 5.9 Charter

- **R5.9.1** The charter the reviewer runs under carries the standing rules: take the intent and declared scope from the pull request description; report correctness bugs, convention violations, security problems and tests that assert nothing, and not formatting, naming, import order, compiler errors or speculation; verify with the tools before reporting; treat what `AGENTS.md` names as authoritative; report each finding as soon as it is confirmed; finish once, after the last finding and the last verdict, even with nothing to report; give one verdict per handed thread from the code as it now stands, with a reason on `open` and `withdrawn`; rule on the defect, not the suggested fix; scope a finding to `line` where a single line owns the defect, anchored to a changed line (for a defect where the change did not touch, the changed line that caused it, naming the other location in the body); to `file` only where no single line owns it or the change left no line in the file to anchor to; to `change` only where no single file owns it; and report one rule broken in several places as one finding, at the place a reader would point at, naming every other place in the body. (L2456–2498; also L2510)

### 5.10 Findings

- **R5.10.1** The reviewer returns results only through three calls, `report_finding`, `report_verdict` and `finish_review`; its last message is not read. (L2502–2510; also L1988)
- **R5.10.2** A call whose arguments are malformed is refused when it is made, the reviewer is told why, and every other report the round made is kept. (L2512–2514)
- **R5.10.3** Findings reported before a round ended are kept and posted however the round ended: killed at its time bound, never finished, or cut off from its model; § 8 records the failure. (L2516–2518; also L3789–3792, L2191–2193)
- **R5.10.4** A round that reported nothing and finished found nothing; one that reported nothing and did not finish failed. (L2520–2522; also L3791)
- **R5.10.5** A finding carries `scope` (`line`, `file` or `change`), `file` and `line` (a `file` finding carries the file alone, a `change` finding neither), `severity` (`high`, `medium`, `low`), `headline`, `reasoning` (bullets), `suggestedFix`, and an optional `reference`. (L2524–2537)
- **R5.10.6** Severity means: `high`, wrong now, a security problem, or a broken written convention; `medium`, wrong under conditions the change makes reachable, or a test that passes with its code deleted; `low`, real, narrow and survivable. (L2539–2543)
- **R5.10.7** Findings are ordered `high` to `low`, and in reported order within a severity; severity does not decide whether a finding counts. (L2545–2547)
- **R5.10.8** Every round hands the reviewer every thread it opened on the pull request, resolved and open, from every episode, identified as its own by the reviewer's marker on the opening comment whoever replied since. A thread a person opened is never handed over, ruled on, read or answered, never counts as open, and never keeps the loop going. (L2549–2555; also L152, L414, L414–415, L4286)
- **R5.10.9** A verdict carries `thread` (the id it was handed under), `verdict` (`fixed`, `withdrawn` or `open`) and `reason`, which is required and non-blank on `open` and `withdrawn` and refused on `fixed`; a second verdict on one thread is refused. (L2509, L2557–2565; also L3800)
- **R5.10.10** `fixed` replies on the thread naming the round and the commit, then resolves it; `withdrawn` replies with the reason, then resolves it; `open` re-opens or leaves the thread open and replies with the reason, every round it keeps it open. (L2575–2579, L2585, L2593; also L407–410)
- **R5.10.11** A ruling's reply opens with the reviewer's marker and the verdict, is posted in the posting reserve before the round ends, comes before the resolve on a thread the round closes, and never counts as activity that starts another round: `**Squiz reviewer · fixed**` then `Confirmed in round 2 at 1b86987.`; `withdrawn` reads `Withdrawn in round 2 at 1b86987.` with the reason beneath; `still open` carries the reason alone. (L2581–2609; also L3186)
- **R5.10.12** A thread already resolved when handed over gets no reply on `fixed` or `withdrawn`. (L2611–2613)
- **R5.10.13** A ruling made in an attempt that spends no round names the commit and no round, as `Confirmed at 1b86987.` (L2613–2615)
- **R5.10.14** A reply that cannot be posted is not retried, and leaves the verdict standing and the thread in the state ruled: a thread the round closes is resolved anyway. `squiz review`'s stderr and `squiz status` name the thread and GitHub's answer. A failed reason on a kept-open thread is named in Notes only by the round that closes the episode; a failed closing reply is named by the summary that closes the episode, or by the failure comment of a round that fails. (L2620–2628; also L2844–2846, L2857, L3802, L3803)
- **R5.10.15** A handed thread with no verdict is treated as `open`, with nothing posted, where the reviewer finished; where it did not finish, the thread is left as handed over. (L2630–2632; also L307–308)
- **R5.10.16** Every finding posted as a thread ends its episode `fixed`, `withdrawn`, `open` (unresolved, no reply from the coding agent) or `disputed` (unresolved, and the coding agent replied); `open` and `disputed` need a person. (L2634–2644; also L1616, L2801, L2814–2828)

### 5.11 The comment format

- **R5.11.1** Every finding's comment is `**Squiz reviewer · <severity> — <headline>**`, then the reasoning as bullets, then `**Suggested fix:** …`, then an optional `> reference` quote that the comment stands without. (L2648–2668)

### 5.12 Pull request comments

- **R5.12.1** A `line` finding becomes an inline thread on a changed line, a `file` finding a thread on the file with no line, and a `change` finding a general thread. (L2672–2679; also L405–407)
- **R5.12.2** A finding about code the change did not touch is anchored to the changed line that caused it, with the affected file and line named in the body. (L2681–2684; also L2488–2491)
- **R5.12.3** A line anchor that cannot be placed is posted on the file with `file:line` in the text. A finding whose file the diff does not carry reaches no thread: the summary's Notes says it could not be anchored, `squiz review` prints it on stderr, and a round that leaves the episode open hands it to a headless fixer. (L2686–2692; also L3804, L813)
- **R5.12.4** File and general threads are resolved, re-opened, ruled on and carried across rounds like inline threads, and count as open for the exit status and the round cap until a verdict closes them. (L2694–2697)
- **R5.12.5** Under the GitHub venue a general finding is a conversation comment in the comment format ending `<sub>Squiz thread G1</sub> <!-- squiz:thread G1 -->`. Ids are `G1`, `G2`, …, per pull request, each new one numbered after the highest present, and a general thread is never outdated. (L2701–2715; also L3096, L1397)
- **R5.12.6** A reply on a general thread, whether the coding agent's, a reason or a closing reply, is a conversation comment ending `> In reply to G1: <the finding's first line> <!-- squiz:reply G1 -->`. (L2717–2727; also L3106)
- **R5.12.7** A general thread is resolved by hiding its finding's comment as resolved, and re-opened by showing it again. A hide or show GitHub refuses is a verdict not applied: the round's outcome stands and the thread counts as handed over. (L2729–2735; also L3800, L47)
- **R5.12.8** A conversation comment whose last line is a thread or reply trailer belongs to the thread it names, and is handed to the reviewer with the trailer and the blank line before it removed. Every other comment, the summary and failure comments included, belongs to no thread; a reply naming an unknown id belongs to none; where two findings name one id, the first holds it. (L2737–2744)
- **R5.12.9** A conversation comment that cannot be listed fails the listing, as a review thread does. (L2746–2747; also L3799)
- **R5.12.10** Deleting a general finding's comment, or editing its last line, removes the thread: no round hands it over, its replies belong to no thread, and the episode can close with nothing open. An edit that keeps the last line keeps the thread with the edited text. (L2749–2753; also § 11)
- **R5.12.11** Both venues hand the reviewer each general thread with all its replies, under its id, and the reviewer rules on it rather than opening a second thread for the same finding. (L2759–2763)

## 6. The summary

### 6.0 Preamble

- **R6.0.1** When an episode closes, squiz posts one summary comment on the pull request carrying the status of every finding, what each round did, and what the review cost. (L2767–2768; also L232, L420)
- **R6.0.2** The summary comment is never edited or replaced; a second episode on the same pull request posts a second comment. (L2768–2770; also L3811)
- **R6.0.3** Under the local venue the summary is written to `summary.md` instead of a comment. (L2770; also L1415, L1545, L1552)
- **R6.0.4** An episode reports its close once. Every path that ends an episode records the close, including paths that post no comment. (L2774–2777; also L283–291, L394–397)
- **R6.0.5** A round that leaves threads open for the coding agent posts no summary; a failed round posts the failure comment (§ 8) instead. (L2777–2779; also L3805)
- **R6.0.6** A run that finds the round cap or the token bound already spent, a bound lowered since the last round included, closes the episode without running a reviewer: it records the close before posting the summary from the episode's threads and record, prints the open threads, and exits 3 whether any are open or none. That close is never clean. (L2781–2785; also L394–397, L288–291)
- **R6.0.7** Where the episode ran no round (its failed attempts spent the token bound) and none of the reviewer's threads is on the pull request, squiz posts no summary, exits 3, and says on stderr that the episode closed before any round ran. (L2785–2788; also L3812)
- **R6.0.8** The summary of a close on a clean state, once the state queued behind it is superseded, is posted from the episode's threads and record, and its Notes carry the unthreaded findings of the clean round and the rounds before it. (L2790–2794; also L265–281)
- **R6.0.9** A close that runs no reviewer counts each thread so: unresolved is `open`, or `disputed` where the coding agent replied; resolved and last ruled `fixed` is `fixed`; resolved and last ruled `withdrawn` is `withdrawn`; resolved and last ruled `open`, or with no ruling, is "resolved, ruling unknown". (L2796–2804; also L2632–2633)
- **R6.0.10** A "resolved, ruling unknown" thread counts as neither `fixed` nor `withdrawn`, and is not listed as needing a person. (L2806–2808; also L4287)

### 6.1 What the comment carries

- **R6.1.1** The summary has four blocks in this order: the counts, spend and reviewer; the findings that need a person; Rounds; Notes. (L2812)
- **R6.1.2** The counts block gives rounds run, findings raised, and how many ended `fixed`, `withdrawn`, `open` and `disputed`. Findings raised counts every thread of the episode plus every unthreaded finding Notes lists; unthreaded findings carry no status. (L2814, L2818–2820)
- **R6.1.3** A close that ran no reviewer adds a "Resolved, ruling unknown N" count, only where N > 0: `Fixed 1 · Withdrawn 0 · Open 1 · Disputed 0 · Resolved, ruling unknown 2`. (L2820–2826)
- **R6.1.4** The needs-a-person block lists every `open` and `disputed` finding with its headline and location: `file:line` for a line thread, the file alone for a file thread, `The change as a whole` for a general thread. With none, it says so in one line. (L2827–2831; also L2639–2644)
- **R6.1.5** Rounds lists each round in the order it ran, with the short commit it reviewed, the number of findings it raised, and its rulings (threads it closed while open, threads it kept open). A round that did neither reads `- Round 4 at 9a0b1c2: found nothing new and ruled on nothing`. (L2832–2836)
- **R6.1.6** Rounds lists every round, including a round whose replies GitHub refused. (L2836–2838)
- **R6.1.7** Notes carries: a finding anchored to neither a line nor a file, with its `file:line`; a finding whose comment could not be posted, with its location or as about the change as a whole; a thread the last round kept open whose reason could not be posted, with location and headline; a thread a round closed whose reply could not be posted, with location, headline and ruling; a ruling of the last round that could not be applied; a round whose finished review never read a changed file's diff; a round the time bound cut short; a cap or bound that ended the episode early, with each queued state left not reviewed. (L2839–2855; also L3800, L3802, L232)
- **R6.1.8** An unposted closing reply's Notes line names the ruling: ``- `src/queue.ts:134` — Retry backoff resets (ruled fixed, and the reviewer's reply could not be posted on its thread)``. (L2857–2862)
- **R6.1.9** An unapplied ruling's Notes line says what the reviewer ruled; a handed-over thread is named by location and headline, one not handed over by the id the reviewer gave. Cases: could not be resolved, could not be re-opened, given no ruling, ruled a second time (first stands), not handed to the reviewer. (L2864–2874; also L3800)
- **R6.1.10** Notes names every unthreaded finding the episode raised, earlier rounds' first and then the closing round's. An earlier round's finding no later round raised again reads ``- Raised in round 1 and not raised again: `src/cache.ts:12` — The cache is never cleared (no thread could be opened for it)``, naming the latest round that raised it; a general one reads `About the change as a whole: …`. (L2876–2887; also L804, L958, L996, L169)
- **R6.1.11** A finding a later round raised again is listed once, as the later round's. A close that ran no reviewer gives the last result-reaching round's lines as they are, after the earlier rounds' lines it did not raise again. (L2889–2891)
- **R6.1.12** A round whose finished review never read a changed file's diff gets one Notes line naming the files, the first ten then "and N more"; each name is one code span with control characters escaped, a line break as `\n`, and a fence one backtick longer than any backtick run in the name. A round cut short by the time bound gets no such line. Example: ``- The reviewer finished round 1 without reading the diff of 2 changed files: `src/queue.ts`, `docs/a file.md` ``. (L2896–2907; also L1743–1746)
- **R6.1.13** A round the time bound cut short gets the line `- The review was cut short by the 900-second time bound in round 2, and the round kept only the findings it had reported by then`. (L2909–2914)
- **R6.1.14** A cap or bound that left queued states not reviewed is one Notes line naming the bound and each state (short commit, plus "with different replies" where needed), in place of the bound's own line: `- The episode ended at its round cap rather than with nothing left open, and did not review 8d21a4f or 8d21a4f with different replies`. (L2916–2923; also L232, L293–299)
- **R6.1.15** A round's findings raised are those the reviewer reported, whether or not their comments were posted; its rulings count, by verdict, each `fixed` or `withdrawn` verdict on a thread open when it was handed over and every `open` verdict, and leave out a verdict on a thread not handed over and a second verdict on one thread. (L2989–2993)

### 6.2 The format

- **R6.2.1** Summary format: heading `**Squiz review — 3 rounds, 7 findings**`; counts line; spend line; reviewer line; `**Needs a person**` list; `**Rounds**` list; `**Notes**` list, as in the L2927–2950 example. (L2927–2950; also L67)
- **R6.2.2** Notes is omitted when empty, and Rounds when the episode ran no round. (L2952–2953)
- **R6.2.3** The spend line gives total tokens, the round count and each round's tokens, then dollars where the reviewer's CLI priced the model: `48,200 tokens over 3 rounds: 20,100, 16,400, 11,700 · $0.0134`. An unpriced round adds no dollars; with only some rounds priced, the dollar total covers those. (L2814–2817, L3006–3008)
- **R6.2.4** A Copilot round carries AI credits to two decimals in place of dollars, never zero dollars (`… · 0.84 AI credits`). Where some rounds carry credits and others dollars, the line gives both totals, each covering its rounds. (L3010–3018)
- **R6.2.5** A round that completed no assistant message is shown as unknown, not zero, including a floor round, whose neighbouring totals stay marked. (L3018–3019, L3038–3039)
- **R6.2.6** A round with no cost has no figure in the spend line; the line covers rounds with a cost and says how many (`18,200 tokens over 1 of 2 rounds · 0.36 AI credits`). With no round costed, there is no spend line. (L3021–3028)
- **R6.2.7** A floor figure reads "at least": the floor round's own and every total of an episode holding one (`At least 36,500 tokens over 2 rounds: 20,100, at least 16,400 · at least $0.0105`). (L3030–3038; also L2277)
- **R6.2.8** The reviewer line names the reviewer CLI each round ran and the model(s) the run reported, never the configured `model`; a round with two reviewer runs names both runs' models; a run that reported no model reads "an unknown model". (L2816–2817, L2972–2974, L3041–3044)
- **R6.2.9** Where every round ran the same reviewer on the same models, they are named once: ``Reviewed by `copilot` on `gpt-5-mini` and `claude-haiku-4.5` ``. (L3046–3052)
- **R6.2.10** Where rounds differ, each model is named with its rounds under the reviewer that ran them, in first-named order, a two-model round under both: ``Reviewed by `pi` on `openai/gpt-5-mini` in rounds 1 and 2, and by `copilot` on `gpt-5-mini` in round 3``. (L3054–3061)
- **R6.2.11** Each model is one code span with whitespace runs collapsed to a space; a round with no recorded reviewer reads "an unknown reviewer"; an episode with no round has no reviewer line. (L3063–3065)

## 7. Commands

### 7.0 Preamble

- **R7.0.1** Everything squiz ships to be run is a subcommand of one binary, `squiz`; there is no slash command, and the setup check is `squiz doctor`. (L3069–3071)

### 7.1 The `squiz` binary

- **R7.1.1** In Claude Code, the coding agent's Bash tool and a `!` command run `squiz` by name (the plugin's `bin/` is on PATH); every other shell, Copilot's included, runs it through the link `squiz init` makes. (L3075–3078; also § 7.4)
- **R7.1.2** `squiz threads` lists the open threads on the current branch's pull request, headed `3 open threads on #185` (under the local venue, `<n> open threads on the working tree`), one line each: identifier, location, severity — headline, e.g. `PRRT_kwDOUEd2qM6mPuUP scratch/paging/pages.ts:26 high — pageCount drops the partial last page`. A general thread's location is `(whole change)`. (L3089, L3092–3102; also L1659)
- **R7.1.3** In `squiz threads`, a thread whose first comment carries none of R2.2.2's markers was opened by a person, is no finding, and prints as its identifier and location alone. (L3099–3102)
- **R7.1.4** The identifier leads the line undecorated, so the line splits into identifier and rest at the first space. (L3104–3105)
- **R7.1.5** `squiz reply <id> <text>` replies on the thread `squiz threads` printed as `<id>`, `G<n>` being a general thread of the checked-out pull request; an id the pull request holds no finding for is refused with `squiz: nothing replied in G9: PR #185 holds no thread "G9"`. (L3090, L3104–3112; also L1662)

### 7.2 `squiz review`

- **R7.2.1** Exit statuses: 0 a round reviewed this state and nothing is open, episode closed with summary posted, or the pull request is a draft; 2 threads open and rounds remain; 3 the round cap or token bound closed the episode with threads open, or closed it before a round reviewed this state; 4 still reviewing, the round going on in the round host; anything else, the review could not run. (L3122–3128; also L231–232, L420, L3949–3953, L81–82, L411–414, L416–422)
- **R7.2.2** Exit 0 is given only for a state a round reviewed. A cap/bound close answering for an unreviewed state (reached before a round took it, queued behind the closing round, or a commit or reply after the close) exits 3 whatever is open, for the run waiting on it and every later run. (L3130–3135; also L394–397, L420)
- **R7.2.3** Any status outside the table is read as 1. (L3138–3140)
- **R7.2.4** stdout carries the outcome for exits 0, 2, 3 and 4; stderr carries what failed; a run that exits 1 prints nothing on stdout. (L3142–3145; also L3873–3880)
- **R7.2.5** Runs exiting 0, 2, 3 or 4 write all of stdout to `.squiz/<number>/review.txt`, replaced each run, and print first `Full output, to read where this is cut short: <path>`. (L3148–3151, L3166; also L237, L1543)
- **R7.2.6** On a draft, `squiz review` exits 0, prints only `PR #41 is a draft. Squiz reviews it once it is marked ready for review, so there is nothing to wait for.`, and writes no file, and the hooks write nothing. Once it is marked ready for review, the next trigger queues its state as any other. (L3151–3152, L3212–3216; also L391–393, L521, L4288, L519–521)
- **R7.2.7** If `review.txt` cannot be written, outcome and exit stand and stderr adds `squiz: the output could not be written to <path>: <reason>`. (L3152–3157)
- **R7.2.8** Each open thread prints as its `squiz threads` line followed by its comments indented two spaces, the first comment without its first line. (L3159–3161; also L2617–2618)
- **R7.2.9** Exit 2 output: path line; `Squiz reviewed PR #41 at 3f9c2e0: round 2 of 3, 1 new finding.`; `2 threads are open:`; the threads; then a paragraph telling the agent to fix what applies in the worktree, reply with `(cd '<worktree>' && squiz reply <id> <text>)`, commit and push, and run `squiz review 41` again. (L3163–3193)
- **R7.2.10** A run handed a result it did not produce says `Squiz already reviewed PR #41 at …` and prints the threads as they stand on the pull request now. (L3195–3201)
- **R7.2.11** Exit 0 output: heading `Squiz reviewed PR #41 at 8d21a4f: round 2 of 3, no new findings.` then `Nothing is open. The review is closed, and its summary is on the pull request.` (L3203–3210)
- **R7.2.12** Exit 3 at a cap close: `The round cap is reached. The review is closed with 1 thread open, and its summary is on the pull request. A person takes it from here, so do not run `squiz review 41` again.` followed by the threads; "The token bound is reached" where the bound closed it. (L3218–3233)
- **R7.2.13** Closed before a round reviewed the run's state: after the close's heading, `Squiz did not review PR #41 at 8d21a4f: the episode closed at the round cap, after reviewing 3f9c2e0.`, and the paragraph says "with nothing open" where nothing is. (L3235–3247; also L234–243, L293–299, L3317–3329)
- **R7.2.14** A close reached before any round took the run's state uses the why-line as the heading (`… the episode closed at the token bound before a round took this state.`), and claims no summary where none was posted. (L3249–3259)
- **R7.2.15** Exit 4 lines: `Squiz is still reviewing PR #41 at 3f9c2e0.`; queued behind an older state, `Squiz is reviewing PR #41 at 3f9c2e0 first, and 8d21a4f is next.`; reviewed clean with a later state queued, `Squiz found nothing open in PR #41 at 3f9c2e0, and is reviewing 8d21a4f before it closes the review.`; superseded, `Squiz is reviewing PR #41 at 8d21a4f instead of 3f9c2e0.`; each ends `Run `squiz review 41` again to wait for it.` (L3261–3292; also L231, L263)
- **R7.2.16** A run on an already closed episode prints the close, naming the head it was reached on, whatever the round cap or token bound would now allow: `Squiz's review of PR #41 closed at 3f9c2e0 after 2 rounds, with nothing open. Only a new head commit starts another review in this worktree.` A clean close is printed this way, with exit 0, only for its own head and a failed state it recorded. (L3294–3303; also L399, L394–398)
- **R7.2.17** Where the cap or bound closed it, the line ends `No round runs again in this worktree.`; with threads open it counts them, exits 3, and the threads follow. (L3305–3315)
- **R7.2.18** A failed round prints `squiz: review failed: <the failure comment's reason>` then `squiz: the failure is posted on PR #41`. (L3338–3345; also § 8.1)
- **R7.2.19** A general thread is printed among the open threads and keeps the run at exit 2 while open. (L3347–3348)
- **R7.2.20** A round that left threads open and has unthreaded findings keeps exit 2 and prints on stderr `squiz: round 1 could not post 1 of its 3 findings to PR #41` (where any failed to post), then each as `squiz: round 1 raised this on no thread: <Notes line>`. (L3348–3356; also L2877–2878)
- **R7.2.21** A run that failed before any round, or could not reach GitHub, prints one `squiz: no review ran: <why>` line (e.g. `PR #41 is closed`) then the stop line. (L3367–3374; also L3881)
- **R7.2.22** Where the round host's start cannot be told, `squiz review` waits on a live host. Where no host takes the review, it exits 1 with `squiz: no review ran: whether the round host for PR #41 started could not be told, …`, then a line naming `squiz status 41` and `.squiz/41/host.log`, then the stop line, and the state stays queued. (L3376–3384; also L3780)
- **R7.2.23** A run after this worktree pushed waits up to 60 seconds (or its deadline) for GitHub to report a head containing the pushed commit, and acts on that head. Otherwise it exits 1 and queues nothing, with `squiz: no review ran: PR #41 still has 3f9c2e0 as its head after 60 seconds, though this worktree pushed 8d21a4f to it`. Unpushed commits, a head pushed from elsewhere, and a branch with no push destination are taken as GitHub reports; hooks never wait. (L3386–3402; also L3795)
- **R7.2.24** Every number and thread in the output is what is on the pull request, so the coding agent can check each there. (L3404–3405)

### 7.3 `squiz status`

- **R7.3.1** `squiz status` lists every review recorded in any worktree of the repository, one line per pull request state, newest first; it starts nothing and makes no GitHub call. (L3409–3411; also L3083)
- **R7.3.2** The table's columns are PR, Commit, Replies, State, Started, Elapsed, Result, Session, Worktree, Resume, e.g. `#41   3f9c2e0  OmQx7a   reviewed   07:06:02  2m 40s  1 thread open  tmux squiz-41-r2  .claude/worktrees/agent-a5336e10  pi --session-dir … --session …`. (L3413–3419)
- **R7.3.3** Replies shows the last six characters of the identifier of the latest activity the state was read with, or `—` for none. (L3423–3424)
- **R7.3.4** State shows the record's status; a reviewing record whose round host has gone shows `killed` until a recovery records it failed; one whose host cannot be told running or gone shows `reviewing` with Result "the round host could not be checked: <why>"; a state the episode closed before reviewing shows `not reviewed`. (L3425–3429; also L3742, L3781, L3783)
- **R7.3.5** Started is local time: time of day for a round started today, date and minute otherwise; a reviewing record shows the reviewer's start once it has started, the round host's before. (L3430–3433)
- **R7.3.6** Elapsed is time so far for a running review, start to end for a finished one, and `—` for a killed review, a state no round started, and a state that failed before a round took it. (L3434–3436)
- **R7.3.7** Result: for failed, the failure comment's reason; for not reviewed, why; for reviewed, how many of the reviewer's threads are left open, plus "review closed" where it closed the episode, "review closed at the round cap" / "at the token bound" where a bound closed it with threads open, and "N of M findings not posted" where GitHub refused some. (L3437–3442; also L3475)
- **R7.3.8** Session shows the backend and the label `squiz-<number>-r<k>`; the backend alone where the record keeps no `k`; `detached` for a detached reviewer; `—` where no reviewer started. (L3443–3447; also L3787)
- **R7.3.9** Worktree shows the path relative to the main worktree, `.` for the main worktree. (L3448–3449)
- **R7.3.10** Resume shows the content of the round's `rounds/<k>/resume.txt` once the round is over, else `—`. (L3450–3451; also L1821, L2448, L3810)
- **R7.3.11** Order: episodes with a state queued or under review first; then by the latest start or end time any record carries; then by higher PR number; within an episode, newest state first. (L3453–3460)
- **R7.3.12** A closed episode a later one replaced (`episodes/<n>/`) is listed as an episode of its own, under the same PR and worktree, with Resume read from `episodes/<n>/rounds/<k>/resume.txt`. (L3460–3463; also L125–128, L338–343)
- **R7.3.13** Every cell is one line: a line break and the whitespace around it print as one space. (L3465–3466)
- **R7.3.14** A reviewed state's problems (failures that did not change its outcome) follow its line, one line each, indented two spaces, never widening a column, e.g. `  the review of PR #39 closed without its summary: gh: HTTP 502 Bad Gateway`. (L3468–3477; also L3742, L3800–3803, L3811)
- **R7.3.15** Status shows how many findings were not posted, not which. (L3479–3481)
- **R7.3.16** A state file that cannot be read, or an `episodes/` directory that cannot be listed, gets a stderr line naming the PR, the worktree and what was wrong, and every other worktree is still listed. (L3483–3485; also L3743, L3784)
- **R7.3.17** A worktree git lists that is gone from disk prints nothing. (L3485)
- **R7.3.18** With nothing recorded anywhere and every state file read, stdout is `No review is recorded in any worktree of this repository.`; where a state file could not be read and nothing else was listed, stdout is empty. (L3486–3494)

### 7.4 `squiz init`

- **R7.4.1** `squiz init` links `squiz` into a directory on `PATH` and allows the coding agent's three `squiz` commands in Claude Code's user settings, printing a line for each. (L3498–3503; also L3084, L4121–4124, L4178–4190)
- **R7.4.2** It exits 0 where the link is in place afterwards and 1 otherwise, with the link's line on stderr; a settings file it could not change puts its line on stderr and leaves the exit status unchanged. (L3505–3507)
- **R7.4.3** It writes nothing in the repository it is run from, and runs outside a repository. (L3507–3508)
- **R7.4.4** The link's target is the real path of the running `bin/squiz`, every symlink resolved, so the link holds an absolute path. (L3512–3513)
- **R7.4.5** The link goes in `~/.local/bin`, else `~/bin`: the first that is on `PATH`, is a directory and is writable; no other directory is used, no directory is created, no shell startup file is edited. (L3514–3517; also L4188)
- **R7.4.6** Every `squiz` already on `PATH` is read first (an empty or relative entry read from the working directory); nothing named `squiz` that is not this squiz is replaced or shadowed. (L3518–3522; also L4189)
- **R7.4.7** What it finds on `PATH` decides the outcome: a link to this squiz changes nothing and says so; a link to another version of the same plugin-cache install (`plugins/cache/<marketplace>/squiz/<version>/bin/squiz`, present or not) is moved to this version in place; this squiz's own `bin/` is ignored; a link to another checkout or install makes no link, names it and says to remove it and rerun; another squiz's own `bin/` makes no link and says to run `squiz init` by name in that session; anything else named `squiz` or a dangling link makes no link, names it and leaves it; nothing found and neither directory usable makes no link and says to add `~/.local/bin` to `PATH`. (L3524–3532)
- **R7.4.8** A squiz is a `bin/squiz` whose plugin's `.claude-plugin/plugin.json` names it `squiz`. (L3534–3535)
- **R7.4.9** The link's line reads, e.g., `squiz: linked /Users/ana/.local/bin/squiz to /Users/ana/.claude/plugins/cache/tools/squiz/0.2.0/bin/squiz, in place of …/0.1.0/bin/squiz, an earlier version of this install`. (L3537–3543)
- **R7.4.10** It adds `Bash(squiz review *)`, `Bash(squiz threads)` and `Bash(squiz reply *)` to `permissions.allow` in the user-settings `settings.json`. (L3547–3554; also L4121–4124)
- **R7.4.11** That file is in `$CLAUDE_CONFIG_DIR` where set and non-empty, else `~/.claude`; where `CLAUDE_CONFIG_DIR` is set, `~/.claude` is never used. (L3556–3558; also L4124)
- **R7.4.12** Where the configuration directory does not exist, nothing is written or created and a stdout line says Claude Code's configuration was not found, naming the directory; a non-absolute `CLAUDE_CONFIG_DIR`, or neither it nor `HOME`, writes nothing, with the line on stderr. (L3559–3563)
- **R7.4.13** Inside the directory, a missing file, `permissions` object or `allow` list is created. (L3564–3565)
- **R7.4.14** Only missing rules are added, after those already there; every other key and rule keeps its value; a file already holding all three is not written. (L3566–3568)
- **R7.4.15** A file that cannot be read, is not JSON, is not an object, or whose `permissions` is not an object or `permissions.allow` not a list is left as it is, and the line names the file and which. (L3569–3572)
- **R7.4.16** The file is replaced whole, atomically, as JSON indented two spaces; a symlinked `settings.json` is written at its target and stays a link. (L3573–3575)
- **R7.4.17** Copilot's settings are left as they are. (L3577–3578)
- **R7.4.18** The settings line reads, e.g., `squiz: allowed Bash(squiz review *), Bash(squiz threads) and Bash(squiz reply *) in /Users/ana/.claude/settings.json`, with "already allows …; nothing changed" and "allowed nothing in <file>: <why>" for the other cases. (L3580–3587)

### 7.5 `squiz version`

- **R7.5.1** `squiz version` and `squiz --version` print one line, `squiz <version> <path>`, and exit 0, e.g. `squiz 0.1.0 /Users/ana/squiz/bin/squiz`. (L3591–3595; also L3086)
- **R7.5.2** The version is from the running squiz's `.claude-plugin/plugin.json` and the path is the real path of its `bin/squiz`, symlinks followed; neither comes from the working directory or `PATH`. (L3597–3601; also L3086)
- **R7.5.3** Where `plugin.json` cannot be read, is not JSON, names another plugin or no version, it prints nothing on stdout, says why on stderr (`squiz: the version of this squiz could not be read: <why>`) and exits 1. (L3603–3608)

### 7.6 The setup check

- **R7.6.1** `squiz doctor` runs inside or outside a repository, prints one line per dependency, and exits 1 where any line failed. (L3612–3626; also L3085)
- **R7.6.2** Each line is `present` (usable, or an optional tool absent), `warning` (seen, squiz runs without) or `failed` (required dependency missing, unusable or unauthenticated); only `failed` changes the exit status. (L3628–3634)
- **R7.6.3** It starts every tool in the directory it was run from and writes nothing but the temporary directory of Copilot's sign-in prompt, which it removes. (L3636–3637)
- **R7.6.4** Each tool is found on `PATH` and started once for its version within 15 seconds; only a version read from its output makes it present; an optional tool found and not runnable is a warning. (L3639–3641)
- **R7.6.5** Rows print in this order: git, venue, gh, Claude Code, Copilot as coding agent, Node, tmux and Herdr, the `squiz` link, Copilot's copies of squiz, the reviewer. (L3643–3656)
- **R7.6.6** `git` is required and present where it answers. (L3647)
- **R7.6.7** The venue row is required and present where `.squiz.json` reads as a round reads it; the venue is the one `venue` names, GitHub outside a repository; it names the file as `(path)` or `(no path)`, and under the local venue says gh is not required, e.g. `Venue local (/work/squiz/.squiz.json): reviews run on the working tree, and gh is not required`. (L3648, L3658–3667; also L1665–1668)
- **R7.6.8** `gh` is required under the GitHub venue, present where it answers and `gh auth status --json` reports an account whose check succeeded. (L3649; also L1665)
- **R7.6.9** Claude Code is required only where `copilot` is missing or cannot be run. (L3650)
- **R7.6.10** Copilot as a coding agent is optional, printed only where `copilot` is on `PATH`, and present where it answers, `"experimental"` is `true` in the user's `<COPILOT_HOME>/settings.json`, and `<COPILOT_HOME>/session-state/<session id>/squiz.sock` is at most 104 bytes on macOS and 108 on Linux. (L3651, L3724–3728; also L4168–4176)
- **R7.6.11** Node is required, 24 or later. (L3652; also L4004)
- **R7.6.12** tmux and Herdr are optional; an absent one prints e.g. `tmux: not found. Not required: without tmux or Herdr, reviews run detached`. (L3653, L3622)
- **R7.6.13** The `squiz` link row is optional and never a failure: present where `PATH` holds a link to this squiz as `squiz init` reads it; anything `squiz init` would refuse or change is a warning. (L3654; also L4106)
- **R7.6.14** Copilot's copies row prints only where Copilot has one; each copy under `<COPILOT_HOME>/installed-plugins/` of a different version than this squiz is a warning naming the older. (L3655; also L4099–4100)
- **R7.6.15** The reviewer row is required; the reviewer is the one `reviewer` names in the main worktree's `.squiz.json`, `pi` outside a repository or without the file; the row names the file as `(path)` or `(no path)` after the version; a git refusal other than "not a repository" fails the row. (L3656, L3669–3674)
- **R7.6.16** The reviewer row names the model a round would run on: `model` from `.squiz.json`, else the user's default from the reviewer CLI's settings, else unknown; unreadable CLI settings are a warning for `pi` and a failure for Copilot. (L3676–3680)
- **R7.6.17** For `pi`, wherever the row names a model it ends with the thinking level a round runs at, without making a model request: a match ends `; thinking medium`; a differing level is a warning naming the configured level, the level it runs at and the levels offered; an unreported level is a warning with the reason. (L3682–3698; also L2238–2240)
- **R7.6.18** For a Copilot reviewer, sign-in is checked by one prompt spending one request on the named model (no model where unknown), run as a round's reviewer would run, signing in with `copilotTokenFile`'s token where set (an unreadable file fails the row without running Copilot), bounded at 60 seconds; a model the account cannot use fails the row with Copilot's reason, e.g. `Reviewer copilot 1.0.105 (/Users/ana/app/.squiz.json), model gpt-6-astra, from .squiz.json. Signed in; the check spent one request on gpt-6-astra`. (L3700–3720)
- **R7.6.19** No prompt is sent for a `pi` reviewer or for Copilot as a coding agent. (L3722)

## 8. Failure modes

### 8.0 Preamble

- **R8.0.1** A failure the harness controls exits 1 where the run could not review; one that leaves the outcome standing keeps its status (0, 2 or 3) and adds a stderr line. (L3732–3735; also L3140–3146)
- **R8.0.2** Every failure path reaches at least one of six surfaces: the failure comment, `squiz status`, `.squiz/<number>/host.log`, `squiz review`'s stderr, the summary's Notes, the hook's stderr. (L3737–3752)
- **R8.0.3** `.squiz/<number>/host.log` holds a line per thing the round host did and the host's stderr, and is the only surface for what the host does outside a round. (L3745–3747; also L121, L467)
- **R8.0.4** The hook's stderr carries one line for what a `Stop` or `SubagentStop` firing could not do. (L3751–3752)
- **R8.0.5** Once the round has found its pull request and can read the episode's state, a failure posts a failure comment where GitHub can be reached, and a closing round's problems go into Notes; a failure before that posts nothing. (L3754–3758)
- **R8.0.6** A round that fails in the round host is recorded failed with its reason, shown by `squiz status`, `squiz review`'s stderr and `host.log`. (L3760–3761)
- **R8.0.7** A `gh` that ran and failed is reported by its exit status and the first line it wrote; a `gh` that could not run is reported as such. (L3763–3765)
- **R8.0.8** A `gh` call whose body was not read to its end is a failure: reported as what `gh` said where it exited non-zero, and as GitHub not reached where it exited 0. (L3767–3769)
- **R8.0.9** Hook payload unreadable: nothing queued, hook exits 0. (L3775)
- **R8.0.10** git cannot name the worktree or branch: exit 1, no review, trigger queues nothing; a round meeting it records the state failed and posts no failure comment. (L3776)
- **R8.0.11** Configuration unreadable: `squiz review` exits 1 naming the refused setting; a round host stops before taking the state and says why in `host.log`; the state stays queued. (L3777; also L1216–1220, L4269)
- **R8.0.12** State cannot be queued: nothing queued, no host started, `squiz review` exits 1. (L3778)
- **R8.0.13** Round host cannot be started: state stays queued, next trigger starts one, `squiz review` exits 1. (L3779)
- **R8.0.14** `squiz review` stopped from outside: the round goes on in the round host and the next run returns its result. (L3782; also L4291)
- **R8.0.15** State file unreadable: exit 1, no review; every reader reports the underlying error; hook queues nothing; status prints a line for the episode and lists the rest; host exits leaving the state queued; no failure comment. (L3784)
- **R8.0.16** Reviewing record cannot be written: exit 1, no review; the state is recorded failed, or stays queued where that write fails too. (L3785)
- **R8.0.17** Reviewer's session cannot be recorded: the review goes on; `host.log` says so. (L3786)
- **R8.0.18** Reviewer not installed: exit 1; failure comment and stderr name the reviewer as a setup problem. (L3788)
- **R8.0.19** Reviewer exits cleanly with no completed message: exit 1; what it reported is posted; the failure comment and stderr carry its reason (R5.6.2); not retried; reported as a setup problem. (L3789)
- **R8.0.20** Reviewer output unreadable after a retry: exit 1; what it reported is posted; failure comment and stderr say the review did not run. (L3790)
- **R8.0.21** Reviewer stops without finishing: retried once where time remains; both attempts post what was reported; exit 1 with a failure comment saying the review was never finished where the retry fails too. (L3791)
- **R8.0.22** Reviewer exceeds the time bound: exit 1, reviewer killed, its findings posted; failure comment and stderr say how many findings arrived and, for `pi`, messages completed with average seconds and provider failures quoting the last error's first line; where the machine slept, "the machine slept for N minutes of the round"; recorded failed; closing summary notes the cut; a round already holding the reviewer's declaration is the review it declared, no failure comment, exit 0/2/3. (L3792; also L3833, L3847, L3902, L2913)
- **R8.0.23** Reviewer's pane cannot be closed: it stays open; `host.log` says so. (L3793)
- **R8.0.24** GitHub unreachable: exit 1, nothing posted, nothing stored to retry; stderr says where the episode ends having posted nothing; a trigger queues nothing. (L3796)
- **R8.0.25** `gh` cannot run: exit 1, nothing posted, no review; stderr names the call and says `gh` could not be run. (L3797)
- **R8.0.26** Calls before the review run out of time (snapshot included): exit 1, no review; failure comment and stderr name the call; a timed-out lookup is never read as no pull request. (L3798)
- **R8.0.27** Threads cannot all be listed: exit 1, no review; failure comment and stderr say so; trigger queues nothing. (L3799)
- **R8.0.28** A verdict cannot be applied (refused, unknown thread, second verdict): the thread stays as handed over and counts that way; outcome stands; stderr and status name thread, ruling and why (with GitHub's answer); closing summary or failure comment name each without it; not retried. (L3800)
- **R8.0.29** Some comments fail to post: landed ones stay; exit as the outcome says; stderr gives the count; a later round makes the rest; closing summary or failure comment lists each. (L3801)
- **R8.0.30** No finding posts: a round that found findings and posted none is failed, whatever its verdicts did. It exits 1 with the reason `round 2 found 3 findings and could not post them to PR #41`, printed as `squiz: review failed: <reason>` then the failure-posted and stop lines, and posts a failure comment and no summary. The episode does not close: a later trigger retries where a round remains, and closes it where none does. (L3805; also L3882, L3358–3365)
- **R8.0.31** Posting reserve runs out before the findings are posted: exit 1, findings reported on stderr as unposted, no failure comment, nothing attempted past the reserve. (L3806; also L3864–3867, L3937–3940)
- **R8.0.32** The round's rulings and spend cannot be written: exit 1, and nothing the reviewer found is posted, no verdict included; the failure comment and stderr say nothing was posted and give the underlying error. (L3807; also L302–306)
- **R8.0.33** Round's end cannot be written: exit 1, no summary; posted findings and verdicts stand; the failure comment and stderr name the write; the episode reads open and the next run reviews again. A close reached before any review fails the same way, with nothing posted but the failure comment. (L3808)
- **R8.0.34** Round's result cannot be recorded: what was posted stands; `host.log` names result and reason; status shows the round killed; a waiting `squiz review` exits 4 at its deadline; a later run exits 1 (host stopped before its round ended) unless the round closed the episode. (L3809)
- **R8.0.35** Posting time or resume command cannot be written: result stands; Resume shows `—`. (L3810)
- **R8.0.36** Summary comment cannot be posted: still a close, exit 0 or 3; stderr says the episode closed without its summary and names GitHub's answer or the spent reserve, on this and every later run on the closed episode; status prints it under the round's line; `host.log` after the close's line; not retried. (L3811; also L3476, L3884)
- **R8.0.37** The harness throws: a command's throw writes one stderr line; a throw inside a round fails it (recorded with the throw as reason, no failure comment), `squiz review` exits 1; the hook exits 0; a host throw outside a round leaves its round killed. (L3813)

### 8.1 The failure comment

- **R8.1.1** A failed round posts one issue-level comment: a bold headline `**Squiz review failed — <reason>**`, what happens next, how many salvaged findings were posted as threads, then a list of each salvaged finding no thread holds and each ruling not applied, written as Notes writes them; e.g. `- \`src/cache.ts:12\` — The cache is never cleared (no thread could be opened for it)`. (L3820–3839; also L2891–2893)
- **R8.1.2** Where a round remains under the cap and token bound, it says the review is still open and a new commit or reply, or `squiz review`, retries it. (L3828–3830)
- **R8.1.3** Where none remains, it says the review is closed and which bound: "The review is closed: it has run 3 rounds, and the round cap allows 3." or "… it reached the token bound of 10,000,000 tokens.", then "No round runs again. A new commit or reply, or running `squiz review`, posts its summary." (L3841–3854; also L726)
- **R8.1.4** The next run closes the episode with its summary; an episode that ran no round ends its comment at "No round runs again." (L3856–3859)
- **R8.1.5** The headline's reason is word for word the reason the command prints on stderr. (L3861–3862; also L3338–3344)
- **R8.1.6** The failure comment is posted in the posting reserve after the salvaged findings, never edited, one per failed round; nothing is posted where GitHub is unreachable or the reserve spent. (L3864–3867; also L3806)
- **R8.1.7** A run ending at the gate posts no failure comment; one that waited on another's round or was handed a recorded result posts nothing. (L3869–3871; also L3948)

### 8.2 The command's stderr

- **R8.2.1** `squiz review` writes one stderr line per thing that failed, prefixed `squiz: `, and every run that exits 1 ends its stderr with `squiz: put these lines in your report rather than running squiz review again`. (L3875–3887; also L3140–3146, L3338–3344, L3331–3336)
- **R8.2.2** A run where nothing failed writes nothing on stderr except the defaults-in-use line. (L3889–3891; also L3144–3146, L4210)

### 8.3 The review budget

- **R8.3.1** The time bound (`timeout`) applies per round: at it the reviewer is stopped, the round records the cut, and findings reported before the stop are posted. (L3898–3902; also L3792, L4227)
- **R8.3.2** The token bound (`tokens`) applies per round: once it is reached the episode closes without starting another round, and the summary says the bound was reached, not that the reviewer failed. (L3898–3903; also L4228, L3816)
- **R8.3.3** A failed round's confirmed findings are posted and its verdicts applied in the posting reserve; a finding no thread holds is listed in the failure comment; the round stays failed, hands no threads back and closes no episode. (L3908–3915; also L3792)
- **R8.3.4** A failed round that confirmed nothing still posts its failure comment. (L3917–3918)
- **R8.3.5** A round runs in the round host, outside any caller's timeout, in three parts: before the review (at most 30 seconds: PR lookup, thread listing, snapshot fetch/clone/checkout, diff), the review (the time bound), posting (60-second reserve: findings, verdicts, summary, failure comment). (L3920–3927; also L1871, L1977, L3798, L1870–1871, L1977–1978)
- **R8.3.6** Time the machine sleeps during the review is added back to the time bound, at most the bound itself per round, so no review runs longer than twice its bound; the other parts and `squiz review`'s wait count sleep. (L3929–3935; also L3792)
- **R8.3.7** Stopping the reviewer comes out of the posting reserve; a round whose reserve is spent before it has findings posts nothing and says so. (L3937–3940; also L3806)
- **R8.3.8** `squiz review` waits within one 540-second deadline from its start. (L3942–3944; also L209, L3119–3120)
- **R8.3.9** A run whose round ends first returns its result (0, 2 or 3, or 1 with the recorded reason) and posts no second failure comment. (L3946–3948)
- **R8.3.10** A run whose deadline arrives first exits 4; the round goes on and the next run returns it. (L3949–3950; also L231, L263, L3261, L3809)
- **R8.3.11** A call with no time left in its part is not made. (L3952–3953)
- **R8.3.12** No GitHub call may take more than 30 seconds, not configurable; a call reaching either bound is GitHub unreachable: exit 1, landed comments stay. (L3955–3957)
- **R8.3.13** The token bound is per round; the episode's ceiling is cap × bound (30,000,000 at defaults, 80,000,000 at the largest cap). (L3959–3963)
- **R8.3.14** An attempt's tokens count against the bound whether or not it was a round. (L3965–3966)
- **R8.3.15** A reviewer that ran is charged what its report file says however its attempt ended. Where the attempt was a start that failed after the reviewer may have run (a tmux window or an unidentified child; a failed Herdr start spends nothing), or one the harness threw out of after the reviewer started, what the file says is a floor, and zero where it reports none; a Copilot usage line is kept as Copilot's total. (L3968–3981)
- **R8.3.16** The token bound is checked before a round and when a round records its spend; it stops the next round, never the running one. (L3983–3986)
- **R8.3.17** A Copilot round with a cost is counted against the token bound as a `pi` one is; one with no cost counts nothing; dollars and AI credits bound nothing. (L3988–3990)

## 9. The project

### 9.0 Preamble

- **R9.0.1** Squiz is its own repository, not a directory inside a host project. (L3994)

### 9.1 Language

- **R9.1.1** Squiz is TypeScript run directly by Node, with no build step and no compiled output. (L3998–3999)
- **R9.1.2** Erasable syntax only: no `enum`, parameter properties or namespaces; a union of string literals in place of an enum. (L4001–4002)
- **R9.1.3** Types are checked by `tsc --noEmit` in CI. (L4003)
- **R9.1.4** Node 24 or later. (L4004; also L3652)
- **R9.1.5** Runs on macOS and Linux, and on Windows under WSL. (L4005–4007)
- **R9.1.6** `bin/squiz` is a shell shim that execs the real `.ts` entry point. (L4008–4010)
- **R9.1.7** The Copilot extension, `extension.mjs`, is the one JavaScript file and imports only Node's modules and `@github/copilot-sdk/extension`. (L4012–4014)
- **R9.1.8** No runtime dependencies; everything outside the process is a subprocess: `git`, `gh`, `ps`, the reviewer CLI. (L4016–4017)

### 9.2 Structure

- **R9.2.1** The repository is a Claude Code plugin and the distributed package: `.claude-plugin/plugin.json` (name, version, description, Copilot extensions directory), `.claude-plugin/marketplace.json`, `hooks/hooks.json` (Stop, SubagentStop, SessionStart, SubagentStart, UserPromptSubmit, run by both runtimes), `extensions/squiz-wake/extension.mjs`, `bin/`, `charter.md`. (L4021–4030; also L4071–4073)
- **R9.2.2** `src/` holds exactly `cli.ts`, `config/`, `review/`, `hook/`, `host/`, `sessions/`, `loop/`, `worktree/`, `reviewers/` (`pi/`, `copilot/`), `venues/` (`github/`, `local/`), `findings/`, `testing/`; beside it `eval/`, `docs/specs/`, `docs/notes/`. (L4031–4049)
- **R9.2.3** `src/sessions/` names no pull request, round or finding and imports nothing from the rest of `src/`. (L4055–4062)
- **R9.2.4** A test sits beside its code as `<name>.test.ts`. (L4064–4065)

## 10. Adoption

### 10.1 Installing

- **R10.1.1** The repository is the marketplace for both runtimes: `marketplace.json` names it `squiz` and lists one plugin, squiz, sourced from the repository root. (L4071–4073; also L4026)
- **R10.1.2** Claude Code installs with `/plugin marketplace add jacygao/squiz` then `/plugin install squiz@squiz`. (L4077–4080)
- **R10.1.3** Copilot installs with `copilot plugin marketplace add jacygao/squiz` then `copilot plugin install squiz@squiz`. (L4084–4087)
- **R10.1.4** The marketplace entry carries the same version as `plugin.json`. (L4093–4094)
- **R10.1.5** After updating squiz in Claude Code, the user runs `! squiz init` in a session started after the update; `! squiz doctor` warns about the link until then. (L4102–4106; also L3527, L3654)
- **R10.1.6** Uninstall is `/plugin uninstall squiz` and `copilot plugin uninstall squiz`. (L4108–4109)
- **R10.1.7** `copilot --plugin-dir <checkout>` loads the hooks and extension from a checkout. (L4111–4113)

### 10.2 Getting started

- **R10.2.1** Claude Code needs nothing per project for the three commands (`squiz init` allowed them); a Copilot session is started with `copilot --allow-tool='shell(squiz)'`. (L4121–4130; also L3547–3554)
- **R10.2.2** The setup is checked with `! squiz doctor` in Claude Code, or `squiz doctor` in a shell once linked. (L4136–4143)
- **R10.2.3** A Claude Code or Copilot coding agent needs no instruction or `AGENTS.md` entry to be reviewed: the hooks start the review when it finishes. (L4145–4149)
- **R10.2.4** Every Copilot session of a user who installed squiz loads its hooks, and its extension where experimental features are on. (L4151–4152)
- **R10.2.5** Copilot support is experimental: the user turns on experimental features once, with `copilot --experimental` or `/experimental on`. (L4154–4171; also L25, L736–743, L3724)
- **R10.2.6** Under a `COPILOT_HOME` whose socket path exceeds 104 bytes (macOS) or 108 (Linux), the extension warns in the session that it cannot listen. (L4173–4176; also L752, L3727)
- **R10.2.7** Every agent but Claude Code reaches `squiz` through the `squiz init` link, made once per machine: `! squiz init` in Claude Code where it has squiz enabled, else `<COPILOT_HOME>/installed-plugins/squiz/squiz/bin/squiz init`. (L4178–4190; also L3078)
- **R10.2.8** Without an `AGENTS.md`, the review reports no convention violations. (L4192–4194; also L2236, L2468)

### 10.3 Configuration

- **R10.3.1** Every squiz process reads `.squiz.json` from the root of the main worktree (the first `git worktree list --porcelain` names) of the worktree it acts on, never from the reviewed worktree, so every worktree of a repository, a subagent's isolated worktree included, has one configuration. The hook acts on the worktree holding the payload's `cwd`, the round host on its episode's worktree, and `squiz review`, `threads`, `reply`, `status` and `doctor` on the worktree holding the directory they run in. (L4201–4207; also L3670, L1203–1211)
- **R10.3.2** `.squiz.json` is optional, and every setting has a working default. Without it, `squiz review`'s first stderr line is `squiz: no .squiz.json was found in the main worktree, /work/squiz, so the defaults are in use`, whatever the outcome, which it leaves unchanged with the exit status; a round host writes the line to `host.log`. (L4209–4216; also L3889–3891, L3145–3146, L4132–4134)
- **R10.3.3** In a bare repository's linked worktree there is no `.squiz.json` and the line says so; a git that cannot name the main worktree is an unreadable configuration. (L4218–4220; also L3777)
- **R10.3.4** `reviewer`: default `pi`, one of `pi`, `copilot`; it chooses the adapter and nothing else; `copilot` needs the Copilot CLI installed and signed in. (L4225, L4262–4263; also L2132–2134, L2223, L2304–2305)
- **R10.3.5** `rounds`: default 3, 1 to 8. (L4226; also L431)
- **R10.3.6** `timeout`: default 900 seconds, 60 to 3,600. (L4227; also L3902)
- **R10.3.7** `tokens`: default 10,000,000, 100,000 to 10,000,000. (L4228; also L3903)
- **R10.3.8** `thinking`: default `medium`, one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. (L4229)
- **R10.3.9** `model`: default none (the user's own default); `provider/id` for `pi`, the model's name for Copilot; up to 200 of letters, digits, `.` `_` `:` `/` `@` `+` `-`, starting with a letter, digit or `@`; an empty string is refused. (L4230, L4257–4258; also L2362–2366)
- **R10.3.10** `fixer`: default none, one of `claude`, `copilot`; `null` or an empty string is refused. (L4231, L4235–4237)
- **R10.3.11** `fixerCommands`: default none; 1 to 16 distinct names, each up to 64 of letters, digits, `.` `_` `+` `-`, starting with a letter or digit; a path, space, wildcard or CLI grant is refused; empty list refused; refused without `fixer`. (L4232, L4239–4243; also L908)
- **R10.3.12** `copilotTokenFile`: default none; an absolute path up to 4,096 characters, no control characters; the file holds the token alone (letters, digits, `_`), surrounding whitespace dropped; read where a Copilot reviewer or fixer starts and by `squiz doctor`. (L4233, L4245–4248; also L926, L2063, L2083, L3712)
- **R10.3.13** An invalid `copilotTokenFile` is refused with an error that omits the value: `<path>/.squiz.json: "copilotTokenFile" must be the absolute path of a file holding a token for Copilot; leave "copilotTokenFile" out for Copilot's own login`. (L4249–4255)
- **R10.3.14** A setting out of range or of the wrong type is rejected naming the setting, the value and what was expected; an unknown key is rejected as not a setting, listing the settings; an unreadable or unparseable file makes the command exit 1 naming it on stderr. (L4265–4270; also L1216–1220, L3777)

## 11. Human intervention

### 11.1 What squiz handles

No requirement of its own after merging. Its lines are cited under R3.2.5, R3.2.27, R3.3.2, R5.10.8, R6.0.10, R7.2.6, R8.0.14.

### 11.2 Everything else

- **R11.2.1** Other mid-review changes by a person have no specified behaviour. (L4296–4299)
- **R11.2.2** Squiz never reports a review of a commit it did not review, e.g. `squiz review` exiting 0 about a head no round reviewed. (L4302–4306; also L3130–3135)

### 11.3 Decision

No requirement.

## Contradictions

- L19 says squiz needs all three dependencies, but L20 drops `gh` for the local venue and L28 makes the multiplexer optional. Is "all three" wrong for the local venue?
  - Code: `squiz doctor` always requires `git`, and requires `gh` only where the venue is `github`. Under `local`, a missing `gh` is present and an unusable one is a warning. tmux and Herdr are never required. At src/review/doctor.ts:271-282, src/review/doctor.ts:717-723, and the test "#838: under the local venue .squiz.json names, gh is not required: its absence passes, and the venue's line names the file".
  - Proposed: "All three" holds for the GitHub venue. Under the local venue the first row is `git` alone. The multiplexer was never one of the three, so L28 needs no change.
- L98–102 defines a clean close as one that left nothing open and no state behind it not reviewed, and L289–291 says a close at an already-spent bound is never clean. The close on a clean state at L265–281, which runs no reviewer, is not called either. Does a new head after it start a new episode (R3.2.26) or queue nothing (R3.2.25)?
  - Code: The close on a superseded clean state writes `cleanClose`, so it is a clean close and a new head starts a new episode (R3.2.26). A close at an already-spent bound writes `closeReported` with no `cleanClose`. At src/loop/round.ts:1412 (superseded), src/loop/round.ts:1347 (bound already spent), src/loop/round.ts:1264-1265 (after a review), and the host.test.ts test "#416: a reply-state queued behind a clean round and superseded by it, once its reply is deleted, closes the episode on the clean round", which asserts `cleanClose` (#832).
  - Proposed: L265–281 should say the close on A is clean, and L98–102 should name it as one of the clean closes.
- L88 and L1169 say a worktree holds one live episode at a time; L1175–1177 has one tree hold two pull requests' episodes after `HEAD` moved to another branch while the first was live. Can a tree hold two live episodes, or does the move end the first?
  - Code: A tree can hold two live episodes. State, lock and host are all per pull request, in `.squiz/<number>/`, and nothing closes the first episode when `HEAD` moves. At src/host/lock.ts:1-3 (one host lock per episode directory) and the episode.test.ts test "two pull requests in one worktree hold their state apart".
  - Proposed: Keep L1175–1177. L88 and L1169 should say one live episode per pull request in a worktree.
- L456–459 names only `Stop`, `SubagentStop` and `squiz review` as triggers, while L513 and L3087 call all five registrations the hook, and L548–549 has the start hooks record a base under the local venue. Is a start or prompt hook ever a trigger?
  - Code: No. A start firing calls `recordStart` and a prompt firing calls `recordPrompt`, and both return before `trigger` is reached. Only a stop firing calls it. At src/hook/hook.ts:60-68 (start and prompt) and src/hook/hook.ts:70-76 (stop).
  - Proposed: Keep L456–459. L513 and L3087 can keep calling all five registrations `squiz hook`, adding that only the two stop firings trigger a round.
- L730 moves a note into `delivered/` before posting it, and L748–749 sends a failed post's note "back to wait for a pull"; L757 and L3814 say a note no wake reached stays where it was written, in `.squiz/<number>/notes/`. Where does a note whose post failed end up?
  - Code: The note is claimed into `delivered/`, and a failed post moves it back to `.squiz/<number>/notes/<session id>/`, where it was written. Where that move back fails, it stays in `delivered/`, and `host.log` gives both reasons. Nothing in `src/` reads a waiting note back, so no "pull" exists. At src/host/wake.ts:36-44, src/sessions/notes.ts:143-153, src/host/host.ts:418 and src/host/host.ts:445-448, and the wake.test.ts test "a post to a socket that has gone leaves the note waiting, and says why".
  - Proposed: Say the note goes back to `.squiz/<number>/notes/<session id>/`, where it was written. Drop "to wait for a pull", since nothing pulls. Add the case where the move back fails.
- L754–755 and L4172 say a Copilot owner with no socket learns the result only from its own `squiz review`; L758 says an unwoken owner learns it from `squiz review` or `squiz status`. Is `squiz status` a way for that owner?
  - Code: Yes. `squiz status` reads every state file in the repository and prints each state's Result, whoever owns it and whether a socket was recorded. At src/review/status.ts:66 (the Result column) and src/review/status.ts:73-80.
  - Proposed: Keep L758. L754–755 and L4172 should name `squiz status` beside `squiz review`.
- L1074 says a close ends the round host's wait on a fixer still running; L1088 and L1110–1113 say the host exits once no fixer runs or the bound passes. At a close, does the host exit with a fixer still running?
  - Code: Yes. The wait loop returns `settled` as soon as it reads `closeReported`, before it looks at any fixer. The host then calls `markStop`, which writes nothing for a closed episode, and exits. At src/host/host.ts:724 and src/host/host.ts:205-211. No test covers a close reached while a fixer runs.
  - Proposed: Keep L1074. L1088 and L1110–1113 should say they apply only while the episode is open.
- L1230 says nothing outside a venue asks which venue it has, but L1365–1379 lists four places outside a venue that do. Which is the requirement?
  - Code: The four places exist as L1365–1379 lists them. `squiz threads` and `squiz reply` compare `name` with `PR #<key>`. A bare `squiz review` asks the venue for a `local` directory. `squiz status` formats a numeric key. The host names a change from its key alone. At src/cli.ts:180, src/cli.ts:120, src/host/host.ts:866-869.
  - Proposed: L1230 is the requirement. L1365–1379 lists where the code falls short of it, tracked by #835 and #829, and belongs under a note or the issues rather than in the contract.
- L1371–1372 says a bare `squiz review` reviews the local change only where the worktree has a `.squiz/local/` episode, and otherwise prints its usage; L1417 and L1652 say that under local a bare `squiz review` reviews the worktree it runs in. What does it do in a local worktree with no `.squiz/local/` yet?
  - Code: Under the local venue, `episodeDirectory` returns `.squiz/local/` whether or not the directory exists. A bare `squiz review` therefore always takes the key `local`. With no recorded base, `readChange` is `none`, and the run ends with "<root> has no recorded base, which squiz records when a session or subagent starts there". The usage line prints only under the GitHub venue. At src/cli.ts:113-125, src/venues/local/venue.ts:46-49, and the venue.test.ts tests "the episode is .squiz/local/ for the key local, and none for a pull request's number" and "a worktree no start was recorded in reads no change, naming its root".
  - Proposed: Keep L1417 and L1652. L1371–1372 should say "where the venue gives a directory for the key `local`, which the local venue always does". It should also say that a worktree with no recorded base gets the no-base line, not the usage line.
- L1375–1379 has the round host print `PR #local` and `squiz review local` under the local venue, while L1240–1242 (R4.2.1, R4.2.2) name the change `the working tree` and give the subshell rerun. The spec states the wrong output as current behaviour (#829).
  - Code: Where the host has only the key, it names the change `PR #<key>` with `squiz review <key>` as its rerun, whatever the venue. Under local that prints `PR #local` and `squiz review local`. At src/host/host.ts:866-869.
  - Proposed: Keep L1240–1242 as the requirement. Take the `PR #local` sentence out of the spec once #829 is fixed. Until then it is a known defect, which belongs on #829 and not in the spec.
  - Decision needed: The code is wrong here, and #829 is the fix. Whether the spec should describe the defect until #829 lands is the owner's call.
- L1665 says a missing `gh` is "reported present" under local, while L1671's row reads `gh: not found`. Is that row counted as present?
  - Code: Yes. Under local the row is `gh: not found. Not required under the local venue` at level `present`, which leaves the exit at 0. At src/review/doctor.ts:280 and the test "#838: under the local venue .squiz.json names, gh is not required: its absence passes, and the venue's line names the file".
  - Proposed: Keep both. L1665 should say that the row's level is present, so it does not fail the check, and that its text still says not found.
- L2057 says a `gh` the reviewer's CLI or a tool starts finds no login; L2071 has Copilot sign in from `gh`'s login, and L2089–2091 says `gh auth token` prints the keychain login whatever `GH_CONFIG_DIR` names. Does a `gh` in the reviewer's environment find a login?
  - Code: Not through a variable or a configuration file. The round sets the four token variables empty and points `GH_CONFIG_DIR` at an emptied directory, and a test asserts that `gh auth status` there reports no login. Nothing closes the keychain, and the test's own comment says `gh auth token` can still read it on macOS. At src/reviewers/round.ts:341-351 and the round.test.ts test "a gh the reviewer starts finds no login".
  - Proposed: L2057 should say that such a `gh` finds no login in its variables or its configuration, and that `gh auth token` can still read the keychain login, which is the login Copilot's fallback uses (L2089–2091, #529).
  - Decision needed: Whether a keychain login reaches the reviewer's `gh` depends on `gh` and the operating system, not on squiz's code. L2057 states a guarantee the code does not give.
- L1817–1819 has Herdr close the pane when `pi` exits, and L1840–1844 covers Copilot's `sh` only for tmux. Does a Copilot reviewer's Herdr pane close at the end of the review the same way?
  - Code: Yes. Every attempt ends by closing its place, whichever adapter ran. A Herdr pane is closed with `herdr pane close` and confirmed gone. At src/reviewers/round.ts:573-585, src/reviewers/round.ts:1015-1017 and src/reviewers/round.ts:1041-1043.
  - Proposed: L1817–1819 should say "when the reviewer exits", not "when `pi` exits". The L1840–1844 table covers only where the group comes from at the bound, and needs no change for this question.
- L2516–2518 says a round killed at its time bound is not a review; L2297–2300 and L3792 say a round holding the reviewer's finish is the review it declared whatever ended the run, the time bound included. Which governs a round killed after its finish?
  - Code: The finish governs. A reviewer that finished and then hung is stopped at the bound, and the round is `reviewed`. A declared review the bound cut posts no failure comment. At the round.test.ts test "a reviewer that finishes its review and then hangs is stopped at the bound" and the loop/round.test.ts test "a review the reviewer declared before the bound cut it posts no failure comment".
  - Proposed: Keep L2297–2300 and L3792. L2516–2518 should read "killed at its time bound before it finished".
- L2191–2195 and L2516–2518 keep and post every finding reported before a round ended, however it ended; L3783 says that when the round host dies, what the reviewer reported is not posted (R3.6.5). Which holds for a round whose host died?
  - Code: R3.6.5 holds. Nothing posts the reports a dead host's round left. The recovery that L489–505 describes is not built either. A trigger that finds the host gone returns `recover` and changes nothing. `squiz review` reports that the host "stopped before its round ended", and the record stays `reviewing`. At src/loop/trigger-decision.ts:85, src/review/review.ts:199-208, and the trigger.test.ts test "a round whose host has gone is handed back for recovery, and nothing is changed".
  - Proposed: Keep L3783. L2191–2195 and L2516–2518 should say they apply to a round its host ended.
  - Decision needed: No recovery is built, so a dead host's state is never recorded failed, and its reviewer and snapshot are never cleaned up. L489–505 and L3783 describe behaviour the code does not have. #327 tracks building it.
- L2732–2735 says a refused hide or show of a general thread is named by the round's record and `host.log`; L3800 names a verdict not applied on `squiz review`'s stderr, in `squiz status`, the summary's Notes and the failure comment. Which surfaces name it?
  - Code: All six do. The ruling goes into the round's record as a problem. `host.log` prints each problem. `squiz review` prints them on stderr, and `squiz status` prints them under a reviewed state's line. The summary that closes the episode and the failure comment list the ruling, without GitHub's answer. At src/host/host.ts:1036-1038, src/host/host.ts:352, src/host/host.ts:1071-1072, src/loop/post-summary.ts:100 and src/loop/failure-comment.ts:44.
  - Proposed: State one list in L3800 that adds the round's record and `host.log`, and have L2732–2735 refer to it as "as for any thread".
- L2577 says `fixed` and `withdrawn` always reply on the thread; L2611–2612 says a thread already resolved when handed over gets no reply. Should the table carry the exception?
  - Code: A closing ruling on a thread already resolved gets no reply, and the resolve is still sent. At src/loop/verdicts.ts:213-215 and the verdicts.test.ts test "a thread already closed and ruled fixed is closed again, with no reply, rather than assumed closed".
  - Proposed: Yes. The table's `fixed` and `withdrawn` rows should say "where the thread was open". L2581, "Every ruling a round gives on a thread is a reply", needs the same exception.
- L3006 says the spend line leads with the tokens, "which every reviewer reports"; L3021–3028 has rounds with no cost and episodes with no spend line. Does every reviewer report tokens?
  - Code: Every cost a round has carries tokens, but a round can have no cost, as a run stopped before a CLI that reports at the end could report. Such a round has no figure. With no costed round there is no line. Costed rounds with no completed message give "No spend was reported over N rounds". At src/loop/spend-line.ts:47-57.
  - Proposed: L3006 should say "which every round with a cost carries", not "which every reviewer reports". The no-message line, "No spend was reported over N rounds", should be stated as well.
- The exit table at L3122–3128 has no row for 1, only "Anything else", while L3138, L3142 and L3331 treat 1 as the named failure status. Should 1 have a row of its own?
  - Code: Every review that could not run exits 1, and a throw past the trap does too. Statuses 0, 1, 2, 3 and 4 are the only ones the command gives. At src/review/output.ts:163, src/review/output.ts:213-229 and src/cli.ts:225.
  - Proposed: Give 1 its own row, "The review could not run. Reports the lines on stderr", and keep "Every status outside the table reads as 1" for a crash or a command that could not start.
- L3089 has `squiz threads` list the pull request for the current branch; L3106–3107 has `squiz reply` act on the pull request the directory has checked out. Can the two differ, as on a detached `HEAD` (L3881)?
  - Code: No. Both call the same `targetOf(process.cwd())`, which is the venue's `readChange` with no number asked. On a detached `HEAD`, both refuse with the same line. At src/cli.ts:143-156, src/cli.ts:161 and src/cli.ts:207.
  - Proposed: Use one wording for both: the open pull request whose head is the branch checked out in the directory the command runs in.
- L3382 tells the agent to run `squiz status 41`; L3409 gives `squiz status` no argument and has it list every review. Does `squiz status` take a pull request number?
  - Code: No. `status` ignores its arguments and lists every review in the repository. `squiz review` still prints "`squiz status 41` shows whether one takes it later". At src/cli.ts:61-71 and src/review/review.ts:284.
  - Proposed: Keep L3409. The line at L3382 and in the code should say `squiz status`.
  - Decision needed: The code prints a command form that does not exist. Either the message drops the number, or `squiz status` starts to take one. Both are code changes. #909 tracks it.
- L3479–3481 says the record keeps how many findings were not posted, not which, and nothing lists them where the round left threads open; L3804 says the round's record keeps each finding no thread holds, `squiz review` prints each on stderr, and a headless handoff carries each. Which is right?
  - Code: L3804 is right. A round that leaves the episode open keeps each finding no thread holds in its record's `unthreaded`, beside the count. `squiz review` prints each on stderr as "round N raised this on no thread: …", and the handoff lists them under "Findings on no thread". `squiz status` prints only the count. At src/host/host.ts:1045-1052, src/review/review.ts:529-530 and src/host/handoff.ts:67-80.
  - Proposed: Keep L3804. L3479–3481 should say that `squiz status` shows only the count, and that the record and `squiz review` hold each finding.
- L3084 says `squiz init` links `squiz` onto `PATH`; L3498–3503 says it also adds the permission rules. Should the table say both?
  - Code: It does both. It links onto `PATH` and allows the commands in Claude Code's user settings, and the exit is the link's alone. At src/review/init.ts:22-24.
  - Proposed: Yes. The table row should say "Links `squiz` onto `PATH`, and allows its commands in Claude Code's user settings".
- L3796 says nothing is posted when GitHub is unreachable; L3957 says a call reaching a bound is GitHub unreachable and the comments that landed stay. Is "nothing is posted" only for an outage before posting starts?
  - Code: Yes. A `gh` call that reaches its 30-second ceiling is `unreachable`. Before posting starts, that fails the round with nothing posted. During posting, it is one failed post among the outcomes. The round exits 1 only where every finding failed to post, and otherwise exits as its outcome says, with the landed comments kept. At src/venues/github/gh.ts:228-231 and src/loop/round.ts:743-753.
  - Proposed: L3796 should cover an outage before posting starts. L3957 is wrong to say the round exits 1. A bound reached while posting is the "Some comments post and others fail" row, or the "No finding posts" row where none landed.
- L3656 makes the `pi` reviewer row present where the model runs at the configured thinking level; L3697 makes a differing level a warning. Is a differing level a warning row, or not present?
  - Code: It is a warning: "warning: thinking <asked> runs at <level> on this model, which offers only …". A level that cannot be read is a warning too. At src/review/doctor.ts:549-558 and the doctor.test.ts test "a thinking level the model does not offer is a warning naming the level pi runs it at and the levels the model offers (#709)".
  - Proposed: Keep L3697. L3656 should say the row is present where the level matches, and a warning where it differs or cannot be read.
- L3893 calls a stderr line a pointer rather than a report, yet L3800–3803 put GitHub's answer on stderr and leave it out of the comment. Is the failure comment the fuller surface for those rows?
  - Code: No. For a ruling not applied, a reason not posted and a closing reply not posted, stderr carries GitHub's answer. The summary's Notes and the failure comment carry the thread and the ruling without it. At src/loop/verdicts.ts:277-285 (stderr) and src/loop/summary-body.ts:407-436 (the comment).
  - Proposed: Qualify L3893. A stderr line is a pointer, except for those rows, where GitHub's answer reaches only stderr and `squiz status`.
- L94–96 and L3913–3915 (R3.1.4, R8.3.3) say a failed round closes nothing and the episode stays live; L3841–3854 (R8.1.3) has the failure comment of a last-round failure say "The review is closed", while L3856 says the next run closes it. Is the episode closed when that comment is posted, or only at the next run?
  - Code: Only at the next run. A failed round writes no `closeReported`. It reads the bounds only to word its comment, which says "The review is closed: … No round runs again." The next trigger finds the bound spent and writes the close. At src/loop/round.ts:730-736, src/loop/failure-body.ts:79, src/loop/round.ts:1343-1347, and the round.test.ts tests "#544: a failed round that was the last the cap allows says the review closed" and "a killed round whose floor reached the token bound closes the episode at the next firing, with its summary".
  - Proposed: Keep L94–96 and L3856. L3841–3854 should say the comment states that no round runs again, and that the episode is closed when the next run records the close and posts the summary.

## Decisions

### Features

- **PQ1, squiz starts and drives a headless fixer: cut.** A caller with no live session, such as SWE-drill, runs the loop itself: it runs `squiz review`, starts its own fixer on the threads it prints when it exits 2, and stops at 0 or 3. That is the same loop a coding agent runs on the GitHub venue, so squiz keeps one way of working, and never starts an agent. Headless Runs' requirements leave the list, apart from what an interactive run also uses. SWE-drill moves to its own loop before squiz removes the code.
- **PQ3, resuming one fixer across rounds: cut with PQ1.**
- **PQ5, the `closed.json` and `stopped.json` markers: cut with PQ1.** A caller reads `squiz review`'s exit status instead. #910 removes all three.
- **PQ6, recording the first prompt as a local change's description: kept.** Under the local venue the reviewer has no pull request to read intent from, and the first prompt the coding agent was given is that intent. R3.7.6–R3.7.8, R4.4.17 and R4.4.18 stay, without R3.7.7's `SQUIZ_FIXER` clause, which goes with #910.
- **PQ7, closing on a clean state after the state behind it is superseded back to it: cut.** It handles a person deleting a reply mid-review, which § 11 leaves to #819's list. B is recorded superseded, and the episode stays open for the next commit or reply.
- **PQ2, Herdr and tmux panes: kept, and simplified.** Herdr starts the reviewer through `layout.apply`'s argv, and tmux from separate arguments, with no shell to type into (#911). The requirements about typing a line, its length and control characters leave the list with that change.
- **PQ4, general threads built from conversation comments: cut.** A `change` finding goes on a file-level review thread of the changed file it most concerns, so it still counts as open and blocks the close (#889), and squiz keeps one kind of thread (#913). R5.12's general-thread requirements leave the list.
- **PQ8, signing Copilot in from `copilotTokenFile`: kept, with a default.** The reviewer signs in from it where Copilot drops `COPILOT_GITHUB_TOKEN` from its hooks, as SWE-drill's does. With the setting unset, squiz reads `~/.config/squiz/copilot-token` where it exists, and is silent where it does not (#914).
- **PQ-A2, closing without a round when a bound is found already spent: cut.** The round that spends the last of the round cap or the token bound closes the review, a failed round included, and its summary says the budget ran out before the review could be completed (#915). A person lowering a bound mid-review is on #819's list. The "resolved, ruling unknown" count and the summary rebuilt from GitHub's thread state leave the list.
- **PQ-B1, the pre-review and posting time budgets: cut.** A round keeps the reviewer's time bound and the 30-second cap on each GitHub call, and posts every finding however long posting takes (#916). R8.0.31, R8.3.7, R8.3.11 and R8.3.5's parts leave the list.
- **PQ-A1, the local venue: kept.** A user chooses whether a review's record is kept on GitHub or in local files. Consolidating it with the GitHub venue is left for later.

## Not a requirement but needs a home

### To docs/notes

- L49–51: `gh pr comment` and `gh pr review` take a body only, so anchored comments go through `gh api`, and resolving, re-opening, hiding and showing exist only in GraphQL. Proposed note: "What gh and the GitHub REST API cannot do for review threads".
- L157–161: GitHub gives reply times to the second, and general-thread replies have REST ids from a different sequence than review-thread replies, so the two cannot be ordered within one second. Proposed note: "GitHub comment ids and timestamps do not order replies across thread kinds".
- L141–143, L3373: `ps` can be slow enough on a loaded machine that a lock deadline passes while the lock is being taken; the check that tells whether a round host still runs is bounded at 2,000 ms. Proposed note: "ps latency under load".
- L524–526: Copilot runs a plugin's hook with the plugin root as its working directory; Claude Code runs it in the session's `cwd`.
- L592–593: Claude Code runs a hook command under `/bin/sh`, Copilot under `/bin/bash`.
- L563–569: Claude Code 2.1.321 fires `UserPromptSubmit` under that name only; Copilot 1.0.110 fires it from the plugin's `hooks.json` as well as its own `userPromptSubmitted`; both send `prompt` and `cwd`.
- L574–577: Copilot fires `UserPromptSubmit` for a subagent's brief, with `agent_id`, in the parent's `cwd`; Claude Code 2.1.321 fires none for a subagent.
- L580–581: both runtimes hand a session's environment to its hooks.
- L602–617: Copilot fires `Stop` and `SubagentStop` with Claude Code's payload fields, keeps transcripts at `<COPILOT_HOME>/session-state/<id>/events.jsonl`, puts no socket in `CLAUDE_CODE_MESSAGING_SOCKET`, and a killed extension leaves a socket file that refuses connections.
- L629–634, L820–822, L856–859: Claude Code 2.1.321 sends every final-message and transcript field; Copilot 1.0.110 sends no `last_assistant_message` on `Stop` and no `agent_transcript_path` on `SubagentStop`, and writes a subagent's events into its parent's `events.jsonl`. Proposed note: "What Copilot's stop hooks carry".
- L640–642: in an interactive session, Claude Code fires several `SubagentStop`s with an empty `agent_type`, new `agent_id`s and no transcript after a turn ends.
- L645–648: Copilot fires a `Stop` carrying the subagent's id and the parent's transcript just before that subagent's `SubagentStop`.
- L870–872: Claude Code and Copilot fire a subagent's `SubagentStop` before its parent's `Stop`.
- L736: Copilot loads extensions only with its experimental features on.
- L898–899: Copilot's `--resume` fails on an id it cannot find; `--session-id` resumes a session it finds and starts one where it finds none.
- L901–905: on Copilot 1.0.110, a fixer without the auto-update, telemetry and GitHub MCP flags reached `cafe.github.com` and `telemetry.enterprise.githubcopilot.com`.
- L910–911: Claude Code's `acceptEdits` runs file and read-only commands such as `touch` and `ls` without a grant; Copilot runs `ls` and refuses `touch`.
- L1005–1007: both CLIs hand the hook the session's id on every stop.
- L1018–1019: both CLIs exit 1 at once on a session they cannot find, before any stop fires.
- L1623–1625: Claude Code fires `SubagentStart` in the subagent's own worktree when it is dispatched with isolation, before it does any work. Proposed note: "Where Claude Code fires SubagentStart for an isolated subagent".
- L1625–1626: a Copilot subagent works in its parent's directory. Proposed note: "Copilot subagents share their parent's working directory".
- L1628–1631: a Claude Code subagent dispatched into its own worktree fires no `UserPromptSubmit` there. Proposed note: "Isolated Claude Code subagents fire no UserPromptSubmit".
- L1776–1777: a new Herdr pane's shell can drop part of a typed line longer than 512 bytes before its line editor starts. Proposed note: "Herdr panes drop long typed lines".
- L1847–1849: neither tmux's nor Herdr's pane close reaches a process in its own session, and a command that ignores `SIGHUP` outlives a tmux window. Proposed note: "A pane close stops nothing".
- L1973–1976: `git gc --prune=now`, `git prune` or `gc.pruneExpire=now` delete a fetched head no ref reaches; ordinary `git gc` keeps it two weeks. Proposed note: "Pruning removes a fetched head commit".
- L2066–2070: Copilot finds its own login through `loggedInUsers` and `lastLoggedInUser` in `<COPILOT_HOME>/config.json`, with the token in the system credential store (Copilot 1.0.109). Proposed note: "How Copilot finds its login".
- L2073–2077: Copilot leaves `COPILOT_GITHUB_TOKEN` and `GITHUB_TOKEN` out of the environment it gives its hooks, so a round host a hook started lacks them (Copilot 1.0.112). Proposed note: "Copilot's hooks never see COPILOT_GITHUB_TOKEN".
- L2225–2226: a pane's shell reads a newline in an argument as a key press.
- L2227–2229: `pi` silently drops a tool name its grant does not carry.
- L2249–2250: `pi --model` matches bare names loosely and sends an unknown id to the provider unchanged.
- L2289–2290: `pi` retries a failed model request itself.
- L2338–2344: on Copilot 1.0.107 with `--no-auto-update` and `--disable-client-telemetry`, a review reached only `api.github.com` and `api.enterprise.githubcopilot.com`; without them it also reached `cafe.github.com` and `telemetry.enterprise.githubcopilot.com`.
- L2356–2358: Copilot 1.0.109 prints `Error: No authentication information found.` and exits 1 before any request when it finds no login.
- L2363–2366: Copilot refuses an unavailable model given on `--model` (exit 1, nothing spent), but one given only through `COPILOT_MODEL` runs on another model and exits 0.
- L2390–2393: Copilot hands an MCP server its own environment, and validates no MCP call's arguments.
- L2412, L2418, L3980: Copilot exits by itself whether or not the review finished; its `inputTokens` already includes cache reads and writes; its usage line is Copilot's own total. Proposed note: "What Copilot's usage line reports".
- L3037–3038: a `pi` run killed by the time bound reports only the spend of completed messages. Proposed note: "What pi reports when killed mid-run".
- L3042–3043: a reviewer CLI can run a model other than the one configured. Proposed note: "Reviewer CLIs may substitute the configured model".
- L3148: Claude Code can hand the agent less of a shell command's output than it printed. Proposed note: "Claude Code truncates long Bash output handed to the agent".
- L3387–3389: GitHub goes on reporting a pull request's old head for some seconds after a push lands, while `@{push}` already names the new commit. Proposed note: "GitHub's PR head lags a push by seconds".
- L3577–3578: Copilot takes tool approvals only from `--allow-tool` flags at session start. Proposed note: "Where Copilot reads tool approvals".
- L3649: `gh auth token` can print a token `gh` itself does not use. Proposed note: "gh auth token versus gh auth status".
- L3683–3685: `pi` runs a model at the nearest level it offers, looking above first, and says nothing; DeepSeek V4 Pro offers off, high and max. Proposed note: "How pi resolves a thinking level a model does not offer".
- L3685–3695: `pi`'s RPC mode answers `get_available_thinking_levels` and `get_state` before any prompt, with no model request. Proposed note: "pi RPC reports thinking levels without a model call".
- L3700–3702: no `copilot` command reports a sign-in without reaching the model. Proposed note: "Copilot has no offline sign-in check".
- L3971–3974: a tmux window runs its command as it opens; a Herdr pane runs nothing until its start succeeds. Proposed note: "When a multiplexer pane starts its command".
- L4008, L4012: Node decides to strip types by the `.ts` extension, and Copilot starts only an `extension.mjs`. Proposed note: "Why bin/squiz is a shim and the extension is .mjs".
- L4091–4097, L4103–4105: where Claude Code and Copilot copy an installed plugin; Claude Code deletes an old version 14 days after an update, and `copilot plugin update` replaces in place. Proposed note: "Where each runtime keeps an installed plugin".
- L4125–4126: Copilot matches a `shell(...)` rule on the command name alone. Proposed note: "Copilot shell rules match the command name".

### To an issue

- L26: squiz does not check that the reviewer runs a different model from the coding agent. Proposed issue, only if wanted: "Warn when the reviewer and the coding agent run the same model".
- L507–509: an orphaned reviewer runs past its time bound until some trigger runs. Proposed issue: "Stop an orphaned reviewer at its bound when no round host is alive".
- L748–749: a wake post that finds nothing listening is never retried. Proposed issue: "Retry or re-deliver a note whose wake found nothing listening".
- L904–905: the hosts a Copilot fixer reaches with the flags have not been measured. Proposed issue: "Measure the hosts a Copilot fixer reaches".
- L1152–1162: a headless episode can be left open with neither `closed.json` nor `stopped.json`, when the round host died, the state was unwritable or a fixer's start is unknown. Proposed issue: "Mark a headless episode whose round host died".
- L1180–1181: two coding agents on one branch in one tree share an episode, and nothing detects it. Proposed issue: "Detect two coding agents sharing one worktree's episode".
- L1369–1374: three commands branch on the venue outside the contract. Already #835; remove the list from the spec and keep R4.2.10–R4.2.12 as plain requirements.
- L1375–1379: the round host names a change it has only the key of as `PR #<key>`, wrong under local. Already #829; remove it from the spec.
- L1965–1972: a snapshot's disk grows with the repository and with concurrent reviews, and one nothing removes stays until the OS clears it. Proposed issue, only if wanted: "Snapshots cost a full checkout per round".
- L1976: nothing guards a round against pruning, which breaks a running round's history tools. Proposed issue: "Pruning the repository during a round breaks the reviewer's history tools".
- L1977–1978: a repository whose checkout takes longer than the 30 seconds before the review cannot be reviewed. Proposed issue: "Large repositories cannot be reviewed: the snapshot checkout exceeds the pre-review bound".
- L2086–2087: a user who signs Copilot in through `GH_TOKEN` or `GITHUB_TOKEN` alone has no model credential in the round, and nothing handles it. Proposed issue: "Copilot signed in through GH_TOKEN alone has no credential in the review".
- L2089–2092: the system credential store stays readable to the reviewer, and an OS sandbox would close it. Already #529.
- L2311–2313: a Copilot prompt over 128 KiB is not handled. Proposed issue: "Handle a Copilot prompt longer than one argument allows".
- L2343–2344: the model host of Copilot plans other than the one measured is unknown. Proposed issue: "Measure the hosts a Copilot review reaches on other plans".
- L2359–2360: a signed-out Copilot that words its error differently is not recognised. Proposed issue: "Recognise a signed-out Copilot reviewer by more than one stderr line".
- L2379–2381: with no model configured or set by the user, a Copilot round runs on whatever Copilot falls back to, which may be the coding agent's own model. Proposed issue: "Decide which model a Copilot reviewer runs on when no model is set".
- L3479–3481: findings a round could not post are listed nowhere when it leaves threads open, if L3804 is not right. Proposed issue: "List the findings a round could not post when it leaves threads open".
- L3787: why tmux or Herdr refused a pane is not kept. Proposed issue: "Record why a pane could not be opened".
- L4007: no review has run on Linux. Already #722; drop the issue reference from the spec.
- L4298–4306, L4310–4313: the cases of a person's intervention are tracked on #819. The process rule and § 11.3 Decision belong there and in `CLAUDE.md`, not in the spec.

## Doubtful

The default rule settles what it can (see Settled by the default rule below). What is left here is what the rule does not decide: a guarantee, a bound or a name that no file or printed field carries, or what the reviewer alone sees.

### Requirement, or how the code works?

- L26: "squiz does not check it", of the reviewer's model. A stated exclusion that is a requirement, or rationale?
- L72–73: a marker is matched up to and including the character after the name, so `**Squiz review` never matches a reviewer comment. Observable, or how the matching is done? (R2.2.2)
- L120–124 (R3.2.3): `closed.json` and `stopped.json` in a headless run. Does a person or the coding agent read either, or only squiz?
- L157–161 (R3.2.36): `squiz status` prints the latest activity as the last six characters of its identifier (R7.3.3). What does Replies print when the latest activity is two identifiers?
- L283–286 (R3.2.24): no state queued while the summary is posted is stopped by a close it arrived before. An observable guarantee, or race handling that belongs in the code?
- L424–427 (R3.3.3): "The coding agent … never closes one." A requirement on squiz (no command resolves a thread), or guidance to the coding agent?
- L469–471 (R3.6.2): the round host takes the oldest queued state and exits when nothing is queued or the worktree is gone. Observable, or how the code works?
- L732–733 (R3.8.10): the JSON line posted to the socket is Claude Code's messaging-socket contract. A requirement, or a dependency's behaviour for a note?
- L748: "the note goes back to wait for a pull". Nothing defines a pull.
- L1520–1523: the built head's author and committer `squiz <squiz@localhost>`, dated 1970-01-01. Only the reviewer sees it, in the snapshot. A requirement, or the code's means to R4.4.13?
- L1572–1573, L3573–3575 (R4.4.18, R7.4.16): the write-and-rename is the code's. Is "a reader never sees a partial `prompt.md` or `settings.json`" a requirement?
- L1794–1796: the start fails when the reviewer's command is not on the shell's path, or the reviewer has not started 15 seconds after the line was typed. A bound a user sees, or a threshold the code picked?
- L1873–1878: the base is named `refs/squiz/base` in the snapshot, which the reviewer could see through `git_show`. A requirement?
- L2179–2183: an adapter may ship files its CLI runs (the `pi` extension, the Copilot server). A requirement, or layout that belongs with § 9?
- L2227–2233, L2317–2318 (R5.7.3, R5.8.4): the exact tool grants and "no other extension runs". Requirements (a user's extensions do not run), or Confinement's mechanism?
- L2399–2403 (R5.8.14): the MCP error text, and a report recording what the model sent, which differs from `pi`'s converted reports (L2267–2268). Only the reviewer model sees it. A requirement?
- L3376–3378, L3780 (R7.2.22): the 10-second wait for a live process to hold `host.lock`. A threshold no person sets, but it shapes when exit 1 appears. Keep the number?
- L3404–3405 (R7.2.24): output "computed from what the round read back from the pull request". Observable, or how the code works?
- L3639, L3714 (R7.6.4, R7.6.18): doctor's 15-second version bound and 60-second Copilot prompt bound. Bounds a person sees, or thresholds the code picked?
- L3869–3871 (R8.1.7): "a run ending at the gate". Nothing in the requirements defines the gate. Requirement, or a term of the code?
- L3994, L4031–4062 (R9.0.1, R9.2.2, R9.2.3): repository and module organisation. `CLAUDE.md` says § 9 fixes the layout. Are these spec requirements or project rules?

### Requirement, or something else?

- L1743–1746 (R5.1.7): "no stage selects or budgets files for the reviewer". An observable property, or a statement of what squiz does not do?
- L2456–2498 (R5.9.1): the charter's rules, scope choice included, are one "what the prompt must carry" requirement. Should the scope rules be requirements of their own?
- L2749–2753 (R5.12.10): what happens when a person deletes or edits a general finding. A requirement, or a case for #819's list under § 11?
- L3017–3019, L3038–3039 (R6.2.5): a round figure "given as unknown". What is printed? There is no example.
- L3893–3894: "a line is a pointer rather than a report". Requirement or rationale?
- L4099: "updates both" is an instruction to the user. Requirement or getting-started text?
- L4192–4194 (R10.2.8): "without it the review reports no convention violations". A requirement, or a description of the reviewer?
- L4248–4249: the token file "belongs outside the repository, where the reviewer cannot read it". Guidance to the user, or something squiz enforces?
- L4274–4279: § 11's preamble states scope and no observable behaviour. Any requirement here?
- L4296–4299 (R11.2.1): an explicit absence of specified behaviour. Keep it as a requirement?

### Same requirement, or two?

- R4.2.10 (`squiz threads` and `squiz reply` call a GitHub change `#41`) against R7.1.2 and R7.1.5, whose examples read `#185` and `PR #185`. One naming rule, or two?
- R3.4.1 (a cap of R hands threads back at most R−1 times) against R3.9.23 (the fixer runs at most R−1 times). The second may follow from the first.
- R3.1.4 (a failed round closes nothing) against R8.3.3 (a failed round hands no threads back and closes no episode).
- R8.0.31 (the posting reserve runs out) against R8.3.7 (stopping the reviewer comes out of the reserve, and a round whose reserve is spent posts nothing).
- R7.6.11 (doctor's Node row requires 24 or later) against R9.1.4 (squiz needs Node 24 or later). Kept both: one is the check, the other the requirement it checks.
- R3.2.7 (the unreadable-state-file message) against R8.0.15 (what each reader does when the state file is unreadable) and R7.3.16 (`squiz status`'s line for it).
- R5.0.1 (the reviewer has no GitHub access and reports through calls) against R5.10.1 (results come only through three calls).

## Settled by the default rule

A detail is a requirement if a command prints it, or a person or the coding agent reads the file or field it is in. If only squiz's own code reads it, it is how the code works and is dropped. Ids are not renumbered, so a removed id leaves a gap.

### Moved into the requirements

- L157–161: the latest activity's two-identifier form. `squiz status` prints the latest activity. Now R3.2.36; the Replies display of it stays Doubtful.
- L1065–1069: the round's reservation of the fixer as `unknown`. The field is in the state file and is dropped, but what a person sees, that no later fixer starts, is now R3.9.33.
- L1596–1603: the local venue's latest activity. `squiz status` prints it, and every local comment sharing one time makes it both identifiers whenever both kinds of thread hold replies. Now R4.4.31.
- L2955–3004: the per-round record. Its fields are dropped, and the counting rules for `raised` and `ruled`, which define what the summary's Rounds line prints, are now R6.1.15.

### Already stated, and kept

- L110–124 (R3.2.2): `update.md` is what a resumed fixer reads, so it stays in R3.2.2. The state file's own fields are dropped: `squiz status` prints what a person needs from it (§ 7.3).
- L619–634 (R3.7.11): the coding agent reads the handoff, which R3.9.8 already states, final message and transcript included. R3.7.11, the stop's payload fields, is removed.
- L1052–1063, L1047–1048, L1072–1073 (R3.9.24–R3.9.26): `host.log` names the fixer's outcome and pid, and a person reads it, so R3.9.25 and R3.9.26 stand. The record's `fixer` field and the pid-and-start-time method are dropped.
- L1413: the snapshot's `<digest>-local` and the pane `squiz-local-r2`. A person sees both; R4.4.2 with R5.2.1 and R5.3.7 states them.
- L1917–1931 (R5.3.7): a person sees the snapshot's path in `host.log` and the pane, so the digest's form stays in R5.3.7.
- L3905–3906 (R5.7.8): a `pi` cost read at the kill reaches the summary's cost, which R5.7.8 states.
- L1417: `squiz review local`. The round host prints it, but L1417 says local `squiz review` takes no number; the contradiction on L1375–1379 decides it, and nothing is added here.

### Dropped as how the code works

- L168–173: the Reviewing record's fields. `squiz status` prints the columns (§ 7.3).
- L177–180: the fields whose absence makes the state file unreadable. R3.2.7 keeps the message.
- L302–303: the rulings stored by thread node id.
- L317–318, L332–333: the count of a closed episode's records.
- L480–482 (R3.6.3): `host.lock`'s pid and start time. The stderr line at L3377 names `host.log` and `squiz status`, not the lock's contents.
- L489–499 (R3.6.5): the orphan recovery's steps.
- L595–598, L607–617 (R3.7.9, R3.7.10): the owner record's content, and the one-second socket wait.
- L658–671 (R3.8.2): the note file's `key=value` format. The owner learns the result from `squiz review` or `squiz status` (L757–759), not from the file.
- L923–925 (R3.9.14): `SQUIZ_FIXER` and the dropped `CLAUDE_CODE_MESSAGING_SOCKET`. Their effects stay.
- L993–999: `fixerSession` in the state file.
- L1029–1033: how a failed resume is detected.
- L1452–1461: `base.json`'s field names and format. What the record holds is in R4.4.7.
- L1347–1350: `anchor-refused` and `posted-without-thread-id`. R5.12.3 keeps the fallback.
- L1332–1334: venue calls never throw. R8.3.11 keeps the deadline.
- L2046–2057 (R5.4.6): the GitHub variables' names. R5.0.1 keeps "the reviewer has no GitHub login".
- L2037–2044: the report file's `read` lines. R6.1.12 keeps what the summary says.
- L2135–2142: the adapter interface.
- L2211–2219: how each adapter tells the history tools where the snapshot is.
- L2256–2266: `reports.jsonl` and its line kinds.
- L2351 (R5.8.10): `stderr.txt`. R5.8.10 keeps that Copilot's stderr reaches the round's.
- L2612: the resolve sent on an already-resolved thread.
- L2836–2838 (R6.1.6): the Rounds list read from the state file. Its consequence stays.
- L3002–3004: a missing or ill-typed field in the per-round record.
- L3087: the `cwd` a start or prompt hands to the venue.
- L3767–3769 (R8.0.8): a `gh` body read to its end.
- L3952–3953 (R8.3.11): a part timed as one deadline.
