'use strict';

/**
 * A dotenv-style parser, used for pasted blobs, .env files on disk, and the
 * stdout of an import command.
 *
 * Deliberately tolerant: credentials get pasted from Vault, shell exports and
 * teammates' notes, so `export K=v`, quoting, inline comments and multi-line
 * quoted values all have to survive the round trip. A line it cannot parse is
 * skipped rather than throwing -- one malformed line should not cost you the
 * other twenty.
 */
function parseEnv(text) {
  const out = {};
  const s = String(text == null ? '' : text).replace(/^﻿/, '');
  const n = s.length;
  let i = 0;

  const skipLine = () => { while (i < n && s[i] !== '\n') i++; };

  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (i >= n) break;
    if (s[i] === '#') { skipLine(); continue; }

    if (s.startsWith('export ', i)) i += 7;
    while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;

    const keyStart = i;
    while (i < n && /[A-Za-z0-9_.]/.test(s[i])) i++;
    const key = s.slice(keyStart, i);
    while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;

    if (!key || s[i] !== '=') { skipLine(); continue; }
    i++;
    while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;

    let value = '';
    if (s[i] === '"' || s[i] === "'") {
      const quote = s[i++];
      let buf = '';
      while (i < n && s[i] !== quote) {
        // Escapes are only meaningful inside double quotes, matching sh.
        if (quote === '"' && s[i] === '\\' && i + 1 < n) {
          const next = s[i + 1];
          buf += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          i += 2;
        } else {
          buf += s[i++];
        }
      }
      i++;            // closing quote
      value = buf;
      skipLine();     // ignore any trailing comment
    } else {
      let buf = '';
      while (i < n && s[i] !== '\n') buf += s[i++];
      const comment = buf.search(/\s#/);
      if (comment >= 0) buf = buf.slice(0, comment);
      value = buf.trim();
    }

    out[key] = value;
  }

  return out;
}

/** Render back to .env text, quoting only when the value needs it. */
function stringifyEnv(vars) {
  return Object.entries(vars || {})
    .map(([k, v]) => {
      const s = String(v == null ? '' : v);
      return /[\s"'#\\]/.test(s)
        ? `${k}="${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
        : `${k}=${s}`;
    })
    .join('\n');
}

/** Show enough to recognise a value without putting the secret on screen. */
function maskValue(v) {
  const s = String(v == null ? '' : v);
  if (s.length === 0) return '';
  if (s.length <= 8) return '•'.repeat(s.length);
  return s.slice(0, 2) + '•'.repeat(Math.min(12, s.length - 4)) + s.slice(-2);
}

module.exports = { parseEnv, stringifyEnv, maskValue };
