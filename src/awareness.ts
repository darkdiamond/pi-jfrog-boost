/**
 * What the model is told about Boost.
 *
 * Lossy compaction is only safe if the model knows how to get the original
 * back, so every Boost integration ships this text — `~/.claude/rules/
 * boost-awareness.md` for Claude Code, `BOOST.md` for Codex, a skill for
 * OpenCode. pi has `before_agent_start`, which lets us put it directly in the
 * system prompt rather than hoping the model opens a skill first.
 *
 * Keep it short: it is paid for on every single turn.
 */

/** The system prompt section name; pi wraps the body as `<jfrog-boost>…</jfrog-boost>`. */
export const AWARENESS_SECTION = "jfrog-boost";

export const AWARENESS_BODY = `JFrog Boost is compacting this session's tool output. It covers \`bash\`,
\`powershell\`, \`read\`, \`grep\`, \`find\`, and \`ls\`; results are filtered after the
tool runs, so what you see may be shorter than what the command printed.

- Compacted output is intentional and normally complete enough. Prefer it.
- When compacted output ends in a \`boost retrieve <id>\` marker and you need a
  detail it dropped, run that command instead of re-running the original tool.
  \`boost retrieve <id> --query "…"\` searches the cached output and
  \`boost retrieve <id> --lines 10-40\` prints a range.
- pi's \`read\` cannot decode PDFs or Office files (.docx, .xlsx, .pptx and
  similar). Reading one is converted through Boost automatically;
  \`boost read <path>\` does it on demand.
- Never prefix a command with \`boost\` yourself.
- Prefix a command with \`DISABLE_BOOST=1\` when it must return exact, unfiltered
  output.
- Boost wraps commands, it does not sandbox them. Redaction is best effort, not
  a security boundary.`;

export const BOOST_AWARENESS = `<${AWARENESS_SECTION}>\n${AWARENESS_BODY}\n</${AWARENESS_SECTION}>`;

/** Append the awareness block to a system prompt. */
export function withAwareness(systemPrompt: string): string {
	return systemPrompt.includes(`<${AWARENESS_SECTION}>`)
		? systemPrompt
		: `${systemPrompt}\n\n${BOOST_AWARENESS}`;
}
