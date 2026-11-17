'use strict';

// Turns Jejak `artifact` records into card fields. Loaded as a classic script
// in the renderer (exposes window.SeamuxArtifacts) and require()d by tests.
//
// Jejak writes content in two shapes:
//   "Document: <title> (<path>) — <summary>"
//   "Artifact: <title> — <desc> (<url>)"
// Titles may themselves contain parentheses and " — ", so the location is not
// found by "first parenthetical": the record's source_file is the truth, and
// the parenthetical that holds it is the split point.
(function (root) {
  const GENERIC_TITLE = /^(artifact|document|untitled|-+)?$/i;

  // Jejak has stored URLs with a trailing comma picked up from prose.
  function cleanLocation(loc) {
    const s = String(loc || '').trim();
    return /^https?:\/\//.test(s) ? s.replace(/[),.;]+$/, '') : s;
  }

  function matchesLocation(inner, location) {
    const a = cleanLocation(inner);
    if (!a || !location) return false;
    if (a === location) return true;
    // Content shows paths under home as ~/...; source_file is absolute.
    return a.startsWith('~/') && location.endsWith(a.slice(1));
  }

  function looksLikeLocation(inner) {
    return /^(https?:\/\/\S+|~\/|\/)/.test(inner.trim());
  }

  function basename(p) {
    const parts = String(p).split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  function parse(item) {
    let rest = String((item && item.content) || '');
    let kind = 'artifact';
    let label = 'Published';
    if (rest.startsWith('Document: ')) { kind = 'document'; label = 'Document'; rest = rest.slice(10); }
    else if (rest.startsWith('Artifact: ')) { rest = rest.slice(10); }

    let location = cleanLocation(item && item.source_file);
    const groups = [...rest.matchAll(/\(([^()]*)\)/g)];
    let hit = groups.filter((g) => matchesLocation(g[1], location)).pop();
    if (!hit) hit = groups.filter((g) => looksLikeLocation(g[1])).pop();
    if (hit && !location) location = cleanLocation(hit[1]);

    let title = rest;
    let desc = '';
    if (hit) {
      title = rest.slice(0, hit.index);
      desc = rest.slice(hit.index + hit[0].length);
    }
    title = title.trim().replace(/\s*—$/, '').trim();
    desc = desc.trim().replace(/^—\s*/, '').trim();
    // "Artifact: <title> — <desc> (<url>)": the description sits in the title
    // half. Split on the first dash only for this shape.
    if (kind === 'artifact' && !desc) {
      const i = title.indexOf(' — ');
      if (i >= 0) { desc = title.slice(i + 3).trim(); title = title.slice(0, i).trim(); }
    }
    if (GENERIC_TITLE.test(title)) {
      title = kind === 'document' ? (basename(location) || 'Untitled document') : 'Untitled artifact';
    }
    return { kind, label, title, desc, location };
  }

  /** Parse and drop repeats of the same location, keeping the newest. */
  function cards(items) {
    const sorted = [...(items || [])].sort((a, b) =>
      String(b.created_at || '').localeCompare(String(a.created_at || '')));
    const seen = new Set();
    const out = [];
    for (const item of sorted) {
      const card = { ...parse(item), createdAt: item.created_at || '' };
      const key = card.location || item.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(card);
    }
    return out;
  }

  const api = { parse, cards };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SeamuxArtifacts = api;
})(typeof window !== 'undefined' ? window : globalThis);
