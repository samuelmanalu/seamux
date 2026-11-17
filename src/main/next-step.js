'use strict';

// Pulls the agent's latest message off its screen, so a card can say where
// the work stands without anyone asking a model to summarise it.
//
// Claude Code marks its own messages with "⏺ ". Tool calls use the same
// marker followed by a tool name and a parenthesis ("⏺ Bash(ls)"), so those
// are skipped. Continuation lines are indented by two spaces; a tool result
// starts with "⎿". Other agents have no such marker, so nothing is guessed
// for them.

const MARK = '⏺ ';
const TOOL_CALL = /^[A-Za-z][A-Za-z0-9_.:-]*\(/;   // Bash(…), mcp__server__tool(…)
const MAX = 240;

function clean(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} screen  the rendered screen text
 * @param {string} profileId
 * @returns {string|null}
 */
function extractNextStep(screen, profileId) {
  if (profileId && profileId !== 'claude') return null;
  const lines = String(screen || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith(MARK)) continue;
    const first = line.slice(MARK.length);
    if (TOOL_CALL.test(first)) continue;
    const parts = [first];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (!next.startsWith('  ') || next.trimStart().startsWith('⎿')) break;
      parts.push(next.trim());
    }
    const text = clean(parts.join(' '));
    if (!text) continue;
    return text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text;
  }
  return null;
}

/** A message as a one-line next step: markdown stripped, capped. */
function summarize(text) {
  const t = clean(String(text || ''));
  if (!t) return null;
  return t.length > MAX ? `${t.slice(0, MAX - 1)}…` : t;
}

module.exports = { extractNextStep, summarize };
