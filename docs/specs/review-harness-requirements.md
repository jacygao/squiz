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

- **R2.1.1, R2.1.2, R2.1.3, R2.1.4** Squiz reads a pull request's description, base and head refs and their commits, and its review threads with whether each is resolved. It posts review comments anchored to a file and line, review comments on a file with no line, and replies inside a thread; resolves and re-opens threads; and posts issue-level comments for the summary and a failed round. It does all of this through `gh`. (L36–38, L46, L39–41, L42, L43–45; also L1396, L1398)

### 2.2 Identity

- **R2.2.1** Every comment is posted with the credentials `gh` holds, so the reviewer, the coding agent and the harness all post as the one account `gh` authenticated. (L55–57)
- **R2.2.2, R2.2.3** Each comment's first line opens a bold span with its author's marker: the reviewer `**Squiz reviewer · `, the coding agent `**Squiz coding agent`, the harness at a close `**Squiz review — `, and the harness on a failed round `**Squiz review failed — `. A comment carrying none of them is read as written by a person. (L59–68, L70; also L1589–1590, L2588, L2598, L2722, L2928, L3182, L3186, L3833, L3847, L3099–3100)

## 3. The loop

### 3.0 Preamble

No requirement of its own after merging. Its lines are cited under R3.5.1, R7.2.1.

### 3.1 Terminology

- **R3.1.1** An episode is one review of one pull request in one worktree, from first round to close; a worktree holds one live episode per pull request at a time, and keeps the episodes before it. (L88; also L1169)
- **R3.1.3, R3.1.4, R3.1.5** An episode closes for one of three reasons: its round leaves nothing open, the round cap is spent, or a round reached the token bound. A failed round closes nothing, unless it spent the last of the round cap or the token bound. A close is clean where its round left nothing open and no state behind it not reviewed; every other close is at the round cap or the token bound, and stays closed. (L93–94, L94–96, L98–102; also L3818ff, L446–451)

### 3.2 The state file

- **R3.2.1, R3.2.4** An episode's state lives in `.squiz/<number>/` inside the worktree, keyed by the pull request's number. Wherever squiz makes an episode directory and `.squiz/.gitignore` is missing, it writes one holding `*`, so the state stays out of git; an existing one is left as it is. (L106–108, L130–132; also L1394, L1405, L4117–4119)
- **R3.2.5** A reviewed state of the pull request is its head commit plus the latest activity on the reviewer's threads: the newest reply, by anyone other than the reviewer, on a thread the reviewer opened. Replies on a thread a person opened are no activity; editing a reply changes nothing; deleting one can change the newest, which counts as a change. (L145–156; also L1599–1602, L3423, L4285)
- **R3.2.6** Each state's record has one of five statuses: Queued, Reviewing, Reviewed (exit status and open threads; or *reviewed clean, episode open*), Failed (with why), Not reviewed (with why: closed first, or superseded). (L163–171; also § 7 `squiz status`, L3407ff)
- **R3.2.8, R3.2.10, R3.2.11** A trigger acts on the pull request's current state by its record: no record queues it and starts a round host where none runs; Queued starts a round host where none runs; Reviewing by a live host does nothing; Reviewed or Not reviewed queues nothing, and `squiz review` returns that result with the threads as they stand now. Only `squiz review` retries a failed state, never a hook, and the retry is queued behind every state already queued or recorded. A retry that fails again posts its failure comment, exits 1, writes no second note to the owner, and its stderr tells the coding agent not to run the command again. (L190–207, L192–193, L211–215, L215–217; also § 7 `squiz review`)
- **R3.2.9** Where a reviewing record's round host cannot be told running or gone, the trigger recovers, queues and starts nothing; `squiz review` exits 1 naming the host it could not check, and a hook returns. (L200–204; also L3781, L3427)
- **R3.2.12, R3.2.13, R3.2.14, R3.2.20** Each state gets at most one review: repeated triggers for a state already queued or under review post one set of threads and at most one summary. An episode runs one round at a time, oldest queued state first; only a trigger queues a state, never the round host; and every queued state ends reviewed or with a result of its own. (L219–221, L221–222, L224–225, L257–259; also L3082, L469)
- **R3.2.15, R3.2.16, R3.2.17** A round closes the episode only when nothing is queued behind it, except at the round cap or token bound. Where state A's round leaves threads open with rounds remaining, the queued state B is reviewed next. Where A's round leaves nothing open with rounds remaining, A gets no exit status, no summary and no owner note, B is reviewed next, and a `squiz review` waiting on A returns the result of the state the queue ends on (0 or 3 with the close, 2 where B left threads open), or exits 4 when its wait runs out. Where A's round reaches the round cap or token bound with B queued, the episode closes, the summary's Notes name the bound and each state left not reviewed, B is recorded not reviewed, a `squiz review` waiting on B exits 3 with a line saying why, and B's owner gets a note saying the same. (L230, L231, L232; also L3127, L3276–3282, L2915–2922, L3131–3136, L3236–3246)
- **R3.2.18** A state left not reviewed is named by its short head commit, followed by "with different replies" where the state the closing round reviewed, or one queued ahead of it, has the same commit. (L293–300; also L2918–2922)
- **R3.2.19, R3.2.21** A round reviews only the pull request's newest state: a state the pull request has moved past by the round's start is superseded, nothing is reviewed or posted for it, and it is recorded not reviewed with `superseded by 8d21a4f` or `superseded by 3f9c2e0 with different replies`. A `squiz review` waiting on it returns the superseding state's result, reads the pull request afresh where that state has no record, and exits 4 when its wait runs out first. (L245–254, L259–263; also L3127, L3135, L3135–3136)
- **R3.2.22** Where A was reviewed clean with B queued and B is then superseded by A, as when the reply that made B is deleted, B is recorded superseded and the episode stays open for the next commit or reply. (L265–275) (PQ7)
- **R3.2.25** A close at the round cap or token bound stays closed in its worktree: a new commit or reply queues nothing and `squiz review` prints the close; a second episode on that pull request needs another worktree on the same branch. (L311–314; also L3131–3134, L3320–3328, L448–450)
- **R3.2.26, R3.2.27, R3.2.28, R3.2.29, R3.2.31** After a clean close, a state with no record on a head other than the one the close reviewed starts a new episode in the same worktree, with its own round cap and token bound, its own summary, the reviewer's rulings carried over and the closed episode's threads included; `squiz review` waits on it as on any state. A state the closed episode recorded on another head answers from that record, naming its own head. New replies on the reviewed head, and a failed record the closed episode wrote, queue nothing, and `squiz review` prints the close. A record queued after the close is treated as any record. (L320–323, L324–326, L327–328, L329–330, L344–363; also L101, L451, L4292)
- **R3.2.32** Where a round of the closed episode is still recorded under review, no new episode starts, and each state queued after the close is recorded failed with `no review ran: round 1 of the closed episode is still recorded under review by round host 4242`; `squiz review` retries it as any failed state. (L348–356)
- **R3.2.34** `host.log` names where the closed episode went: `2026-11-08T09:14:02.511Z a new episode starts on a state the clean close never recorded: the closed one is in /work/squiz/.squiz/41/episodes/1`. (L366–370)

### 3.3 A round, step by step

- **R3.3.1** A trigger reviews pull request `<number>` only where it is open, is not a draft, and has its head branch checked out in the directory the trigger ran in (not another branch, not a detached HEAD); the round host checks open and checked out again when the round starts. Where a check fails, no review runs, nothing is posted and nothing is written to `.squiz/`. (L377–382; also L1393, L4290)
- **R3.3.2** Where the pull request is not open or not checked out, `squiz review` exits 1 and stderr names what it found, as `squiz: no review ran: PR #41's head is "feature-a", and "/work/squiz" has "main" checked out`. (L384–389; also L3371–3372, L4289–4290, L3116, L4290)
- **R3.3.3** Only a reviewer's verdict resolves a thread; the coding agent replies on a thread (to say what it changed, disagree or ask) and never resolves one. (L424–427)

### 3.4 The round cap

- **R3.4.1, R3.4.4, R3.4.5** A round cap (`rounds`) of R allows R rounds, so open threads go back to the coding agent at most R−1 times. Every round counts against it, whether a commit or a reply started it; a run that returns a recorded result is no round and spends nothing. Round R is the closing round: it reviews as any round, then closes the episode whatever is open, posts the summary and hands nothing back. With a cap of 1 the first round is the closing round. (L431–432, L440–444, L446–448; also L4226, L3815, L3835)
- **R3.4.2** A reply on a reviewer's thread with no commit after it starts a round on a new state, which rules on the thread: `withdrawn` where the argument holds, `open` where it does not. (L434–437; also L149–152)

### 3.5 What starts a round

- **R3.5.1** A round starts only from a trigger: the plugin's `Stop` and `SubagentStop` hooks (Claude Code and Copilot alike), or `squiz review <number>`, which a coordinator or CI job can run from a checkout of the pull request's branch; in a runtime with no hook only `squiz review` starts one. (L455–459; also L77–81)

### 3.6 The round host

- **R3.6.1, R3.6.2, R3.6.3, R3.6.4** The rounds of one episode run one at a time in a round host, `squiz host <number>`, outside every trigger's process, with its output in `.squiz/<number>/host.log`. A trigger that queues a state starts one where none runs, detached so it outlives the shell call or hook, and a person never starts one. At most one runs per episode, it exits when nothing is left queued or its worktree is gone, and after it dies the next trigger starts a host for any queued state. (L463–467, L469–471, L480–482, L484–485; also L3088, L3382–3383, L3783)
- **R3.6.5, R3.6.6, R3.6.7** A round whose round host died is not recovered: nothing its reviewer reported is posted, its record stays under review, `squiz status` shows it `killed`, and `squiz review` exits 1 saying the round host stopped before its round ended. Its reviewer and its snapshot are left as they are (#327). (L489–501, L503–505, L507–509; also L1961–1963, L3783)

### 3.7 The hooks

- **R3.7.1** `hooks/hooks.json` registers `"${CLAUDE_PLUGIN_ROOT}/bin/squiz" hook`, with the root quoted so a path with a space stays one word under `/bin/sh` and `/bin/bash`, on `Stop`, `SubagentStop`, `SessionStart`, `SubagentStart` and `UserPromptSubmit`. Only the two stop firings, and `squiz review`, start a round. (L513–514, L530–546, L591–593; also L3087, L4027)
- **R3.7.2, R3.7.4, R8.0.9** A stop firing resolves the pull request whose head is the branch checked out in the payload's `cwd`, records the session that owns the work, queues the state and returns at once; it never runs a round or blocks the agent, and exits 0 whatever it found, an unreadable payload included. Every hook takes its worktree from the payload's `cwd`, never from its own directory, and a stop whose payload has no `cwd`, a relative one, or one in no git worktree queues nothing and says so on stderr. (L515–519, L636–638, L523–528, L553, L560, L3775; also L3087, L3813)
- **R3.7.3** A stop that finds no pull request writes the R3.3.2 line on stderr, naming the branch and the directory. (L519–520)
- **R3.7.6** `UserPromptSubmit` does nothing but hand the payload's `prompt` to the venue (under the GitHub venue, nothing; under the local venue, the change's description), and prints nothing on stdout. (L558–563; also L1392, L1628–1631, L3087)
- **R3.7.7** A `UserPromptSubmit` records nothing and says nothing where the payload carries a non-empty `agent_id`, or where `cwd` is in no git repository. (L572–584; also L924)
- **R3.7.8** A `UserPromptSubmit` with no or an empty `prompt` records nothing and says so on stderr; one whose recording fails writes `no prompt was recorded:` and the reason on stderr; neither line carries the prompt. (L586–589)
- **R3.7.12, R3.7.13** A stop that is not the coding agent's work queues nothing: a `SubagentStop` whose `agent_type` is empty, and a Copilot `Stop` whose `session_id` is not the session its `transcript_path` names. A Claude Code `Stop` is never dropped by the second rule. (L640–643, L645–650)

