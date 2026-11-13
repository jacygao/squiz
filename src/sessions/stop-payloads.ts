/**
 * Stop and SubagentStop payloads as each CLI wrote them to a hook's stdin, in a
 * print-mode run that dispatched one subagent, word for word.
 *
 * A test that needs another `cwd` replaces that field alone, so that every
 * other field reaches the hook as the CLI sends it.
 */

/** The session's own `Stop` under Claude Code 2.1.321. */
export const CLAUDE_CODE_STOP =
  '{"session_id":"1525f1a6-f15f-4e61-b7cd-3e0ddc344528","transcript_path":"/Users/jacy/.claude/projects/-private-tmp-claude-501--Users-jacy-Documents-Dev-squiz-b40470cd-5c98-41d6-a7ef-16382cebe8d8-scratchpad-issue-859-repo/1525f1a6-f15f-4e61-b7cd-3e0ddc344528.jsonl","cwd":"/private/tmp/claude-501/-Users-jacy-Documents-Dev-squiz/b40470cd-5c98-41d6-a7ef-16382cebe8d8/scratchpad/issue-859/repo","prompt_id":"09bffad7-93dc-42cd-b450-92953637c56f","permission_mode":"default","effort":{"level":"medium"},"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"DONE","background_tasks":[],"session_crons":[]}';

/** The session's own `Stop` under GitHub Copilot CLI 1.0.110, through a plugin's Claude-format `hooks.json`. */
export const COPILOT_STOP =
  '{"hook_event_name":"Stop","session_id":"af7a1b25-6bdc-459f-99e1-5c3ab2513f83","timestamp":"2026-11-13T12:45:36.630Z","cwd":"/private/tmp/claude-501/-Users-jacy-Documents-Dev-squiz/b40470cd-5c98-41d6-a7ef-16382cebe8d8/scratchpad/issue-859/repo","transcript_path":"/Users/jacy/.copilot/session-state/af7a1b25-6bdc-459f-99e1-5c3ab2513f83/events.jsonl","stop_reason":"end_turn","stop_hook_active":false}';

/** A subagent's `SubagentStop` under GitHub Copilot CLI 1.0.110, from the same run as `COPILOT_STOP`. */
export const COPILOT_SUBAGENT_STOP =
  '{"hook_event_name":"SubagentStop","session_id":"af7a1b25-6bdc-459f-99e1-5c3ab2513f83","timestamp":"2026-11-13T12:45:35.127Z","cwd":"/private/tmp/claude-501/-Users-jacy-Documents-Dev-squiz/b40470cd-5c98-41d6-a7ef-16382cebe8d8/scratchpad/issue-859/repo","agent_id":"dcc0b994-3d65-4ad3-92f3-ccf70b8232d5","agent_type":"explore","parent_agent_id":"af7a1b25-6bdc-459f-99e1-5c3ab2513f83","transcript_path":"/Users/jacy/.copilot/session-state/af7a1b25-6bdc-459f-99e1-5c3ab2513f83/events.jsonl","agent_name":"explore","last_assistant_message":"PONG","stop_reason":"end_turn","stop_hook_active":false}';

/** `payload` with its `cwd` replaced by `cwd`. */
export function withCwd(payload: string, cwd: string): string {
  return JSON.stringify({ ...(JSON.parse(payload) as Record<string, unknown>), cwd });
}
