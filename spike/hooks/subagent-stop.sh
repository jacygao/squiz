#!/bin/sh
# SubagentStop hook for the M0 prerequisites spike.
#
# It does three things and nothing else:
#   1. Appends a timestamped record of every invocation, including the full
#      stdin payload verbatim, to a log outside the worktree.
#   2. Counts its own invocations in a file, so an always-blocking hook cannot
#      loop forever.
#   3. Exits 2 for the first SQUIZ_SPIKE_MAX_BLOCKS invocations, writing a
#      blocking reason to stderr, and exits 0 for every invocation after that.
#   4. Counts rounds per subagent id, in a directory named for that id, which is
#      what an episode state file would be keyed on. It reads the id with jq
#      where jq is installed and records "(unparsed)" where it is not, so a
#      missing jq costs a log line rather than the run.
#
# The blocking reason carries an arbitrary token and asks the subagent to write
# it to a file. Nothing else in a session would produce that file, so the file
# existing is evidence that the subagent read the stderr and acted on it.
#
# Environment, all optional:
#   SQUIZ_SPIKE_DIR         where the log and the counter live
#                           (default /tmp/squiz-spike)
#   SQUIZ_SPIKE_MAX_BLOCKS  how many invocations exit 2 (default 2, clamped to 5)
#   SQUIZ_SPIKE_TOKEN       the arbitrary token (default ZZQ-4417)
#   SQUIZ_SPIKE_LABEL       a per-run label written into every log record, so
#                           one log can hold several runs

set -u

spike_dir="${SQUIZ_SPIKE_DIR:-/tmp/squiz-spike}"
max_blocks="${SQUIZ_SPIKE_MAX_BLOCKS:-2}"
token="${SQUIZ_SPIKE_TOKEN:-ZZQ-4417}"
label="${SQUIZ_SPIKE_LABEL:-unlabelled}"

# A typo must not turn into an unbounded billed loop.
case "$max_blocks" in
  ''|*[!0-9]*) max_blocks=2 ;;
esac
[ "$max_blocks" -gt 5 ] && max_blocks=5

mkdir -p "$spike_dir" 2>/dev/null
log="$spike_dir/hook.log"
counter="$spike_dir/invocations"

payload=$(cat)

n=$(cat "$counter" 2>/dev/null || echo 0)
case "$n" in
  ''|*[!0-9]*) n=0 ;;
esac
n=$((n + 1))
printf '%s\n' "$n" >"$counter"

# The episode key. § 3 keys an episode on the subagent's id, so the id and the
# session it arrived in are pulled out onto their own log lines, and a round
# counter is kept in a directory named for the id — which is what M1's episode
# state file does with it. If two subagents share an id the counter conflates
# them, and if one subagent's id changes it starts a second counter, so the
# directory is the claim under test rather than a convenience.
agent_id=$(printf '%s' "$payload" | jq -r '.agent_id // "(absent)"' 2>/dev/null) \
  || agent_id='(unparsed)'
[ -n "$agent_id" ] || agent_id='(absent)'
session_id=$(printf '%s' "$payload" | jq -r '.session_id // "(absent)"' 2>/dev/null) \
  || session_id='(unparsed)'
# The id becomes a path component, so it is stripped rather than trusted.
key=$(printf '%s' "$agent_id" | tr -cd 'A-Za-z0-9_-')
[ -n "$key" ] || key='no-agent-id'
episode_dir="$spike_dir/episodes/$key"
mkdir -p "$episode_dir" 2>/dev/null
rounds=$(cat "$episode_dir/rounds" 2>/dev/null || echo 0)
case "$rounds" in
  ''|*[!0-9]*) rounds=0 ;;
esac
rounds=$((rounds + 1))
printf '%s\n' "$rounds" >"$episode_dir/rounds"

{
  printf '===== invocation %s | label %s | %s =====\n' \
    "$n" "$label" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf 'pid: %s\n' "$$"
  printf 'hook_cwd: %s\n' "$(pwd)"
  printf 'git_toplevel: %s\n' \
    "$(git rev-parse --show-toplevel 2>/dev/null || printf '(not a git worktree)')"
  printf 'git_branch: %s\n' \
    "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || printf '(none)')"
  printf 'CLAUDE_PLUGIN_ROOT: %s\n' "${CLAUDE_PLUGIN_ROOT:-(unset)}"
  printf 'CLAUDE_PROJECT_DIR: %s\n' "${CLAUDE_PROJECT_DIR:-(unset)}"
  printf 'agent_id: %s\n' "$agent_id"
  printf 'session_id: %s\n' "$session_id"
  printf 'episode_rounds: %s\n' "$rounds"
  printf 'payload_bytes: %s\n' "$(printf '%s' "$payload" | wc -c | tr -d ' ')"
  printf 'payload: %s\n' "$payload"
  printf '\n'
} >>"$log" 2>/dev/null

if [ "$n" -le "$max_blocks" ]; then
  proof="proof-$n.txt"
  printf 'squiz-spike block %s of %s.\n' "$n" "$max_blocks" >&2
  printf 'Before you finish, write the exact string %s-%s to a file named %s in your current working directory, using the Write tool. Write nothing else in that file. Then say you did it and finish.\n' \
    "$token" "$n" "$proof" >&2
  printf 'Log: %s\n' "$log" >&2
  exit 2
fi

printf 'squiz-spike: invocation %s exceeded the block budget of %s, exiting 0.\n' \
  "$n" "$max_blocks" >&2
exit 0