### 3.8 The report

- **R3.8.1, R3.8.2, R3.8.3, R3.8.4, R3.8.5, R3.8.8, R3.8.9** When a round records its result, the round host writes one note for the session that owns the work and is still alive (a subagent's work to the session that dispatched it), as a file in `.squiz/<number>/notes/<session id>/`. A failed state gets one note however many times it fails, a state not reviewed gets one saying why, and a state with no recorded owner gets none. The note gives the threads left open, each as `squiz review` prints it, after a line such as `Squiz reviewed PR #41 at 3f9c2e0, the work of subagent a402ef8f56c1b2ed1: 2 threads are open:`, with a closing paragraph saying how to fix, reply with `(cd '<worktree>' && squiz reply <id> <text>)` and run `squiz review <number>` again while rounds remain; or, where the episode closed with threads open, `the episode has closed with N threads open:` and the threads with no paragraph after; or that the episode closed with nothing open; or, for a failed round, the reason, `squiz status`, and whether a new commit or one run of `squiz review` retries it or which bound closed the review. (L654–656, L658–671, L671–673, L675–697, L699–701, L714–715, L717–726; also L1633–1635, L4145–4148, L1419, L1389, L3826–3835)
- **R3.8.6** A note prints at most 10 threads, then a line counting the rest: ``3 more threads are open. `squiz review 41` prints them all.`` (L703–704)
- **R3.8.7** Where the threads cannot be listed, or the listing holds none the round left open, the note counts them and points to `squiz review` (`Squiz reviewed PR #41 at 3f9c2e0: 2 threads are open. Run `squiz review 41` to read them.`), and `host.log` says which case and, for a failed listing, why. (L705–712)
- **R3.8.10, R3.8.11, R3.8.13, R3.8.14, R3.8.15** Squiz wakes an idle owner with its note. Where the hook recorded a Claude Code messaging socket, the round host moves the note into `delivered/` and posts its text as one line to the socket, and an idle session starts a turn with it. A Copilot owner is woken through `extensions/squiz-wake/extension.mjs`, which the plugin ships and Copilot starts in each session; it listens on `squiz.sock` in the session's state directory and turns each post into a turn. A post that finds nothing listening fails and is not retried: the note goes back to `.squiz/<number>/notes/<session id>/`, where it was written, or stays in `delivered/` where that move fails, and `host.log` gives both reasons. An owner no wake reaches, a Copilot owner with no socket included, learns the result from `squiz review` or `squiz status`, one `squiz review` run in the background wakes a Copilot owner when it exits, and `host.log` says when no wake reached the owner or a note could not be written. (L728–733, L735–743, L748–749, L751–755, L757–759; also L4028, L4151–4160, L3724–3726, L3724–3727, L4170–4176, L1640, L3814)

### 3.9 Headless runs

No requirement. Headless runs were cut with PQ1, PQ3 and PQ5 (#912).

### 3.10 Parallel coding agents

- **R3.10.1** Each worktree is reviewed on its own: `squiz review` resolves the worktree with `git rev-parse --show-toplevel` from the directory it runs in, and the hook from the payload's `cwd` (for a subagent, fixed when dispatched); one worktree, one branch, one pull request, one live episode per pull request. (L1166–1169; also L88, L520–525, L1354–1360)
- **R3.10.2** Squiz never removes a worktree; whatever created it removes it, and the episode's state goes with it. (L1171–1173; also L4196–4197)
- **R3.10.3** Where a tree's `HEAD` moved to another branch while an episode was live, each pull request's episode keeps its state under its own number, and each reviewer reads a snapshot of its own pull request's head. (L1175–1178)
- **R3.10.4** Two coding agents on one branch in one tree share one episode and one round cap, and nothing detects it (#924). (L1180–1181)

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
- **R4.2.9** A summary and a failure comment have the same markdown body in both venues. (L1362–1363; also L2893–2894)
- **R4.2.10** `squiz threads` and `squiz reply` call a GitHub change `#41`, and a local change by its name. (L1369–1370)
- **R4.2.11** A bare `squiz review` takes the key `local` under the local venue, whose episode directory is always `.squiz/local/`, and a worktree with no recorded base then gets the no-base line of R4.4.9; under the GitHub venue it prints its usage line. (L1371–1372)
- **R4.2.12** `squiz status` prints a numeric key as `#41`, and any other key as it is. (L1373–1374; also L1663–1664)

### 4.3 The GitHub venue

- **R4.3.1** The GitHub venue is the only venue that runs `gh`. (L1384)
- **R4.3.3, R4.3.5** Under GitHub the change is the pull request: its base, head and description come from it, and the run's prompt never stands in for the description. Threads, replies, resolves and re-opens are review threads on it, with `PRRT_` ids, listed in the order each was opened, and outdated and author are what GitHub reports. (L1391–1392, L1396; also L550–551, L562)
- **R4.3.4** Where `squiz review` is given a number and the pull request checked out has another, there is nothing to review and it exits 1. (L1272–1275, L1393)

### 4.4 The local venue

- **R4.4.1** Everything the local venue writes is in `.squiz/local/` of the worktree, and none of it becomes part of the change. (L1402–1406)
- **R4.4.2** The local episode key is `local` everywhere the pull request's number names the episode, including the episode directory `.squiz/local/`. (L1413)
- **R4.4.3** A failure is written as `.squiz/local/failure-<k>.md`, numbered from 1 in the order written and numbered on from the highest present, and the line that reports it reads `squiz: the failure is posted on the working tree`. (L1416, L1556–1557)
- **R4.4.4** Under local there is no draft or wrong-branch case: the working tree is never held. (L1418)
- **R4.4.5** The local `followUp` names the worktree, asks for no commit or push, and gives every command as a subshell in the reviewed worktree: "Fix what applies in /work/squiz-a, and reply on each thread with `(cd '/work/squiz-a' && squiz reply <id> <text>)` to say what you changed or why you disagree. Then run `(cd '/work/squiz-a' && squiz review)` again." (L1422–1433)
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
- **R4.4.18** `prompt.md` is the first prompt any session in the worktree was given, exactly as the payload carried it, and is never overwritten by a later prompt, session or resume. (L1566–1573)
- **R4.4.19** `threads.json` holds every thread, with its id, `path`, `anchor`, `isResolved` and `comments` (each with `id` and `body`), e.g. `{ "id": "T1", "path": "packages/sync/src/queue.ts", "anchor": { "at": "line", "line": 134 }, "isResolved": false, "comments": [{ "id": "C1", "body": "…" }] }`. (L1575–1595)
- **R4.4.20** Thread ids are `T1`, `T2`, … and comment ids `C1`, `C2`, … across all threads, in the order written. Ids start from `T1` in every worktree. (L1597–1598, L1424)
- **R4.4.21** A thread's anchor is a head line (`{ "at": "line", "line": n }`) or the file as a whole. The local venue never refuses a line and always returns the thread id. (L1604–1608; also L2755–2757)
- **R4.4.22** A local thread's URL is the `file://` URL of `threads.json` followed by `#<id>`, such as `file:///work/squiz-a/.squiz/local/threads.json#T1`. (L1609–1610)
- **R4.4.23** A local thread is never outdated, and every comment's author is `local`. (L1611)
- **R4.4.24** After the run, `threads.json` gives each finding with its replies and whether it is resolved, and `summary.md` counts them as § 6 sets out, with a thread that is still open and has a coding-agent reply counted `disputed`. A run that ended before the episode closed has no `summary.md`, and `squiz status` shows where it stopped. (L1613–1618)
- **R4.4.25** A Claude Code subagent dispatched into its own worktree has no description there unless its dispatcher writes `description.md`. (L1628–1631)
- **R4.4.26** `Stop` and `SubagentStop` build the worktree's head, then queue the state and record its owner. A subagent in its own worktree is reviewed in that worktree's `.squiz/local/`, and its result wakes the session that dispatched it. (L1633–1636)
- **R4.4.27** Under `claude -p` or `copilot -p` the review still runs, its threads and summary are written, and its note waits in `.squiz/local/notes/`; nothing hands the findings on after the run exits. (L1638–1645; also L123–124)
- **R4.4.28** `squiz review` takes no pull request number under local. Given one, it exits 1 with `squiz: no review ran: the local venue reviews the working tree, and takes no pull request number`. Any key except `local` is not reviewable. (L1417, L1652–1657; also L3082, L3116–3117, L3117–3118)
- **R4.4.29** `squiz reply <id> <text>` adds the coding agent's reply to the thread in that worktree's `threads.json`, and refuses an id it does not hold: `squiz: nothing replied in T9: threads.json holds no thread "T9"`. (L1660–1662)
- **R4.4.30** Under local, `squiz doctor` does not require `gh`: a missing `gh` is a row at level `present`, which does not fail the check, reading `gh: not found. Not required under the local venue`, and a `gh` that cannot be used is a warning. (L1665–1672; also L3649)

## 5. The reviewer

### 5.0 Preamble

- **R5.0.1, R5.10.1** The reviewer has no GitHub access of its own: its findings, verdicts and finish reach squiz only through three calls, `report_finding`, `report_verdict` and `finish_review`, and squiz posts them; its last message is not read. (L1676–1679, L2502–2510; also L1988)

### 5.1 Invocation

- **R5.1.1** Each round starts one fresh reviewer session, which holds no state between rounds and never edits the code under review. (L1683–1687; also L2096)
- **R5.1.2** The reviewer is handed five things: its working directory, the round's snapshot of the head commit; the change (its name, `PR #41` or `the working tree`, the short sha of the base, its description, the files it touches, and the threads the reviewer opened on it, each with its replies and whether it is resolved); the charter, which ships with squiz and is the same every round; the thinking level from `thinking`, set on every run so it never comes from the CLI's own configuration; and the model from `model`, in the CLI's spelling, or none, which leaves the CLI on the user's default. (L1689–1699; also L2238–2240, L4229–4230, L402–404)
- **R5.1.3, R5.1.4, R5.1.7** The prompt never carries the diff, and its size does not grow with it. After the description it carries a `## History` section pointing the reviewer to `git_log_search`, `git_blame` and `git_show`, and a `## Changes` section listing the changed files one a line as `git_diff` lists them (status, path, `old -> new` for a rename, and `+N -M` or `binary`). The reviewer reads each file's change with `git_diff`, and no stage selects or budgets the files it opens. (L1694, L1713, L1740–1741, L1701–1723, L1743–1746)

### 5.2 The reviewer session

- **R5.2.1** The reviewer runs where a person can watch it, in the first that applies: in Herdr (`HERDR_SOCKET_PATH` set), one `layout.apply` request on Herdr's socket opens an unfocused tab labelled `squiz-<number>-r<k>` whose one pane execs the reviewer in the snapshot; in tmux (`TMUX` set), `tmux new-window -d -n squiz-41-r2 -c <snapshot> -- <program> <argument>…`; otherwise detached, as a child of the round host with no terminal, with a log holding its progress. No shell stands between the backend and the reviewer, so every argument reaches it byte for byte and no shell's startup files run. (L1750–1757; also L28–30, L3416–3417) (#919)
- **R5.2.2** The Herdr tab opens in the workspace named by the triggering process's `HERDR_WORKSPACE_ID`, recorded only when it has the shape `w<number>` (such as `w2`), and in the focused workspace where none was recorded or Herdr answers `workspace_not_found` for it. (L1755, L1762–1766) (#919)
- **R5.2.3** Where a pane cannot be opened, squiz falls through to tmux or a detached child and the round goes on; `squiz status` shows the session as `detached`. A Herdr socket nothing answers on, and a reviewer program found nowhere on the round host's `PATH`, are a pane Herdr refused. (L1798–1801; also L3787) (#919)
- **R5.2.4** The variables the round sets (the adapter's, then the GitHub variables of R5.4.6, last) reach the reviewer on every backend over any value the backend's own environment gives them. The reviewer runs on the round host's `PATH`, not the Herdr server's, and everything else in its environment is the Herdr or tmux server's. (L1803–1815) (#919)
- **R5.2.5, R5.8.18** Each round keeps its reviewer session and the command that resumes it in `.squiz/<number>/rounds/<k>/resume.txt`, with paths relative to the coding agent's worktree, which `squiz status` prints: `pi --session-dir .squiz/41/rounds/2/session --session 0193f2c4-…`, or `COPILOT_HOME=.squiz/41/rounds/2/session copilot --resume=<session id>`. A conversation resumed after the round is not part of the review. (L1817–1832, L2448–2452; also L112, L3450, L3463, L1821)
- **R5.2.6** What a person types into a `pi` reviewer's pane reaches `pi` and is not recorded; a Copilot reviewer's pane takes no input. (L1834–1836)
- **R5.2.7** A reviewer in a pane is stopped as a detached one is: at the time bound squiz signals the reviewer's process group, then closes the pane. (L1838–1849; also L3936–3939)

### 5.3 The snapshot

- **R5.3.1, R5.3.3, R5.3.9** The reviewer never reads the coding agent's worktree. Before it starts, squiz clones the repository into the system temporary directory and checks out, detached, the commit GitHub reports as the pull request's head; the snapshot holds that commit alone and appears in neither `git status` nor `git worktree list`. The change's diff is read from the snapshot, is byte for byte the diff GitHub serves, and no size of change is refused. (L1853–1866, L1880–1885, L1939–1943; also L1528)
- **R5.3.4** A diff that cannot be read fails the round before the review and removes the snapshot, with a reason like `no review ran: the diff of PR #142 could not be read: git exited 128: fatal: 7c1e0d3…...HEAD: no merge base`. (L1885–1891)
- **R5.3.5, R5.7.2, R5.8.3, R5.8.6** Nothing from the tree under review or the repository's local config reaches the reviewer but `AGENTS.md` (and, for `pi`, `CLAUDE.md`): not the repository's hooks, filters or `core.autocrlf`, not the tree's `.pi/` configuration, and not its Copilot hooks, MCP servers, instruction files, skills or agents. No `pi` extension and no MCP server runs but squiz's own, Copilot's built-in GitHub MCP server is off, and the charter is the Copilot reviewer's system prompt, which a same-named agent in the tree cannot override. From the user's own Copilot configuration only the default model and the signed-in user reach it. (L1893–1905, L1913–1915, L2234–2237, L2314–2316, L2321–2337; also L2067–2070, L2117)
- **R5.3.10** squiz removes the snapshot once the round has recorded its result, whatever the result, and before it takes the next queued state. It removes nothing but the snapshot and the directories that removing it emptied, and does not need the worktree to exist. (L1945–1950)
- **R5.3.11** A snapshot that cannot be removed stays on disk, the round's result stands, and `host.log` gets a line like `2026-10-07T04:10:09.623Z round 1: the snapshot at /tmp/squiz-501/44df…-142/rounds/1/tree could not be removed: EACCES: …; it stays on disk until it is deleted`. (L1952–1959; also L3794)
- **R5.3.8** Squiz refuses to make a snapshot where `squiz-<uid>` is a link, is owned by another user, or is writable by group or others, and the round fails before the review. (L1933–1937)

### 5.4 Tools

- **R5.4.1, R5.5.4, R5.7.3, R5.8.4** Every reviewer gets the same tools every round, and no setting changes them: reading (`pi`: `read`, `grep`, `find`, `ls`; Copilot: `view`, `grep`, `glob`), reporting (`report_finding`, `report_verdict`, `finish_review`) and history (`git_log_search`, `git_blame`, `git_show`, `git_diff`), the last two kinds prefixed `squiz-` under Copilot. Nothing else is granted: under `pi` a call outside the grant is refused before it runs, and Copilot disables every other tool, `skill` and every shell tool included. (L1982–1996, L2122–2128, L2227–2233, L2317–2318; also L2142, L1988)
- **R5.4.2** The history tools behave as follows, all in the snapshot: `git_log_search` takes a term matched as literal text and returns the commits that added or removed it, newest first, each with message and changed files; `git_blame` takes a file and a line and returns the commit that last changed it, with author and date, read from the commit and never the working tree; `git_show` takes one commit and returns its author, date, message and change, refusing a range, a tree or a file at a revision; `git_diff` runs only the pull request's own base...head range, and with no path returns the changed-file list (from file 1 or from `from`), with a changed file's path (either name of a rename) that file's diff, and with any other path a line saying so. (L2002–2007, L2024–2025)
- **R5.4.3** No history-tool argument reaches a shell or reads as an option; an empty argument or one holding a NUL is refused; `git_blame` refuses an absolute path, a `..` path out of the snapshot, and a path whose links resolve outside it; no config, attribute or environment setting in or around the repository makes a history tool run a program, read another repository or read another config. (L1998–2029; also L2119–2120)
- **R5.4.6, R5.4.7** The reviewer has no GitHub credential of its own. Under either adapter `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` are set empty and `GH_CONFIG_DIR` names `.squiz/<number>/rounds/<k>/gh/`, emptied before the reviewer starts, so a `gh` it starts finds no login in its variables or its configuration. `gh auth token` can still read the keychain login, which is the login Copilot's last fallback signs in with (#529). Each CLI's model credential is left alone, and Copilot signs in from the first it finds: `COPILOT_GITHUB_TOKEN`, set from the token file where one is in use (R5.4.8) over the round host's value; its own login; then `gh`'s login. (L2046–2057, L2059–2071; also L112–113, L2391, L2331–2333, L4233)
- **R5.4.8** The token file is the `copilotTokenFile` `.squiz.json` names, or else `~/.config/squiz/copilot-token`, where `~` is the home of the user squiz runs as. A file cannot be used where it cannot be read, is empty, or holds anything but one token. A named file that cannot be used fails the round at setup with a reason naming the file. The default file is passed over without a word where it does not exist, and the round runs as if it did not exist where it cannot be used. The token reaches only the environment of the Copilot it signs in: the reviewer's arguments carry the file's path, never the token, and no log, record, reason, summary or failure comment holds it. (L2063–2065, L2079–2084; also L926–929, L4245–4254) (#917)

### 5.5 Confinement

- **R5.5.1, R5.5.2, R5.8.5** Under both adapters, every round, with no setting to change it, no granted tool writes or is a shell, a reporting call writes nothing on disk the coding agent would commit, and a reading tool refuses a path whose real path is outside the snapshot's; under Copilot the reviewer can read nothing else in the temporary directory. (L2096–2103, L2105–2113, L2319–2320; also L1995–1996, § 5.5)

### 5.6 Adapters

- **R5.6.1, R5.7.1, R5.7.6, R5.8.9, R5.8.12, R5.8.13** The reviewer runs at the thinking level `thinking` sets, on every run and never the CLI's own setting (`pi` at another level where the model lacks it; Copilot's reasoning effort with `off` as `none`), and on the configured `model` in its CLI's spelling, or else the user's default. For `pi`, `model` is `provider/id` as `pi --list-models` lists it, a bare id listed under one provider is refused with its full name in the reason, and a `pi` that cannot list its models fails the round at setup. For Copilot, the user's default is `COPILOT_MODEL` in squiz's environment, or else `model` in the user's Copilot `settings.json`, and with neither the round runs on whatever Copilot falls back to. A model the CLI does not offer fails the round at setup, with no review run and nothing spent, and a reason naming `model` and its value, such as `"model" in .squiz.json is "openai/gpt-5", which is not a model pi offers; it must be a provider and model as pi --list-models lists them, such as "openai/gpt-5-mini"`. With no `model`, the reviewer's command line and environment are as without the setting. (L2144–2155, L2238–2240, L2248–2254, L2345–2346, L2362–2369, L2375–2376, L2371–2381; also L4230, L4258–4260, L1696, L3682, L2150–2156, L3711, L3725)
- **R5.6.2** A run that completed no message has a reason that adds what the reviewer said on stderr, in a pane as detached. Where the adapter recognises the cause, the reason is the adapter's (R5.8.11); otherwise it adds the model the run was handed, configured or the user's default: `the reviewer completed no message; "model" in .squiz.json is "gpt-5-nano", which the reviewer's CLI may not offer`, or `…; .squiz.json sets no "model", and the user's default, "gpt-6-astra", may not be one the reviewer's CLI offers`. (L2157–2177; also L2356–2360, L2433–2436, L3789)
- **R5.6.3, R5.8.14, R5.10.2** Squiz checks every reporting call itself, whatever CLI serves it, and refuses a malformed one when it is made, answering the reviewer with the reason as the call's error, so it can call again; every other report of the round stands. (L2185–2189, L2393–2401, L2512–2514; also L2393–2396)
- **R5.6.4, R5.6.6, R5.7.11, R5.7.12, R5.8.16, R5.10.3, R5.10.4, R8.3.3** A round counts as reviewed only where the reviewer made the finish call, whatever ended the run afterwards, the time bound included; its exit status is not read for how it ended. A round that reported nothing and finished found nothing; with no finish the round failed. In a round its host ended, the findings reported before any ending are posted and its verdicts applied, reports arriving after the finish and before the CLI exits count, and a `pi` round whose report file has a line that cannot be read fails with the reports already read still standing. A failed round stays failed: it hands no threads back, and closes the episode only where it spent the last of the round cap or the token bound. (L2191–2195, L2202–2205, L2294–2296, L2297–2300, L2427–2436, L2516–2518, L2520–2522, L3908–3915; also L1684–1685, L2437–2441, L3790, L3792, L3789, L3791, L3789–3792, L2191–2193)
- **R5.6.5** Stopping the reviewer stops every process it started, the history tools' `git` included. (L2197–2200, L2207–2209; also L2444–2446)

### 5.7 The `pi` adapter

- **R5.7.7, R5.7.8, R5.8.15, R5.8.17** Each round records its tokens and cost as its CLI reports them. A `pi` round's cost is the sum of its assistant messages' usage, and a floor ("at least") where the run did not end on a message's usage, where the time bound stopped it, or where its report file could not be read to its end. A Copilot round's figures come from its usage line (tokens as input plus output over every model, AI credits as `totalNanoAiu` at 10⁹ to a credit), only where Copilot exited 0 by itself with token counts, and are never a floor; any other Copilot round records no cost and names no model. The models a round names are the ones its run reported, in the order first named. (L2270–2275, L2277–2285, L2412–2425, L2438–2442; also L2960, L2984, L3030–3031, L3979, L3905–3906, L3007, L3010–3014, L2349–2350)
- **R5.8.19** The Copilot reporting server goes on answering while a history tool runs; a `notifications/cancelled` naming a running history tool stops its `git` and that call is not answered; the server exits when its standard input closes, and on `SIGTERM` and `SIGHUP`. (L2405–2408)
- **R5.7.10** A `pi` run where no message ended normally and no finish was recorded completed no message: the round's reason is the errored message's error text, and the reviewer is not run a second time. (L2291–2293; also L3789)

### 5.8 The Copilot adapter

- **R5.8.8** A Copilot run auto-updates nothing and sends no client telemetry, so it reaches only Copilot's own host and its model's. (L2338–2344)
- **R5.8.11** A Copilot run whose stderr holds `Error: No authentication information found.` is a reviewer not signed in: the reason quotes the line and names no model, as `the reviewer is not signed in to Copilot: it said "Error: No authentication information found."`. Any other wording gets the round's ordinary reason with what Copilot said. (L2356–2360; also L2166–2169, L3789)

### 5.9 Charter

No requirement of its own. The charter ships with squiz and is handed to the reviewer (R5.1.2), and its rules are `charter.md`'s.

### 5.10 Findings

- **R5.10.5** A finding carries `scope` (`line`, `file` or `change`), `file` and `line` (a `file` finding carries the file alone; a `change` finding carries the changed file it most concerns and no line, #920), `severity` (`high`, `medium`, `low`), `headline`, `reasoning` (bullets), `suggestedFix`, and an optional `reference`. (L2524–2537)
- **R5.10.6** Severity means: `high`, wrong now, a security problem, or a broken written convention; `medium`, wrong under conditions the change makes reachable, or a test that passes with its code deleted; `low`, real, narrow and survivable. (L2539–2543)
- **R5.10.8** Every round hands the reviewer every thread it opened on the pull request, resolved and open, from every episode, identified as its own by the reviewer's marker on the opening comment whoever replied since. A thread a person opened is never handed over, ruled on, read or answered, never counts as open, and never keeps the loop going. (L2549–2555; also L152, L414, L414–415, L4286)
- **R5.10.9, R5.10.10, R5.10.12, R5.10.15** Each handed thread gets one verdict: `thread`, `verdict` (`fixed`, `withdrawn` or `open`) and `reason`, required and non-blank on `open` and `withdrawn` and refused on `fixed`; a second verdict on one thread is refused. Where the thread was open, `fixed` replies naming the round and the commit and then resolves it, and `withdrawn` replies with the reason and then resolves it; a thread already resolved gets the resolve and no reply. `open` re-opens or leaves the thread open and replies with the reason, every round it keeps it open. A handed thread with no verdict is treated as `open`, with nothing posted, where the reviewer finished, and is left as handed over where it did not. (L2509, L2557–2565, L2575–2579, L2585, L2593, L2611–2613, L2630–2632; also L3800, L407–410, L307–308)
- **R5.10.11** A ruling's reply opens with the reviewer's marker and the verdict, is posted before the round ends, comes before the resolve on a thread the round closes, and never counts as activity that starts another round: `**Squiz reviewer · fixed**` then `Confirmed in round 2 at 1b86987.`; `withdrawn` reads `Withdrawn in round 2 at 1b86987.` with the reason beneath; `still open` carries the reason alone. (L2581–2609; also L3186)
- **R5.10.13** A ruling made in an attempt that spends no round names the commit and no round, as `Confirmed at 1b86987.` (L2613–2615)
- **R5.10.16** Every finding posted as a thread ends its episode `fixed`, `withdrawn`, `open` (unresolved, no reply from the coding agent) or `disputed` (unresolved, and the coding agent replied); `open` and `disputed` need a person. (L2634–2644; also L1616, L2801, L2814–2828)

### 5.11 The comment format

- **R5.11.1** Every finding's comment is `**Squiz reviewer · <severity> — <headline>**`, then the reasoning as bullets, then `**Suggested fix:** …`, then an optional `> reference` quote that the comment stands without. (L2648–2668)

### 5.12 Pull request comments

- **R5.12.1, R5.12.3, R5.12.4** A `line` finding becomes an inline thread on a changed line, a `file` finding a thread on its file with no line, and a `change` finding a thread with no line on the changed file it names (R5.12.12). A line anchor that cannot be placed is posted on its file with `file:line` in the text; a finding whose file the diff does not carry reaches no thread, the summary's Notes says it could not be anchored, and `squiz review` prints it on stderr. A thread on a file is resolved, re-opened, ruled on, carried across rounds and replied to like an inline one, and counts as open for the exit status and the round cap until a verdict closes it. (L2672–2679, L2686–2692, L2694–2697; also L405–407, L3804, L813)
- **R5.12.2** A finding about code the change did not touch is anchored to the changed line that caused it, with the affected file and line named in the body. (L2681–2684; also L2488–2491)
- **R5.12.12** A `change` finding goes on any file the diff names, a deleted file and a rename that changed nothing included. One whose file the diff does not name is posted on the first file the diff names, in the diff's order, with the file it named in the text: ``**Where:** the change as a whole. The reviewer named `src/sync/helpers.md`, which the diff does not carry.`` Only a diff that names no file, or one that cannot be read, leaves it on no thread, and Notes names it as `- About the change as a whole: All seven new exported helpers lack the required tests (no thread could be opened for it)`. (#920)

## 6. The summary

### 6.0 Preamble

- **R6.0.1, R6.0.2, R6.0.5** When an episode closes, squiz posts one summary comment on the pull request carrying the status of every finding, what each round did, and what the review cost. It is never edited or replaced, and a second episode on the same pull request posts a second comment. A round that leaves threads open for the coding agent posts no summary, and a failed round that leaves a round to run posts its failure comment (§ 8) instead. (L2767–2768, L2768–2770, L2777–2779; also L232, L420, L3811, L3805)
- **R6.0.3** Under the local venue the summary is written to `summary.md` instead of a comment. (L2770; also L1415, L1545, L1552)
- **R6.0.11** The round that spends the last of the round cap or the token bound closes the episode, whether it reviewed or failed. A failed one records the close, posts the summary of the rounds that ran, and then its failure comment; it is recorded failed, carrying the close, and every state queued behind it not reviewed. The summary counts a thread the failed round gave no verdict by its last ruling on record, and otherwise as `open` or `disputed`, and its Notes end with `- The budget ran out before the review could be completed: the last attempt failed, and spent the last of the round cap. A person needs to look at this change.` ("the last of the token bound" where that closed it, naming any states queued behind it as `Squiz did not review 8d21a4f.` before the last sentence). `squiz review` exits 3 for the failed round's state and every state queued behind it. (#915)

### 6.1 What the comment carries

- **R6.1.2, R6.1.4, R6.1.5** The summary's counts block gives rounds run, findings raised, and how many ended `fixed`, `withdrawn`, `open` and `disputed`; findings raised counts every thread of the episode plus every unthreaded finding Notes lists, which carry no status. The needs-a-person block lists every `open` and `disputed` finding with its headline and location (`file:line` for a line thread, the file alone for a file thread), or says in one line that there are none. Rounds lists each round in the order it ran, with the short commit it reviewed, the findings it raised and its rulings, as `- Round 4 at 9a0b1c2: found nothing new and ruled on nothing`. (L2814, L2818–2820, L2827–2831, L2832–2836; also L2639–2644)
- **R6.1.7, R6.1.10** The summary's Notes names what the threads do not show: each finding no thread holds, earlier rounds' first and then the closing round's, with its location or as `About the change as a whole: …`; a reason or closing reply that could not be posted; a ruling that could not be applied; a round whose finished review never read a changed file's diff; a round the time bound cut short; a cap or bound that ended the episode early, with each queued state it left not reviewed; and a failed round that spent the last of the budget (R6.0.11). An earlier round's finding no later round raised again reads ``- Raised in round 1 and not raised again: `src/cache.ts:12` — The cache is never cleared (no thread could be opened for it)``. (L2839–2855, L2876–2887; also L3800, L3802, L232, L804, L958, L996, L169)
- **R6.1.8** An unposted closing reply's Notes line names the ruling: ``- `src/queue.ts:134` — Retry backoff resets (ruled fixed, and the reviewer's reply could not be posted on its thread)``. (L2857–2862)
- **R6.1.9** An unapplied ruling's Notes line says what the reviewer ruled; a handed-over thread is named by location and headline, one not handed over by the id the reviewer gave. Cases: could not be resolved, could not be re-opened, given no ruling, ruled a second time (first stands), not handed to the reviewer. (L2864–2874; also L3800)
- **R6.1.12** A round whose finished review never read a changed file's diff gets one Notes line naming the files, the first ten then "and N more"; each name is one code span with control characters escaped, a line break as `\n`, and a fence one backtick longer than any backtick run in the name. A round cut short by the time bound gets no such line. Example: ``- The reviewer finished round 1 without reading the diff of 2 changed files: `src/queue.ts`, `docs/a file.md` ``. (L2896–2907; also L1743–1746)
- **R6.1.13** A round the time bound cut short gets the line `- The review was cut short by the 900-second time bound in round 2, and the round kept only the findings it had reported by then`. (L2909–2914)
- **R6.1.14** A cap or bound that left queued states not reviewed is one Notes line naming the bound and each state (short commit, plus "with different replies" where needed), in place of the bound's own line: `- The episode ended at its round cap rather than with nothing left open, and did not review 8d21a4f or 8d21a4f with different replies`. (L2916–2923; also L232, L293–299)
- **R6.1.15** A round's findings raised are those the reviewer reported, whether or not their comments were posted; its rulings count, by verdict, each `fixed` or `withdrawn` verdict on a thread open when it was handed over and every `open` verdict, and leave out a verdict on a thread not handed over and a second verdict on one thread. (L2989–2993)

### 6.2 The format

- **R6.2.1** Summary format: heading `**Squiz review — 3 rounds, 7 findings**`; counts line; spend line; reviewer line; `**Needs a person**` list; `**Rounds**` list; `**Notes**` list, as in the L2927–2950 example. (L2927–2950; also L67)
- **R6.2.3, R6.2.4, R6.2.7, R6.2.8** The spend line leads with the tokens, which every round with a cost carries: total tokens, the round count and each round's tokens, then dollars where the reviewer's CLI priced the model, as `48,200 tokens over 3 rounds: 20,100, 16,400, 11,700 · $0.0134`. A Copilot round carries AI credits to two decimals in place of dollars (`… · 0.84 AI credits`), and with both kinds the line gives both totals, each covering its rounds. A floor reads "at least", on its own round and every total, as `At least 36,500 tokens over 2 rounds: 20,100, at least 16,400 · at least $0.0105`. Costed rounds with no completed message read `No spend was reported over N rounds`. The reviewer line names the reviewer CLI each round ran and the models the run reported, never the configured `model`, and a run that reported none reads "an unknown model". (L2814–2817, L3006–3008, L3010–3018, L3030–3038, L2816–2817, L2972–2974, L3041–3044; also L2277)
- **R6.2.5** A round that completed no assistant message has its cost shown as unknown, not zero, including a floor round, whose neighbouring totals stay marked. The wording is the code's. (L3018–3019, L3038–3039)
- **R6.2.6** A round with no cost has no figure in the spend line; the line covers rounds with a cost and says how many (`18,200 tokens over 1 of 2 rounds · 0.36 AI credits`). With no round costed, there is no spend line. (L3021–3028)
- **R6.2.9** Where every round ran the same reviewer on the same models, they are named once: ``Reviewed by `copilot` on `gpt-5-mini` and `claude-haiku-4.5` ``. (L3046–3052)
- **R6.2.10** Where rounds differ, each model is named with its rounds under the reviewer that ran them, in first-named order, a two-model round under both: ``Reviewed by `pi` on `openai/gpt-5-mini` in rounds 1 and 2, and by `copilot` on `gpt-5-mini` in round 3``. (L3054–3061)
- **R6.2.11** Each model is one code span with whitespace runs collapsed to a space; a round with no recorded reviewer reads "an unknown reviewer"; an episode with no round has no reviewer line. (L3063–3065)

## 7. Commands

### 7.0 Preamble

- **R7.0.1** Everything squiz ships to be run is a subcommand of one binary, `squiz`; there is no slash command, and the setup check is `squiz doctor`. (L3069–3071)

### 7.1 The `squiz` binary

- **R7.1.1, R7.4.1, R7.4.2, R7.4.5, R7.4.6, R7.4.7** `squiz init` links `squiz` onto `PATH` and allows its commands in Claude Code's user settings (R7.4.10), printing a line for each, and its exit status is the link's alone: 0 where the link is in place afterwards, else 1 with the link's line on stderr. In Claude Code the coding agent's Bash tool and a `!` command run `squiz` by name; every other shell, Copilot's included, runs it through this link. The link goes in `~/.local/bin`, else `~/bin`, the first on `PATH` that is a writable directory; no directory is created and no startup file edited. Every `squiz` already on `PATH` is read first, and what it finds decides the outcome: a link to this squiz changes nothing and says so; a link to another version of the same plugin-cache install is moved to this version; a link to another checkout or install, another squiz's own `bin/`, or anything else named `squiz` makes no link and says what to do; nothing found and neither directory usable makes no link and says to add `~/.local/bin` to `PATH`. This squiz's own `bin/` on `PATH`, which Claude Code adds for an enabled plugin, is ignored and does not stop the link. Nothing named `squiz` that is not this squiz is replaced or shadowed. (L3075–3078, L3498–3503, L3505–3507, L3514–3517, L3518–3522, L3524–3532; also § 7.4, L3084, L4121–4124, L4178–4190, L4188, L4189)
- **R4.2.8, R7.1.2, R7.1.5** `squiz threads` lists the open threads of the change in the worktree it runs in: under GitHub, the open pull request whose head is the branch checked out there, and under local, the threads in that worktree's `.squiz/local/`. It is headed `3 open threads on #185` (under local, `<n> open threads on the working tree`), one line each of identifier, location, and severity — headline: `PRRT_kwDOUEd2qM6mPuUP scratch/paging/pages.ts:26 high — pageCount drops the partial last page`. `squiz reply <id> <text>` replies as the coding agent on a thread `squiz threads` printed, in the same change, and refuses an id the change holds no thread for, as `squiz: nothing replied in T9: threads.json holds no thread "T9"`. (L1351–1360, L3089, L3092–3102, L3090, L3104–3112; also L1659, L1662)
- **R7.1.3** In `squiz threads`, a thread whose first comment carries none of R2.2.2's markers was opened by a person, is no finding, and prints as its identifier and location alone. (L3099–3102)
- **R7.1.4** The identifier leads the line undecorated, so the line splits into identifier and rest at the first space. (L3104–3105)

### 7.2 `squiz review`

- **R7.2.1, R7.2.2** `squiz review` exits 0 where a round reviewed this state and nothing is open, the episode closed with its summary posted, or where the pull request is a draft; 2 where threads are open and rounds remain; 3 where the round cap or the token bound closed the episode with threads open, or closed it without a round reviewing this state, whatever is open, for the run waiting on it and every later run; 4 while the round goes on in the round host; and 1 where the review could not run. Exit 0 is given only for a state a round reviewed. (L3122–3128, L3130–3135; also L231–232, L420, L3949–3953, L81–82, L411–414, L416–422, L394–397)
- **R7.2.3** Statuses 0, 1, 2, 3 and 4 are the only ones `squiz review` gives; a caller reads any other status, such as a crash or a command that could not start, as 1. (L3138–3140)
- **R7.2.4** stdout carries the outcome for exits 0, 2, 3 and 4; stderr carries what failed; a run that exits 1 prints nothing on stdout. (L3142–3145; also L3873–3880)
- **R7.2.5** Runs exiting 0, 2, 3 or 4 write all of stdout to `.squiz/<number>/review.txt`, replaced each run, and print first `Full output, to read where this is cut short: <path>`. (L3148–3151, L3166; also L237, L1543)
- **R7.2.6** On a draft, `squiz review` exits 0, prints only `PR #41 is a draft. Squiz reviews it once it is marked ready for review, so there is nothing to wait for.`, and writes no file, and the hooks write nothing. Once it is marked ready for review, the next trigger queues its state as any other. (L3151–3152, L3212–3216; also L391–393, L521, L4288, L519–521)
- **R7.2.7** If `review.txt` cannot be written, outcome and exit stand and stderr adds `squiz: the output could not be written to <path>: <reason>`. (L3152–3157)
- **R7.2.8, R7.2.9, R7.2.11, R7.2.12, R7.2.15, R7.2.18, R7.2.24** `squiz review` prints the outcome on stdout, every number and thread as it stands on the pull request. Each open thread prints as its `squiz threads` line followed by its comments indented two spaces, the first without its first line. Exit 2 prints `Squiz reviewed PR #41 at 3f9c2e0: round 2 of 3, 1 new finding.`, `2 threads are open:`, the threads, and a paragraph telling the agent to fix what applies in the worktree, reply with `(cd '<worktree>' && squiz reply <id> <text>)`, commit and push, and run `squiz review 41` again. Exit 0 prints `Squiz reviewed PR #41 at 8d21a4f: round 2 of 3, no new findings.` then `Nothing is open. The review is closed, and its summary is on the pull request.` Exit 3 at a cap close prints ``The round cap is reached. The review is closed with 1 thread open, and its summary is on the pull request. A person takes it from here, so do not run `squiz review 41` again.`` and the threads ("The token bound is reached" where the bound closed it). Exit 4 prints `Squiz is still reviewing PR #41 at 3f9c2e0.` or the line for a queued, clean-with-a-state-behind or superseded state, each ending ``Run `squiz review 41` again to wait for it.`` A failed round prints `squiz: review failed: <the failure comment's reason>` then `squiz: the failure is posted on PR #41` on stderr. (L3159–3161, L3163–3193, L3203–3210, L3218–3233, L3261–3292, L3338–3345, L3404–3405; also L2617–2618, L231, L263, § 8.1)
- **R7.2.10** A run handed a result it did not produce says `Squiz already reviewed PR #41 at …` and prints the threads as they stand on the pull request now. (L3195–3201)
- **R7.2.13** Closed before a round reviewed the run's state: after the close's heading, `Squiz did not review PR #41 at 8d21a4f: the episode closed at the round cap, after reviewing 3f9c2e0.`, and the paragraph says "with nothing open" where nothing is. (L3235–3247; also L234–243, L293–299, L3317–3329)
- **R7.2.16** A run on an already closed episode prints the close, naming the head it was reached on, whatever the round cap or token bound would now allow: `Squiz's review of PR #41 closed at 3f9c2e0 after 2 rounds, with nothing open. Only a new head commit starts another review in this worktree.` A clean close is printed this way, with exit 0, only for its own head and a failed state it recorded. (L3294–3303; also L399, L394–398)
- **R7.2.17** Where the cap or bound closed it, the line ends `No round runs again in this worktree.`; with threads open it counts them, exits 3, and the threads follow. (L3305–3315)
- **R7.2.20** A round that left threads open and has unthreaded findings keeps exit 2 and prints on stderr `squiz: round 1 could not post 1 of its 3 findings to PR #41` (where any failed to post), then each as `squiz: round 1 raised this on no thread: <Notes line>`. (L3348–3356; also L2877–2878)
- **R7.2.21** A run that failed before any round, or could not reach GitHub, prints one `squiz: no review ran: <why>` line (e.g. `PR #41 is closed`) then the stop line. (L3367–3374; also L3881)
- **R7.2.22** Where the round host's start cannot be told, `squiz review` waits on a live host. Where no host takes the review, it exits 1 with `squiz: no review ran: whether the round host for PR #41 started could not be told, …`, then a line naming `squiz status` and `.squiz/41/host.log`, then the stop line, and the state stays queued. (L3376–3384; also L3780)
- **R7.2.23** A run after this worktree pushed waits up to 60 seconds (or its deadline) for GitHub to report a head containing the pushed commit, and acts on that head. Otherwise it exits 1 and queues nothing, with `squiz: no review ran: PR #41 still has 3f9c2e0 as its head after 60 seconds, though this worktree pushed 8d21a4f to it`. Unpushed commits, a head pushed from elsewhere, and a branch with no push destination are taken as GitHub reports; hooks never wait. (L3386–3402; also L3795)

### 7.3 `squiz status`

- **R7.3.1, R7.3.7, R7.3.10, R7.3.16** `squiz status` lists every review recorded in any worktree of the repository, one line per pull request state, newest first; it starts nothing and makes no GitHub call. Result gives, for failed, the failure comment's reason; for not reviewed, why; for reviewed, how many of the reviewer's threads are left open, plus "review closed", "review closed at the round cap" or "at the token bound", and "N of M findings not posted" where GitHub refused some. Resume shows the round's `resume.txt` once the round is over, else `—`. A state file that cannot be read, or an `episodes/` directory that cannot be listed, gets a stderr line naming the PR, the worktree and what was wrong, and every other worktree is still listed. (L3409–3411, L3437–3442, L3450–3451, L3483–3485; also L3083, L3475, L1821, L2448, L3810, L3743, L3784)
- **R7.3.2** The table's columns are PR, Commit, Replies, State, Started, Elapsed, Result, Session, Worktree, Resume, e.g. `#41   3f9c2e0  OmQx7a   reviewed   07:06:02  2m 40s  1 thread open  tmux squiz-41-r2  .claude/worktrees/agent-a5336e10  pi --session-dir … --session …`. (L3413–3419)
- **R7.3.3** Replies shows the last six characters of the identifier of the latest activity the state was read with, or `—` for none. (L3423–3424)
- **R7.3.4** State shows the record's status; a reviewing record whose round host has gone shows `killed`; one whose host cannot be told running or gone shows `reviewing` with Result "the round host could not be checked: <why>"; a state the episode closed before reviewing shows `not reviewed`. (L3425–3429; also L3742, L3781, L3783)
- **R7.3.5** Started is local time: time of day for a round started today, date and minute otherwise; a reviewing record shows the reviewer's start once it has started, the round host's before. (L3430–3433)
- **R7.3.6** Elapsed is time so far for a running review, start to end for a finished one, and `—` for a killed review, a state no round started, and a state that failed before a round took it. (L3434–3436)
- **R7.3.8** Session shows the backend and the label `squiz-<number>-r<k>`; the backend alone where the record keeps no `k`; `detached` for a detached reviewer; `—` where no reviewer started. (L3443–3447; also L3787)
- **R7.3.9** Worktree shows the path relative to the main worktree, `.` for the main worktree. (L3448–3449)
- **R7.3.11** Order: episodes with a state queued or under review first; then by the latest start or end time any record carries; then by higher PR number; within an episode, newest state first. (L3453–3460)
- **R7.3.12** A closed episode a later one replaced (`episodes/<n>/`) is listed as an episode of its own, under the same PR and worktree, with Resume read from `episodes/<n>/rounds/<k>/resume.txt`. (L3460–3463; also L125–128, L338–343)
- **R7.3.13** Every cell is one line: a line break and the whitespace around it print as one space. (L3465–3466)
- **R7.3.14** A reviewed state's problems (failures that did not change its outcome) follow its line, one line each, indented two spaces, never widening a column, e.g. `  the review of PR #39 closed without its summary: gh: HTTP 502 Bad Gateway`. (L3468–3477; also L3742, L3800–3803, L3811)
- **R7.3.15** `squiz status` shows how many findings a round could not post, not which; the round's record and `squiz review`'s stderr hold each one. (L3479–3481)
- **R7.3.17** A worktree git lists that is gone from disk prints nothing. (L3485)
- **R7.3.18** With nothing recorded anywhere and every state file read, stdout is `No review is recorded in any worktree of this repository.`; where a state file could not be read and nothing else was listed, stdout is empty. (L3486–3494)

### 7.4 `squiz init`

- **R7.4.9** The link's line reads, e.g., `squiz: linked /Users/ana/.local/bin/squiz to /Users/ana/.claude/plugins/cache/tools/squiz/0.2.0/bin/squiz, in place of …/0.1.0/bin/squiz, an earlier version of this install`. (L3537–3543)
- **R7.4.10, R7.4.14, R7.4.15** `squiz init` adds `Bash(squiz review *)`, `Bash(squiz threads)` and `Bash(squiz reply *)` to `permissions.allow` in Claude Code's user-settings `settings.json`, adding only the rules missing, after those already there, and keeping every other key and rule; a file already holding all three is not written. A file that cannot be read, is not JSON, is not an object, or whose `permissions` is not an object or `permissions.allow` not a list is left as it is, and the line names the file and which. A `settings.json` that is a symlink is written at its target and stays a symlink. (L3547–3554, L3566–3568, L3569–3572, L3574–3575; also L4121–4124)
- **R7.4.11** That file is in `$CLAUDE_CONFIG_DIR` where set and non-empty, else `~/.claude`; where `CLAUDE_CONFIG_DIR` is set, `~/.claude` is never used. (L3556–3558; also L4124)
- **R7.4.12** Where the configuration directory does not exist, nothing is written or created and a stdout line says Claude Code's configuration was not found, naming the directory; a non-absolute `CLAUDE_CONFIG_DIR`, or neither it nor `HOME`, writes nothing, with the line on stderr. (L3559–3563)
- **R7.4.18** The settings line reads, e.g., `squiz: allowed Bash(squiz review *), Bash(squiz threads) and Bash(squiz reply *) in /Users/ana/.claude/settings.json`, with "already allows …; nothing changed" and "allowed nothing in <file>: <why>" for the other cases. (L3580–3587)

### 7.5 `squiz version`

- **R7.5.1, R7.5.2** `squiz version` and `squiz --version` print one line, `squiz <version> <path>`, and exit 0, e.g. `squiz 0.1.0 /Users/ana/squiz/bin/squiz`: the version from the running squiz's `.claude-plugin/plugin.json` and the real path of its `bin/squiz`, neither from the working directory or `PATH`. (L3591–3595, L3597–3601; also L3086)
- **R7.5.3** Where `plugin.json` cannot be read, is not JSON, names another plugin or no version, it prints nothing on stdout, says why on stderr (`squiz: the version of this squiz could not be read: <why>`) and exits 1. (L3603–3608)

### 7.6 The setup check

- **R7.6.1, R7.6.2, R7.6.6, R7.6.7, R7.6.8, R7.6.9, R7.6.10, R7.6.11, R7.6.13, R7.6.14, R7.6.15, R7.6.16** `squiz doctor` runs inside or outside a repository, prints one line per dependency, each `present` (usable, or an optional tool absent), `warning` (seen, and squiz runs without it) or `failed`, and exits 1 where any line failed. The rows: `git`, required; the venue, required and present where `.squiz.json` reads as a round reads it, naming the file as `(path)` or `(no path)`, e.g. `Venue local (/work/squiz/.squiz.json): reviews run on the working tree, and gh is not required`; `gh`, required under the GitHub venue and present where `gh auth status --json` reports an account whose check succeeded; Claude Code, required only where `copilot` is missing or cannot be run; Copilot as a coding agent, optional and printed only where it is on `PATH`, present where it answers, `"experimental"` is `true` in `<COPILOT_HOME>/settings.json` and its socket path fits; Node, required, 24 or later; the `squiz` link, optional, a warning wherever `squiz init` would refuse or change it; Copilot's copies of squiz, a warning for each at another version; and the reviewer, required, the one `reviewer` names in the main worktree's `.squiz.json` (`pi` outside a repository or without the file), naming the model a round would run on: `model` from `.squiz.json`, else the user's default from the CLI's settings, else unknown, with unreadable CLI settings a warning for `pi` and a failure for Copilot. (L3612–3626, L3628–3634, L3647, L3648, L3658–3667, L3649, L3650, L3651, L3724–3728, L3652, L3654, L3655, L3656, L3669–3674, L3676–3680; also L3085, L1665–1668, L1665, L4168–4176, L4004, L4106, L4099–4100)
- **R7.6.5** Rows print in this order: git, venue, gh, Claude Code, Copilot as coding agent, Node, tmux and Herdr, the `squiz` link, Copilot's copies of squiz, the reviewer. (L3643–3656)
- **R7.6.12** tmux and Herdr are optional; an absent one prints e.g. `tmux: not found. Not required: without tmux or Herdr, reviews run detached`. (L3653, L3622)
- **R7.6.17** For `pi`, wherever the reviewer row names a model it ends with the thinking level a round runs at, without making a model request: a match ends `; thinking medium` and is present; a differing level is a warning naming the configured level, the level it runs at and the levels offered; an unreported level is a warning with the reason. (L3682–3698; also L2238–2240)
- **R7.6.18** For a Copilot reviewer, sign-in is checked by one prompt spending one request on the named model (no model where unknown), run as a round's reviewer would run and signing in from the token file a round would use. The row says which source it signed in with: the token in `copilotTokenFile`, the token in the default file, or Copilot's own login. A `copilotTokenFile` that cannot be used fails the row without running Copilot; a default file that exists and cannot be used is a warning naming it, and the prompt runs on Copilot's own login; the token is never printed. A model the account cannot use fails the row with Copilot's reason. E.g. `Reviewer copilot 1.0.105 (/Users/ana/app/.squiz.json), model gpt-6-astra, from .squiz.json. Signed in with Copilot's own login; the check spent one request on gpt-6-astra: warning: the Copilot token file /Users/ana/.config/squiz/copilot-token is empty`. (L3700–3720) (#917)

## 8. Failure modes

### 8.0 Preamble

- **R8.0.1, R8.2.1, R8.2.2** A run that could not review exits 1; a failure that leaves the outcome standing keeps the outcome's status, 0, 2 or 3, and adds a stderr line. `squiz review` writes one stderr line per thing that failed, prefixed `squiz: `, every run that exits 1 ends its stderr with `squiz: put these lines in your report rather than running squiz review again`, and a run where nothing failed writes nothing on stderr but the defaults-in-use line. (L3732–3735, L3875–3887, L3889–3891; also L3140–3146, L3338–3344, L3331–3336, L3144–3146, L4210)
- **R8.0.2, R8.0.3, R8.0.4, R8.0.5, R8.0.6, R8.0.37** No failure is silent. Every failure path reaches at least one of: the failure comment, `squiz status`, `.squiz/<number>/host.log`, `squiz review`'s stderr, the summary's Notes, the hook's stderr. Once the round has found its pull request and can read the episode's state, a failure posts a failure comment where GitHub can be reached, and a closing round's problems go into Notes; a failure before that posts nothing. A round that fails in the round host is recorded failed with its reason, which `squiz status`, `squiz review`'s stderr and `host.log` show; `host.log` holds a line per thing the host did and is the only surface for what it does outside a round; the hook's stderr carries one line for what a stop firing could not do. A harness throw writes one stderr line from a command, fails the round inside one (recorded with the throw as its reason, no failure comment), and leaves the hook at exit 0. (L3737–3752, L3745–3747, L3751–3752, L3754–3758, L3760–3761, L3813; also L121, L467)
- **R8.0.7** A `gh` that ran and failed is reported by its exit status and the first line it wrote; a `gh` that could not run is reported as such. (L3763–3765)
- **R3.2.7, R8.0.10, R8.0.11, R8.0.12, R8.0.13, R8.0.15, R8.0.16, R8.0.32, R8.0.33** Where squiz cannot read or write its own files (configuration, state file, queue, the reviewing record, the round's rulings and spend, its end) or git cannot name the worktree or branch, the run exits 1 naming the file and the error, and no review runs; a state not yet taken stays queued, and what already landed stands. A failure before the review posts nothing more. A state file missing a field its writer always writes cannot be read, and the reason names the field, e.g. `/work/squiz/.squiz/41/state.json: round 1 has "raised" as undefined`. Where the round's rulings and spend cannot be written, nothing the reviewer found is posted, no verdict included; where its end cannot be written, no summary is posted and the episode reads open, so the next run reviews again. In both cases a failure comment names the write that failed, as do stderr, `squiz status` and `host.log`. (L176–184, L3776, L3777, L3778, L3779, L3784, L3785, L3807, L3808; also L3483, L1216–1220, L4269, L302–306)
- **R8.0.14, R8.3.8, R8.3.9, R8.3.10** `squiz review` waits within one 540-second deadline from its start. A run whose round ends first returns its result (0, 2 or 3, or 1 with the recorded reason) and posts no second failure comment; a run whose deadline arrives first, or that is stopped from outside, exits 4 or is gone, while the round goes on in the round host and the next run returns its result. (L3782, L3942–3944, L3946–3948, L3949–3950; also L4291, L209, L3119–3120, L231, L263, L3261, L3809)
- **R8.0.18, R8.0.19, R8.0.20, R8.0.21** A reviewer that is not installed, ends without a completed message, or whose output cannot be read after a retry fails the round with exit 1, and the failure comment and stderr say why, a missing reviewer and a run with no completed message reported as setup problems; what it reported is posted. A reviewer that stopped without finishing is retried once where time remains, both attempts post what they reported, and a retry that fails too exits 1 with a failure comment saying the review was never finished. (L3788, L3789, L3790, L3791)
- **R8.0.22, R8.3.1** The time bound (`timeout`) applies per round: at it the reviewer is killed, its findings so far are posted, the round is recorded failed, and the failure comment and stderr say how many findings arrived (for `pi`, with messages completed, average seconds and provider failures), adding "the machine slept for N minutes of the round" where it slept; the closing summary notes the cut. A round already holding the reviewer's finish is the review it declared, with no failure comment and exit 0, 2 or 3. (L3792, L3898–3902; also L3833, L3847, L3902, L2913, L4227)
- **R8.0.23** Reviewer's pane cannot be closed: it stays open; `host.log` says so. (L3793)
- **R8.0.24, R8.0.25, R8.0.26, R8.0.27, R8.3.12** Where GitHub cannot be reached or `gh` cannot run, the run exits 1, no review runs, stderr names the call, nothing is posted or stored to retry, and a trigger queues nothing. Where the threads cannot all be listed, or a call before the review runs out of its time, the run also exits 1 with no review, and a failure comment is posted where GitHub still accepts one; a timed-out lookup is never read as no pull request. No GitHub call may take more than 30 seconds, and that is not configurable. A call that reaches it while the round posts is one comment that failed to post (R8.0.29), not an outage: the comments that landed stay, and the round exits as its outcome says. (L3796, L3797, L3798, L3799, L3955–3957; also R8.0.2)
- **R8.0.28, R8.0.29, R8.0.30, R8.0.36** A finding, verdict or summary GitHub refuses is not retried: what landed stays, and the outcome stands. A verdict on a thread not handed over, and a second verdict on one thread, are not sent, and the first verdict stands. A verdict GitHub refuses leaves the thread as handed over and counted that way. Each verdict not applied is named on `squiz review`'s stderr, in `squiz status`, the round's record and `host.log`, with GitHub's answer, and in the closing summary's Notes or the failure comment, without it. Where some comments fail to post, stderr gives the count, a later round makes the rest, and the closing summary or failure comment lists each. A round that found findings and posted none is failed whatever its verdicts did: it exits 1 with the reason `round 2 found 3 findings and could not post them to PR #41`, posts a failure comment and no summary, and a later trigger retries it where a round remains. A round that spends the last of the round cap or the token bound closes as R6.0.11 says instead. A summary that cannot be posted still closes the episode with exit 0 or 3; stderr says it closed without its summary, naming GitHub's answer, on this and every later run on the closed episode, and `squiz status` and `host.log` show it. (L3800, L3801, L3805, L3811; also L3882, L3358–3365, L3476, L3884)
- **R8.0.34** Round's result cannot be recorded: what was posted stands; `host.log` names result and reason; status shows the round killed; a waiting `squiz review` exits 4 at its deadline; a later run exits 1 (host stopped before its round ended) unless the round closed the episode. (L3809)
- **R8.0.35** Posting time or resume command cannot be written: result stands; Resume shows `—`. (L3810)

### 8.1 The failure comment

- **R8.1.1, R8.1.2, R8.1.3, R8.1.4, R8.1.5, R8.1.6, R8.1.7, R8.3.4** A failed round posts one issue-level failure comment, never edited, after its salvaged findings: a bold headline `**Squiz review failed — <reason>**` whose reason is word for word the one stderr prints, what happens next, how many salvaged findings were posted as threads, and a list of each salvaged finding no thread holds and each ruling not applied, written as Notes writes them, e.g. ``- `src/cache.ts:12` — The cache is never cleared (no thread could be opened for it)``. It is posted even with nothing salvaged. Where a round remains under the cap and bound, it says the review is still open and that a new commit or reply, or `squiz review`, retries it. Where none remains, the failed round has closed the episode and posted its summary first (R6.0.11), and the comment reads `The review is closed: it has run 3 rounds, and the round cap allows 3. No round runs again. Its summary is on the pull request.`, or `… it reached the token bound of 10,000,000 tokens. …`, ending at "No round runs again." where the summary could not be posted. Nothing is posted where GitHub is unreachable, and a run that waited on another's round or was handed a recorded result posts nothing. (L3820–3839, L3828–3830, L3841–3854, L3856–3859, L3861–3862, L3864–3867, L3869–3871, L3917–3918; also L2891–2893, L726, L3338–3344, L3806, L3948)

### 8.2 The command's stderr

No requirement of its own after merging. Its lines are under R8.0.1, R8.2.1, R8.2.2.

### 8.3 The review budget

- **R8.3.2, R8.3.14, R8.3.15, R8.3.16, R8.3.17** The token bound (`tokens`) applies per round. Every attempt's tokens count against it, whether or not it was a round: a reviewer that ran is charged what its report file says however its attempt ended, a floor (zero where it reports none) where the attempt was a start that failed after the reviewer may have run (a tmux window or an unidentified child; a failed Herdr start spends nothing) or one the harness threw out of; a Copilot usage line is kept as Copilot's total, a Copilot round with no cost counts nothing, and dollars and AI credits bound nothing. The bound is read when an attempt records what it spent, and the attempt that reaches it closes the episode, whether it reviewed or failed, with a summary saying the bound was reached rather than that the reviewer failed; it never stops the running round. (L3898–3903, L3965–3966, L3968–3981, L3983–3986, L3988–3990; also L4228, L3816)
- **R8.3.5** A round runs in the round host, outside any caller's timeout. The time bound is on the review alone; before and after the review, each call the round makes has 30 seconds of its own, and the round makes every call it has, however long the ones before it took. A call that pages is one call, and its pages share its 30 seconds. (L3920–3927; also L1871, L1977, L3798, L1870–1871, L1977–1978) (#918)
- **R8.3.6** Time the machine sleeps during the review is added back to the time bound, at most the bound itself per round, so no review runs longer than twice its bound; the calls outside the review and `squiz review`'s wait count sleep. (L3929–3935; also L3792)

## 9. The project

### 9.0 Preamble

No requirement. R9.0.1 is a project rule (Open for the owner).

### 9.1 Language

- **R9.1.1, R9.1.4, R9.1.6, R9.1.7, R9.1.8** Squiz runs as installed, with no build step and no runtime dependencies: TypeScript run directly by Node 24 or later through `bin/squiz`, a shell shim that execs the `.ts` entry point, plus the one Copilot extension, `extension.mjs`, which imports only Node's modules and `@github/copilot-sdk/extension`. Everything else is a subprocess: `git`, `gh`, `ps`, the reviewer CLI. (L3998–3999, L4004, L4008–4010, L4012–4014, L4016–4017; also L3652)
- **R9.1.5** Runs on macOS and Linux, and on Windows under WSL. (L4005–4007)

### 9.2 Structure

No requirement. R9.2.1–R9.2.4 are project rules (Open for the owner).

## 10. Adoption

### 10.1 Installing

- **R10.1.1, R10.1.2, R10.1.3, R10.1.4** The repository is the marketplace for both runtimes: `marketplace.json` names it `squiz` and lists one plugin, squiz, from the repository root, at the version `plugin.json` carries. Claude Code installs it with `/plugin marketplace add jacygao/squiz` then `/plugin install squiz@squiz`, and Copilot with `copilot plugin marketplace add jacygao/squiz` then `copilot plugin install squiz@squiz`. (L4071–4073, L4077–4080, L4084–4087, L4093–4094; also L4026)
- **R10.1.5, R10.2.1, R10.2.7** Every agent but Claude Code reaches `squiz` through the link `squiz init` makes once per machine: `! squiz init` in Claude Code where it has squiz enabled, else `<COPILOT_HOME>/installed-plugins/squiz/squiz/bin/squiz init`. After updating squiz in Claude Code, the user runs `! squiz init` in a session started after the update, and `! squiz doctor` warns about the link until then. Claude Code needs nothing per project for the three commands `squiz init` allowed; a Copilot session is started with `copilot --allow-tool='shell(squiz)'`. (L4102–4106, L4121–4130, L4178–4190; also L3527, L3654, L3547–3554, L3078)

### 10.2 Getting started

- **R10.2.3** A Claude Code or Copilot coding agent needs no instruction or `AGENTS.md` entry to be reviewed: the hooks start the review when it finishes. (L4145–4149)
- **R10.2.4, R10.2.5** Copilot support is experimental: the user turns on experimental features once, with `copilot --experimental` or `/experimental on`, and every Copilot session of a user who installed squiz then loads its hooks and its wake extension. (L4151–4152, L4154–4171; also L25, L736–743, L3724)
- **R10.2.6** Under a `COPILOT_HOME` whose socket path exceeds 104 bytes (macOS) or 108 (Linux), the extension warns in the session that it cannot listen. (L4173–4176; also L752, L3727)

### 10.3 Configuration

- **R10.3.1, R10.3.2** Every squiz process reads one optional `.squiz.json`, from the root of the main worktree (the first `git worktree list --porcelain` names) of the worktree it acts on, never from the reviewed worktree, so every worktree of a repository has one configuration. Every setting has a working default; without the file `squiz review`'s first stderr line is `squiz: no .squiz.json was found in the main worktree, /work/squiz, so the defaults are in use`, whatever the outcome, which it leaves unchanged, and a round host writes the line to `host.log`. (L4201–4207, L4209–4216; also L3670, L1203–1211, L3889–3891, L3145–3146, L4132–4134)
- **R10.3.3** In a bare repository's linked worktree there is no `.squiz.json` and the line says so; a git that cannot name the main worktree is an unreadable configuration. (L4218–4220; also L3777)
- **R10.3.4, R10.3.5, R10.3.6, R10.3.7, R10.3.8, R10.3.9** The settings, with their defaults and ranges: `reviewer`, `pi` or `copilot`, default `pi`, which chooses the adapter and nothing else; `rounds`, default 3, 1 to 8; `timeout`, default 900 seconds, 60 to 3,600; `tokens`, default 10,000,000, 100,000 to 10,000,000; `thinking`, default `medium`, one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; `model`, default none (the user's own default), `provider/id` for `pi` and the model's name for Copilot, up to 200 of letters, digits, `.` `_` `:` `/` `@` `+` `-`, starting with a letter, digit or `@`, an empty string refused. (L4225, L4262–4263, L4226, L4227, L4228, L4229, L4230, L4257–4258; also L2132–2134, L2223, L2304–2305, L431, L3902, L3903, L2362–2366)
- **R10.3.12** `copilotTokenFile`: default none, which reads the token from `~/.config/squiz/copilot-token` where that file exists, and otherwise leaves Copilot to its own login; an absolute path up to 4,096 characters, none of them a control character. The file, and the default file, hold the token alone (letters, digits, `_`), surrounding whitespace dropped, read where a Copilot reviewer starts and by `squiz doctor`. (L4233, L4245–4248; also L926, L2063, L2083, L3712) (#917)
- **R10.3.13** An invalid `copilotTokenFile` is refused with an error that omits the value: `<path>/.squiz.json: "copilotTokenFile" must be the absolute path of a file holding a token for Copilot; leave "copilotTokenFile" out for ~/.config/squiz/copilot-token or Copilot's own login`. (L4249–4255) (#917)
- **R10.3.14** A setting out of range or of the wrong type is rejected naming the setting, the value and what was expected; an unknown key is rejected as not a setting, listing the settings; an unreadable or unparseable file makes the command exit 1 naming it on stderr. (L4265–4270; also L1216–1220, L3777)

## 11. Human intervention

### 11.1 What squiz handles

No requirement of its own after merging. Its lines are cited under R3.2.5, R3.2.27, R3.3.2, R5.10.8, R7.2.6, R8.0.14.

### 11.2 Everything else

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

### Contradictions

- **10, what a local review calls itself:** keep L1240–1242 (R4.2.1, R4.2.2). A local change is `the working tree`, and its rerun is `squiz review` with no number. The `PR #local` and `squiz review local` sentence at L1375–1379 leaves the spec. It is bug #829.
- **12, whether the reviewer can reach a GitHub login:** accept the gap and state it. A `gh` the reviewer starts finds no login in its variables or its configuration, but `gh auth token` can still read the keychain login, which is the login Copilot's fallback signs in with (L2089–2091, #529). L2057 is corrected to say so.
- **15, findings from a round whose host died:** keep L3783. A dead host's findings are not posted. L2191–2195 and L2516–2518 apply to a round its host ended. Recovery of a dead host's round (L489–505) is not built, so it leaves the spec, and #327 holds its design until it is.
- **21, `squiz status 41`:** keep L3409. `squiz status` takes no number, and the message at L3382 and in the code says `squiz status` (#909).

### Owner's calls on the applied list

- **§ 9's file structure: not in the spec.** The `src/` layout and module organisation drift with every code change, so R9.0.1 and R9.2.1–R9.2.4 stay off the list, and the § 9 rewrite changes `CLAUDE.md` to stop saying § 9 fixes the layout.
- **R5.3.8, the snapshot directory's safety: kept.** It is a guarantee a person relies on.
- **R6.2.5, a round with no completed message: kept.** Its cost shows as unknown, not zero. The exact wording is the code's.

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

### Applied

The features, merges, details, Doubtful entries, contradictions and homes above are applied to the requirements. Requirements per H2, as lines before and after (a merged line holds several ids): § 1 2 → 2, § 2 10 → 6, § 3 121 → 39, § 4 54 → 45, § 5 104 → 42, § 6 36 → 17, § 7 88 → 47, § 8 63 → 16, § 9 13 → 2, § 10 29 → 11, § 11 2 → 1, which is 522 → 228 lines holding 400 ids. The cut features removed 55 requirements (PQ1, PQ3, PQ5, PQ4, PQ7, PQ-A2, PQ-B1), and the kept ones' 61 stay, with R5.2.1–R5.2.4 restated for #919, R5.4.8, R7.6.18, R10.3.12 and R10.3.13 for #917, and R3.7.7 and R4.4.18 without the fixer. Three replacements were written: R8.3.5 for #918, R5.12.12 and V13's sentence for #920, and R6.0.11, with L1, V8, A4, B11 and B12, for PQ-A2 as #915 describes it; #915 is not merged, so those follow its issue and pull request #921. R3.2.22 now states PQ7's replacement. All 59 merged groups were applied, 19 of them with a sentence a decision or a contradiction changed (L1, L10, L12, V6, V8, V12, V13, A2, A3, A4, A6, A7, A8, A13, B2, B9, B10, B11, B12), and with R7.6.18 kept out of A13, R3.2.9 out of L10, R3.2.7 into B5 and R5.0.1 and R5.10.1 as B19. Of the 139 details, 69 were removed, 3 were folded into a merged sentence (R3.2.7, R5.1.7, R5.10.12), and 67 were kept as an exit status, a setting, a message a person reads or a format's example; R3.10.3 is among them because contradiction 3 keeps it. Of the 38 Doubtful entries, 8 moved into the requirements and 30 were dropped, and the section is gone. Every contradiction's correction is in its requirements. Seven needed no change: 1, 10 and 13 were already right, 8 leaves R4.2.10–R4.2.12 as they stand, and 2, 7 and 27 went with PQ7, PQ1 and PQ-A2. Of the 70 homes, 8 notes were written and 4 extended, 9 issues were filed (#922–#930), and the rest were already covered, already filed, or dropped with a cut feature.

## Open for the owner

All three are answered, under Decisions, Owner's calls on the applied list.

## Not a requirement but needs a home

### To docs/notes

- L49–51: `review-threads-key-on-the-graphql-thread-id.md` and `no-dependency-version-is-a-minimum.md`, already.
- L157–161: dropped: cut feature (PQ4).
- L141–143, L3373: `ps-can-be-slow-enough-to-outlast-a-locks-deadline.md`, new.
- L524–526: `a-subagents-hook-runs-where-it-was-dispatched.md`, already.
- L592–593: `the-hook-shell-does-not-get-the-plugin-bin-on-path.md`, already.
- L563–569: `both-runtimes-fire-userpromptsubmit-with-the-prompt-and-cwd-and-only-copilot-fires-it-for-a-subagent.md`, new.
- L574–577: `both-runtimes-fire-userpromptsubmit-with-the-prompt-and-cwd-and-only-copilot-fires-it-for-a-subagent.md`, new.
- L580–581: dropped: cut feature (PQ1, `SQUIZ_FIXER`).
- L602–617: `copilots-stop-hooks-fire-and-a-ui-server-session-can-be-woken.md` and `the-round-hosts-own-post-wakes-an-idle-copilot-session-through-the-plugins-extension.md`, already.
- L629–634, L820–822, L856–859: dropped: cut feature (PQ1, the handoff's reports).
- L640–642: `a-subagents-hook-carries-its-parents-socket-and-a-post-wakes-the-parent.md`, already.
- L645–648: `copilots-stop-hooks-fire-and-a-ui-server-session-can-be-woken.md`, already.
- L870–872: dropped: cut feature (PQ1).
- L736: `an-extension-a-plugin-ships-wakes-an-idle-copilot-session-from-outside.md`, already.
- L898–899: dropped: cut feature (PQ3).
- L901–905: dropped: cut feature (PQ1).
- L910–911: dropped: cut feature (PQ1).
- L1005–1007: dropped: cut feature (PQ3).
- L1018–1019: dropped: cut feature (PQ3).
- L1623–1625: `both-runtimes-start-hooks-write-the-base-where-the-work-starts-and-a-resume-keeps-it.md`, already.
- L1625–1626: `both-runtimes-start-hooks-write-the-base-where-the-work-starts-and-a-resume-keeps-it.md`, already.
- L1628–1631: `both-runtimes-fire-userpromptsubmit-with-the-prompt-and-cwd-and-only-copilot-fires-it-for-a-subagent.md`, new.
- L1776–1777: dropped: cut feature (the typed line, #919).
- L1847–1849: `a-pane-close-never-reaches-a-session-of-its-own.md`, already.
- L1973–1976: `a-shared-clone-snapshot-costs-what-a-worktree-did-and-survives-gc.md`, already.
- L2066–2070: `copilot-finds-its-own-login-through-the-two-login-fields-of-config-json.md`, new.
- L2073–2077: `copilot-keeps-copilot-github-token-and-github-token-from-its-hooks.md`, already.
- L2225–2226: dropped: cut feature (the typed line, #919).
- L2227–2229: `pi-validates-a-reporting-call-the-grant-must-name.md`, already.
- L2249–2250: `a-reviewer-cli-can-run-a-model-other-than-the-one-configured.md`, new.
- L2289–2290: `pi-retries-a-failed-request-so-an-errored-message-is-not-a-failed-run.md`, new.
- L2338–2344: `a-copilot-round-with-no-auto-update-and-no-client-telemetry-reaches-only-the-github-api-and-its-model-host.md`, already.
- L2356–2358: `copilot-signs-in-through-gh-auth-token-and-without-gh-on-path-has-no-login.md`, extended.
- L2363–2366: `copilot-under-sh-takes-the-adapters-model-trust-and-group.md`, extended.
- L2390–2393: `copilot-hands-an-mcp-server-its-own-environment.md` and `copilot-passes-an-mcp-call-through-unvalidated.md`, already.
- L2412, L2418, L3980: `copilot-reports-tokens-once-a-run-and-never-per-call.md`, extended.
- L3037–3038: `cost-arrives-during-a-run.md`, already.
- L3042–3043: `a-reviewer-cli-can-run-a-model-other-than-the-one-configured.md`, new.
- L3148: `a-subagent-reads-the-file-whenever-its-output-is-cut.md`, already.
- L3387–3389: `github-reports-a-prs-old-head-for-seconds-after-a-push.md`, new.
- L3577–3578: `copilot-allows-a-command-by-its-name-and-never-by-its-subcommand.md`, extended.
- L3649: `an-empty-gh-config-leaves-gh-no-login-but-gh-auth-token-reads-the-keychain.md`, already.
- L3683–3685: `pi-raises-a-level-the-model-lacks-and-rpc-mode-reports-it-without-a-request.md`, already.
- L3685–3695: `pi-raises-a-level-the-model-lacks-and-rpc-mode-reports-it-without-a-request.md`, already.
- L3700–3702: `copilot-signs-in-through-gh-auth-token-and-without-gh-on-path-has-no-login.md`, extended.
- L3971–3974: `a-tmux-window-runs-its-command-as-it-opens-and-a-herdr-pane-holds-it-behind-a-gate.md`, new.
- L4008, L4012: `node-strips-types-only-from-a-ts-file-and-copilot-starts-only-an-extension-mjs.md`, new.
- L4091–4097, L4103–4105: `a-claude-code-update-keeps-the-old-version-for-14-days-and-the-link-runs-it.md` and `copilot-plugin-install-loads-squizs-hooks-and-extension-as-plugin-dir-does.md`, already.
- L4125–4126: `copilot-allows-a-command-by-its-name-and-never-by-its-subcommand.md`, already.

### To an issue

- L26: #922.
- L507–509: #327, already filed; decision 15 leaves recovery to it.
- L748–749: #923.
- L904–905: dropped: cut feature (PQ1).
- L1152–1162: dropped: cut feature (PQ5).
- L1180–1181: #924.
- L1369–1374: #835, already filed.
- L1375–1379: #829, already filed.
- L1965–1972: #358, already filed.
- L1976: #925.
- L1977–1978: dropped: cut feature (PQ-B1, #918).
- L2086–2087: #567, already filed.
- L2089–2092: #529, already filed.
- L2311–2313: #926.
- L2343–2344: #927.
- L2359–2360: #928.
- L2379–2381: #929.
- L3479–3481: dropped: contradiction 22 shows the record and `squiz review` hold each finding.
- L3787: #930.
- L4007: #722, already filed.
- L4298–4306, L4310–4313: #819, already filed.

