'use strict';
/**
 * EnvManager against a fake secret store, so this runs in plain node.
 * Covers the precedence rules, which are the part most likely to silently
 * hand a session the wrong credentials.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EnvManager } = require('../src/main/env-manager');

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`));
  if (!ok) fails++;
};
const ok = (name, cond, d) => { console.log((cond?'PASS  ':'FAIL  ')+name+(cond||!d?'':`  (${d})`)); if(!cond) fails++; };

const fake = () => ({ data: { envSets: [] }, save() { this.saved = (this.saved||0)+1; } });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-env-'));

(async () => {
  // --- inline + precedence ---
  let st = fake(); let m = new EnvManager(st);
  const a = m.create('stage');
  m.addSource(a.id, { type: 'inline', vars: { A: '1', B: '2' } });
  m.addSource(a.id, { type: 'inline', vars: { B: 'override' } });
  let r = await m.resolveSet(a.id);
  eq('later source wins within a set', r.vars, { A: '1', B: 'override' });
  eq('origin tracks the winning source', r.origins.B, '1 pasted variables');

  // --- file source, live ---
  const f = path.join(tmp, '.env');
  fs.writeFileSync(f, 'FROM_FILE=yes\nB=fromfile\n');
  m.addSource(a.id, { type: 'file', path: f, mode: 'live' });
  r = await m.resolveSet(a.id);
  eq('file source layers over inline', r.vars, { A: '1', B: 'fromfile', FROM_FILE: 'yes' });

  fs.writeFileSync(f, 'FROM_FILE=changed\nB=fromfile\n');
  r = await m.resolveSet(a.id);
  eq('live file re-reads on each resolve', r.vars.FROM_FILE, 'changed');

  // --- snapshot does not re-read ---
  st = fake(); m = new EnvManager(st);
  const snap = m.create('snap');
  m.addSource(snap.id, { type: 'file', path: f, mode: 'snapshot', vars: { FROM_FILE: 'frozen' } });
  fs.writeFileSync(f, 'FROM_FILE=moved-on\n');
  r = await m.resolveSet(snap.id);
  eq('snapshot keeps the frozen value', r.vars.FROM_FILE, 'frozen');

  // --- missing file warns, does not throw ---
  st = fake(); m = new EnvManager(st);
  const bad = m.create('bad');
  m.addSource(bad.id, { type: 'inline', vars: { KEEP: 'me' } });
  m.addSource(bad.id, { type: 'file', path: path.join(tmp, 'nope.env'), mode: 'live' });
  r = await m.resolveSet(bad.id);
  eq('other vars survive a broken source', r.vars, { KEEP: 'me' });
  ok('broken source produces a warning', r.warnings.length === 1, JSON.stringify(r.warnings));

  // --- command source ---
  st = fake(); m = new EnvManager(st);
  const c = m.create('cmd');
  m.addSource(c.id, { type: 'command', command: 'echo "CMD_VAR=hello"; echo NUM=42' });
  r = await m.resolveSet(c.id);
  eq('command stdout parsed', r.vars, { CMD_VAR: 'hello', NUM: '42' });

  m.addSource(c.id, { type: 'command', command: 'exit 3' });
  r = await m.resolveSet(c.id);
  ok('failing command warns but keeps earlier vars', r.warnings.length === 1 && r.vars.CMD_VAR === 'hello');

  // --- across sets ---
  st = fake(); m = new EnvManager(st);
  const s1 = m.create('one'); const s2 = m.create('two');
  m.addSource(s1.id, { type: 'inline', vars: { X: 'one', ONLY1: 'a' } });
  m.addSource(s2.id, { type: 'inline', vars: { X: 'two' } });
  const many = await m.resolveMany([s1.id, s2.id]);
  eq('later set wins across sets', many.vars, { X: 'two', ONLY1: 'a' });
  eq('resolveMany reports set names', many.names, ['one', 'two']);
  const rev = await m.resolveMany([s2.id, s1.id]);
  eq('binding order is respected', rev.vars.X, 'one');

  // --- describe masks values ---
  const d = await m.describe(s1.id);
  ok('describe never returns raw values', !JSON.stringify(d).includes('"one"') || !Object.values(d.masked).includes('one'));
  eq('describe lists keys sorted', d.keys, ['ONLY1', 'X']);
  ok('masked value is masked', d.masked.ONLY1 !== 'a', d.masked.ONLY1);
  eq('reveal returns the real value', await m.reveal(s1.id, 'X'), 'one');

  // --- var CRUD ---
  m.setVar(s1.id, 'NEW', 'v');
  eq('setVar adds', (await m.resolveSet(s1.id)).vars.NEW, 'v');
  m.setVar(s1.id, 'NEW', 'v2');
  eq('setVar updates', (await m.resolveSet(s1.id)).vars.NEW, 'v2');
  m.removeVar(s1.id, 'NEW');
  ok('removeVar deletes', !('NEW' in (await m.resolveSet(s1.id)).vars));
  m.remove(s2.id);
  ok('remove deletes the set', m.get(s2.id) === null);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails === 0 ? '\nENV MANAGER: ALL PASSED' : `\nENV MANAGER: ${fails} FAILED`);
  process.exit(fails ? 1 : 0);
})();
