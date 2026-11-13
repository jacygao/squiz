/**
 * `UserPromptSubmit` payloads as each CLI wrote them to a hook's stdin, in a
 * print-mode run loading a plugin whose `hooks.json` registers the event, word
 * for word.
 *
 * A test that needs another `cwd` replaces that field alone, with
 * `withCwd`, so that every other field reaches the hook as the CLI sends it.
 */

/** The run's prompt under Claude Code 2.1.321. */
export const CLAUDE_CODE_PROMPT =
  '{"session_id":"dff38909-8654-463e-a896-e40ca48e24ed","transcript_path":"/Users/jacy/.claude/projects/-private-tmp-claude-501--Users-jacy-Documents-Dev-squiz-b40470cd-5c98-41d6-a7ef-16382cebe8d8-scratchpad-issue-870-repo/dff38909-8654-463e-a896-e40ca48e24ed.jsonl","cwd":"/private/tmp/claude-501/-Users-jacy-Documents-Dev-squiz/b40470cd-5c98-41d6-a7ef-16382cebe8d8/scratchpad/issue-870/repo","prompt_id":"ef212518-8962-48cf-a4e0-35b7560f5e50","permission_mode":"default","hook_event_name":"UserPromptSubmit","prompt":"Reply with the single word PONG. Requirement: keys are lowercased."}';

/** The run's prompt under GitHub Copilot CLI 1.0.110, through a plugin's Claude-format `hooks.json`. */
export const COPILOT_PROMPT =
  '{"hook_event_name":"UserPromptSubmit","session_id":"51445ba2-2e4c-4c6b-943f-5ee4107e1dd9","timestamp":"2026-11-13T13:14:57.072Z","cwd":"/private/tmp/claude-501/-Users-jacy-Documents-Dev-squiz/b40470cd-5c98-41d6-a7ef-16382cebe8d8/scratchpad/issue-870/repo","prompt":"Reply with the single word PONG. Requirement: keys are lowercased."}';

/**
 * The prompt a session handed its subagent, under GitHub Copilot CLI 1.0.110.
 * Copilot fires `UserPromptSubmit` for it in the parent's `cwd`, after the
 * parent's own. Claude Code 2.1.321 fires none for a subagent.
 */
export const COPILOT_SUBAGENT_PROMPT =
  '{"hook_event_name":"UserPromptSubmit","session_id":"345e010a-de29-4f63-bfae-761e7ccd37fe","timestamp":"2026-11-13T13:16:31.451Z","cwd":"/private/tmp/claude-501/-Users-jacy-Documents-Dev-squiz/b40470cd-5c98-41d6-a7ef-16382cebe8d8/scratchpad/issue-870/repo","agent_id":"345e010a-de29-4f63-bfae-761e7ccd37fe","agent_type":"explore","parent_agent_id":"b5c788af-02e7-4844-b424-c31053761153","prompt":"Reply with the single word PONG."}';
