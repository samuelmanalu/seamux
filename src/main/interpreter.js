'use strict';

const { execFile } = require('child_process');
const path = require('path');

const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 45000;

/**
 * Turns an arbitrary paste into a proposal: variables, standing instructions,
 * and an opening prompt.
 *
 * The paste is very likely to contain credentials, so REAL VALUES NEVER LEAVE
 * THIS MACHINE. Anything that looks like a value is swapped for a placeholder
 * («V1», «V2», …) before the text is sent; the model classifies the structure
 * and echoes placeholders back; the real values are substituted in locally. A
 * placeholder the model invents is dropped rather than guessed at.
 *
 * The model is reached through the user's own `claude -p`, so no separate API
 * key is needed and nothing new has to be authorised.
 */

/** Replace value-looking right-hand sides with placeholders. */
function redact(text) {
  const map = new Map();
  let n = 0;
  const lines = String(text == null ? '' : text).split(/\r?\n/);

  const redacted = lines.map((line) => {
    // Two shapes credentials actually arrive in:
    //   KEY=value / export KEY=value      (env style, label is one token)
    //   oracle user: svc_recon            (notes style, label is a few words)
    // The second nearly leaked a username past an earlier version of this
    // regex, which only accepted single-word labels.
    const envStyle = line.match(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.\-]*\s*=\s*)(.+)$/);
    const noteStyle = line.match(/^(\s*[A-Za-z][A-Za-z0-9 _.\-]{0,40}?\s*:\s*)(\S.*)$/);
    const m = envStyle || noteStyle;
    if (!m) return line;

    const head = m[1];
    let value = m[2].trim();

    // Prose heuristics: a colon line whose right-hand side is a sentence is a
    // note, not a credential. Env-style lines keep their value whatever it is.
    if (!envStyle) {
      const labelWords = head.replace(/:\s*$/, '').trim().split(/\s+/).length;
      if (labelWords > 4) return line;
      if (/\s/.test(value)) return line;          // a real value rarely has spaces
    }
    if (/^[:=]/.test(value) || !value) return line;

    const quote = /^(["']).*\1$/.test(value) ? value[0] : '';
    if (quote) value = value.slice(1, -1);
    if (!value) return line;

    const token = `«V${++n}»`;
    map.set(token, value);
    return head + quote + token + quote;
  }).join('\n');

  return { redacted, map };
}

/** Put the real values back; anything unrecognised is discarded, never guessed. */
function restore(vars, map) {
  const out = {};
  const unknown = [];
  for (const [k, v] of Object.entries(vars || {})) {
    const s = String(v == null ? '' : v).trim();
    const token = s.match(/«V\d+»/);
    if (token && map.has(token[0])) out[k] = map.get(token[0]);
    else if (token) unknown.push(k);
    else out[k] = s;             // model echoed a literal it saw in the prose
  }
  return { vars: out, unknown };
}

const SYSTEM = `You sort a pasted blob into three buckets for a developer tool. Reply with JSON only, no prose, no code fence.

{
  "name": "short name for this context, 2-4 words",
  "variables": { "NAME": "value-or-placeholder" },
  "instructions": "standing rules Claude should follow all session, or empty string",
  "preprompt": "an opening task/question to send as the first message, or empty string",
  "notes": "one short sentence on anything you were unsure about, or empty string"
}

Rules:
- Placeholders look like «V1». Echo them EXACTLY as given. Never invent or alter one.
- variables: credentials, hostnames, tokens, config. Use UPPER_SNAKE_CASE names. Derive a sensible name from the label if needed.
- instructions: standing rules ("always use stage", "never touch prod", coding conventions).
- preprompt: a task or question the user wants done at session start ("summarise open MRs", "review the diff").
- If something is clearly a rule, it is instructions, not preprompt. If it asks for work to be done now, it is preprompt.
- Empty string for buckets that do not apply. Never omit a key.`;

function callModel(redactedText, { cwd, bin } = {}) {
  return new Promise((resolve, reject) => {
    const command = bin || process.env.SEAMUX_CLAUDE_BIN || 'claude';
    execFile(command, [
      '-p', `Sort this paste:\n\n<paste>\n${redactedText}\n</paste>`,
      '--model', MODEL,
      '--append-system-prompt', SYSTEM,
    ], { timeout: TIMEOUT_MS, cwd: cwd || path.dirname(process.execPath), maxBuffer: 1_000_000 },
    (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim().split('\n')[0] || 'model call failed'));
      resolve(String(stdout));
    });
  });
}

/** Pull the JSON object out of a reply that may be fenced or padded with prose. */
function extractJson(reply) {
  const text = String(reply || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('the model did not return JSON');
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * @param {string} text        what the user pasted
 * @param {object} opts        { run } injectable model call, for tests
 * @returns {Promise<{name,variables,instructions,preprompt,notes,redactedSent,placeholders,unknown}>}
 */
async function interpret(text, opts = {}) {
  const { redacted, map } = redact(text);
  const run = opts.run || ((t) => callModel(t, opts));

  const reply = await run(redacted);
  const parsed = extractJson(reply);

  const { vars, unknown } = restore(parsed.variables || {}, map);
  return {
    name: String(parsed.name || '').trim(),
    variables: vars,
    instructions: String(parsed.instructions || '').trim(),
    preprompt: String(parsed.preprompt || '').trim(),
    notes: String(parsed.notes || '').trim(),
    redactedSent: redacted,
    placeholders: map.size,
    unknown,
  };
}

module.exports = { interpret, redact, restore, extractJson, MODEL };
