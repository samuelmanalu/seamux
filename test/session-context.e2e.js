'use strict';
/**
 * Context belongs to the session, not the project.
 * Also pins down exactly what changes live and what needs a restart.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let fails = 0; const out = [];
const check = (n, c, d) => { out.push((c?'PASS  ':'FAIL  ')+n+(c||!d?'':`  (${d})`)); if(!c) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A terminal wraps long lines, inserting newlines mid-word, so substring
// matching against raw replay is unreliable. Strip escapes and whitespace.
const flat = (t) => String(t).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+/g, '');

module.exports = async function ({ win, ptys, store, app }) {
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-sctx-'));

  const run = async (id, cmd, ms = 1200) => {
    const before = ptys.replay(id).length;
    ptys.write(id, cmd + '\n');
    await sleep(ms);
    return ptys.replay(id).slice(before);
  };

  try {
    await sleep(700);

    /* two context sets to switch between */
    const A = await js("window.seamux.envCreate('Set A')");
    await js(`window.seamux.envImportText(${JSON.stringify(A.id)}, 'STAGE_KEY=aaa-111\\nSHARED=from-A\\n')`);
    const B = await js("window.seamux.envCreate('Set B')");
    await js(`window.seamux.envImportText(${JSON.stringify(B.id)}, 'PROD_KEY=bbb-222\\nSHARED=from-B\\n')`);

    /* project default = A */
    await js(`window.seamux.bindEnvSets(${JSON.stringify(dir)}, ${JSON.stringify([A.id])})`);
    await js(`openProject(${JSON.stringify(dir)}, 'p1')`);
    await sleep(1800);
    const s1 = ptys.list()[0];
    check('session inherits the project default at launch', (s1.envSetNames || []).includes('Set A'));

    let o = await run(s1.id, 'printf "ENV=[%s]\\n" "$STAGE_KEY"');
    check('value is in the real environment at spawn', o.includes('ENV=[aaa-111]'), o.slice(-120));

    /* Values do live in a per-session context file -- that is how a running
       session can pick up changes without restarting. Check its protections,
       and that the long-term store is still encrypted. */
    const userData = app.getPath('userData');
    const ctxDir = path.join(userData, 'context');
    check('context directory is 0700', (fs.statSync(ctxDir).mode & 0o777) === 0o700,
      '0' + (fs.statSync(ctxDir).mode & 0o777).toString(8));
    const plain = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (!/blob_storage|Cache|GPUCache|Local Storage|^context$/.test(e.name)) walk(f); }
      else { try { if (fs.readFileSync(f, 'utf8').includes('aaa-111')) plain.push(f); } catch {} }
    } };
    walk(userData);
    check('secret is not in any file OUTSIDE the context dir', plain.length === 0, plain.join(', '));
    check('the long-term store is still encrypted',
      JSON.parse(fs.readFileSync(path.join(userData, 'seamux-secrets.json'), 'utf8')).encrypted === true);

    /* ---- the interesting part: change context on a RUNNING session ---- */
    await js(`window.seamux.setSessionContext(${JSON.stringify(s1.id)}, ${JSON.stringify([B.id])})`);
    await sleep(600);
    const after = ptys.list().find((x) => x.id === s1.id);
    check('session now reports the new context', (after.envSetNames || []).includes('Set B'));
    check('a restart is flagged as pending', after.contextPending === true);

    o = await run(s1.id, 'printf "OLDENV=[%s] NEWENV=[%s]\\n" "$SHARED" "$PROD_KEY"');
    check('running process still has its spawn-time environment', o.includes('OLDENV=[from-A]'), o.slice(-140));
    check('new var is NOT in the running environment (as documented)', o.includes('NEWENV=[]'));

    /* ---- restart applies it to the environment itself ---- */
    await js(`window.seamux.restartSession(${JSON.stringify(s1.id)}, ${JSON.stringify([B.id])})`);
    await sleep(4000);
    const restarted = ptys.list().find((x) => x.id === s1.id);
    check('session id survives a restart', !!restarted);
    check('pending flag cleared after restart', restarted.contextPending === false);
    check('session count unchanged (restarted in place)', ptys.list().length === 1);

    o = await run(s1.id, 'printf "NOW=[%s] GONE=[%s]\\n" "$PROD_KEY" "$STAGE_KEY"', 1600);
    check('new value is in the environment after restart', o.includes('NOW=[bbb-222]'), o.slice(-140));
    check('old value is gone after restart', o.includes('GONE=[]'));

    /* ---- context is per session, not per project ---- */
    await js(`openProject(${JSON.stringify(dir)}, 'p2')`);
    await sleep(2000);
    const s2 = ptys.list()[1];
    check('second session in the same project starts from the project default',
      (s2.envSetNames || []).includes('Set A'));
    const o1 = await run(s1.id, 'printf "S1=[%s]\\n" "$SHARED"');
    const o2 = await run(s2.id, 'printf "S2=[%s]\\n" "$SHARED"');
    check('two sessions in one project hold DIFFERENT context',
      o1.includes('S1=[from-B]') && o2.includes('S2=[from-A]'),
      `s1=${o1.trim().slice(-30)} s2=${o2.trim().slice(-30)}`);

    /* ---- no-op change should not demand a restart ---- */
    await js(`window.seamux.setSessionContext(${JSON.stringify(s2.id)}, ${JSON.stringify([A.id])})`);
    await sleep(500);
    check('re-applying the same context does not flag a restart',
      ptys.list().find((x) => x.id === s2.id).contextPending === false);

    await js(`window.seamux.removeSession(${JSON.stringify(s2.id)})`);
    await sleep(600);
    check('session removed cleanly', ptys.list().length === 1);

    /* ---------------------------------------------------------------------
     * The reported bug: a session is already running, THEN context is created
     * and bound to its project. The session used to keep its spawn-time
     * environment with nothing in the UI saying so.
     * ------------------------------------------------------------------- */
    const late = fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-late-'));
    await js(`openProject(${JSON.stringify(late)}, 'late')`);
    await sleep(1800);
    const ls = ptys.list().find((x) => x.cwd === late);
    check('a session starts with no context', (ls.envSetNames || []).length === 0);
    check('and is not flagged', ls.contextPending === false);

    const C = await js("window.seamux.envCreate('Added later')");
    // JSON.stringify the payload: a raw newline escape inside a template
    // literal becomes an ACTUAL newline in the code string, which is a
    // syntax error inside executeJavaScript
    await js(`window.seamux.envImportText(${JSON.stringify(C.id)}, ${JSON.stringify('LATE_KEY=late-value\n')})`);
    await js(`window.seamux.bindEnvSets(${JSON.stringify(late)}, ${JSON.stringify([C.id])})`);
    await sleep(900);

    let after2 = ptys.list().find((x) => x.id === ls.id);
    check('binding context to the project FLAGS the running session',
      after2.contextPending === true, 'the session was never told — this was the bug');
    check('and the session now names the context', (after2.envSetNames || []).includes('Added later'));

    o = await run(ls.id, 'printf "BEFORE=[%s]\n" "$LATE_KEY"');
    check('value is not yet a real environment variable (expected)', o.includes('BEFORE=[]'), o.slice(-90));

    /* the session is TOLD, and can load the values without restarting */
    await sleep(1500);
    const injected = ptys.replay(ls.id);
    const flatInjected = flat(injected);
    check('a notice was injected into the running session',
      flatInjected.includes('[Seamux]Contextupdated'), 'nothing was sent to the session');
    check('the notice names the variable', flatInjected.includes('LATE_KEY'));
    check('the notice does NOT contain the value',
      !flatInjected.includes('late-value'), 'the secret was typed into the conversation');
    check('the notice says how to load them', flatInjected.includes('SEAMUX_CONTEXT_FILE'));

    o = await run(ls.id, 'env -i SEAMUX_CONTEXT_FILE="$SEAMUX_CONTEXT_FILE" sh -c \'. "$SEAMUX_CONTEXT_FILE"; printf "VIAFILE=[%s]\\n" "$LATE_KEY"\'', 1600);
    check('the new value IS loadable with no restart', o.includes('VIAFILE=[late-value]'), o.slice(-140));
    check('context file is 0600',
      (fs.statSync(ptys.list().find((x) => x.id === ls.id).contextFile).mode & 0o777) === 0o600);

    await js(`window.seamux.restartSession(${JSON.stringify(ls.id)}, null)`);
    await sleep(4000);
    o = await run(ls.id, 'printf "AFTER=[%s]\n" "$LATE_KEY"', 1600);
    check('restart applies the late-bound context', o.includes('AFTER=[late-value]'), o.slice(-120));
    check('flag cleared', ptys.list().find((x) => x.id === ls.id).contextPending === false);

    /* editing a value in a bound set must also flag running sessions */
    await js(`window.seamux.envSetVar(${JSON.stringify(C.id)}, 'LATE_KEY', 'edited-value')`);
    await sleep(900);
    check('editing a value flags sessions using that context',
      ptys.list().find((x) => x.id === ls.id).contextPending === true);

    /* a session the user pointed at context by hand must NOT be yanked around */
    await js(`window.seamux.setSessionContext(${JSON.stringify(ls.id)}, ${JSON.stringify([])})`);
    await sleep(500);
    await js(`window.seamux.bindEnvSets(${JSON.stringify(late)}, ${JSON.stringify([C.id])})`);
    await sleep(800);
    check('an explicitly-set session ignores later project binding changes',
      (ptys.list().find((x) => x.id === ls.id).envSetNames || []).length === 0);
  } catch (e) {
    check('suite ran without throwing', false, String(e && e.stack || e));
  }

  console.log('\n===== SESSION CONTEXT E2E =====');
  console.log(out.join('\n'));
  console.log(fails === 0 ? `\nALL ${out.length} PASSED` : `\n${fails} of ${out.length} FAILED`);
  app.exit(fails ? 1 : 0);
};
