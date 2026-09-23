'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GeneralContext, diffLines } = require('../src/main/general-context');

let fails = 0;
const ok = (n, c, d) => { console.log((c?'PASS  ':'FAIL  ')+n+(c||!d?'':`  (${d})`)); if(!c) fails++; };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-gc-'));
const file = path.join(tmp, 'CLAUDE.md');

// --- diff ---
let d = diffLines('a\nb\nc', 'a\nB\nc');
eq('diff counts one change', [d.added, d.removed], [1, 1]);
d = diffLines('a\nb', 'a\nb\nc');
eq('diff counts an append', [d.added, d.removed], [1, 0]);
d = diffLines('a\nb\nc', 'a\nc');
eq('diff counts a deletion', [d.added, d.removed], [0, 1]);
d = diffLines('same', 'same');
eq('identical means no change', [d.added, d.removed], [0, 0]);
d = diffLines('', 'new');
eq('from empty', [d.added, d.removed], [1, 1]);
ok('hunks preserve order',
  diffLines('a\nb', 'a\nx\nb').hunks.map(h => h.type).join(',') === 'same,added,same');

// --- missing file ---
const g = new GeneralContext(file);
eq('missing file reports exists:false', g.read().exists, false);
ok('preview against a missing file works', g.preview('hello').added === 1);

// --- first write ---
let r = g.write('# Rules\nline two\n', null);
ok('file created', fs.existsSync(file));
ok('no backup on first write', r.backup === null);
eq('content written', fs.readFileSync(file, 'utf8'), '# Rules\nline two\n');

// --- second write takes a backup ---
const mt = g.read().mtime;
r = g.write('# Rules\nline two\nline three\n', mt);
ok('backup created on overwrite', !!r.backup && fs.existsSync(r.backup));
eq('backup holds the PREVIOUS content', fs.readFileSync(r.backup, 'utf8'), '# Rules\nline two\n');
eq('new content is live', fs.readFileSync(file, 'utf8'), '# Rules\nline two\nline three\n');

// --- stale guard: the whole point of protecting a real CLAUDE.md ---
const stale = g.read().mtime;
fs.writeFileSync(file, 'changed by something else\n');
let threw = null;
try { g.write('my version\n', stale); } catch (e) { threw = e; }
ok('refuses to clobber an outside edit', threw && threw.code === 'STALE');
eq('outside edit survived the refusal', fs.readFileSync(file, 'utf8'), 'changed by something else\n');

// --- restore ---
const backups = g.backups();
ok('backups are listed', backups.length >= 1);
g.restore(backups[backups.length - 1].name);
eq('restore brings back old content', fs.readFileSync(file, 'utf8'), '# Rules\nline two\n');

// --- preview never writes ---
const before = fs.readFileSync(file, 'utf8');
g.preview('something completely different');
eq('preview does not write', fs.readFileSync(file, 'utf8'), before);
ok('preview flags no-op edits', g.preview(before).unchanged === true);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails === 0 ? '\nGENERAL CONTEXT: ALL PASSED' : `\nGENERAL CONTEXT: ${fails} FAILED`);
process.exit(fails ? 1 : 0);
