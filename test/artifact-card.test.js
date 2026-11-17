'use strict';

// artifact-card parsing on the shapes Jejak actually stores, including the
// awkward ones: parentheses and dashes inside titles, generic titles, and a
// URL saved with a trailing comma.

const assert = require('assert');
const { parse, cards } = require('../src/renderer/artifact-card');

const HOME = '/Users/someone';
const doc = (title, rel, summary) => ({
  type: 'artifact',
  content: `Document: ${title} (~/${rel}) — ${summary}`,
  source_file: `${HOME}/${rel}`,
});

// Document with parentheses in its title.
let p = parse(doc('Release playbook (old-api -> new-api)', 'notes/PLAYBOOK.md', 'Goal: move every caller.'));
assert.deepStrictEqual(
  [p.kind, p.title, p.location, p.desc],
  ['document', 'Release playbook (old-api -> new-api)', `${HOME}/notes/PLAYBOOK.md`, 'Goal: move every caller.'],
);

// Document with a dash and parentheses in its title.
p = parse(doc('billing — retest (2026-11-14, build 96818ae)', 'runs/billing.md', 'Same flow as before.'));
assert.strictEqual(p.title, 'billing — retest (2026-11-14, build 96818ae)');
assert.strictEqual(p.desc, 'Same flow as before.');

// Generic title falls back to the file name.
p = parse(doc('---', 'memory/some-note.md', 'name: some-note'));
assert.strictEqual(p.title, 'some-note.md');

// Published artifact: title — desc (url).
p = parse({
  content: 'Artifact: plan.html — Test plan and results. (https://claude.ai/artifact/AbC123)',
  source_file: 'https://claude.ai/artifact/AbC123',
});
assert.deepStrictEqual(
  [p.kind, p.label, p.title, p.desc, p.location],
  ['artifact', 'Published', 'plan.html', 'Test plan and results.', 'https://claude.ai/artifact/AbC123'],
);

// Title with parentheses, no description.
p = parse({ content: 'Artifact: Status (stage) and runbook (https://claude.ai/artifact/Xy9)', source_file: 'https://claude.ai/artifact/Xy9' });
assert.deepStrictEqual([p.title, p.desc], ['Status (stage) and runbook', '']);

// Generic title, and a URL stored with a trailing comma.
p = parse({ content: 'Artifact: Artifact (https://claude.ai/artifact/Q1,)', source_file: 'https://claude.ai/artifact/Q1,' });
assert.deepStrictEqual([p.title, p.location], ['Untitled artifact', 'https://claude.ai/artifact/Q1']);

// No source_file: falls back to the last location-looking parenthetical.
p = parse({ content: 'Document: Notes (draft) (~/n.md) — x' });
assert.deepStrictEqual([p.title, p.location], ['Notes (draft)', '~/n.md']);

// cards(): newest first, the comma-URL duplicate collapses into one card.
const list = cards([
  { id: '1', created_at: '2026-01-01T00:00', content: 'Artifact: Artifact (https://claude.ai/artifact/Q1)', source_file: 'https://claude.ai/artifact/Q1' },
  { id: '2', created_at: '2026-01-02T00:00', content: 'Artifact: Artifact (https://claude.ai/artifact/Q1,)', source_file: 'https://claude.ai/artifact/Q1,' },
  { id: '3', created_at: '2026-01-03T00:00', ...doc('Report', 'r.md', 'y') },
]);
assert.deepStrictEqual(list.map((c) => c.title), ['Report', 'Untitled artifact']);
assert.strictEqual(list[1].createdAt, '2026-01-02T00:00');

console.log('artifact-card: ok');
