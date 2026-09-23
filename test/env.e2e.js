'use strict';
/**
 * End-to-end through the real window: create an environment, bind it to a
 * project, launch a session there, and prove the variable arrives in the
 * process -- plus that the secret is encrypted on disk and never rendered raw.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let fails = 0; const out = [];
const check = (n, c, d) => { out.push((c?'PASS  ':'FAIL  ')+n+(c||!d?'':`  (${d})`)); if(!c) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SECRET = 'sk-live-ZXCV1234-do-not-log';

module.exports = async function ({ win, ptys, store, app }) {
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-envproj-'));
  const extFile = path.join(dir, 'extra.env');
  fs.writeFileSync(extFile, 'FROM_FILE_VAR=file-value\n');

  try {
    await sleep(700);

    /* 1. panel opens */
    await js('__envUI.toggleEnv(true)');
    await sleep(400);
    check('env panel opens', (await js("getComputedStyle(document.querySelector('#envpanel')).display")) !== 'none');

    /* 2. encryption is actually on */
    const status = await js('window.seamux.envStatus()');
    check('safeStorage encryption available', status.available === true, JSON.stringify(status));

    /* 3. create a set and import a pasted blob */
    const set = await js("window.seamux.envCreate('e2e-creds')");
    await js(`window.seamux.envImportText(${JSON.stringify(set.id)}, ${JSON.stringify(
      `# creds\nexport API_TOKEN=${SECRET}\nDB_HOST=db.internal\n`)})`);
    await js(`window.seamux.envAddSource(${JSON.stringify(set.id)}, ${JSON.stringify({ type: 'file', path: extFile, mode: 'live' })})`);
    await js(`window.seamux.envAddSource(${JSON.stringify(set.id)}, ${JSON.stringify({ type: 'command', command: 'echo CMD_VAR=from-command' })})`);
    await js('__envUI.refreshEnv()');
    await sleep(600);

    const desc = await js(`window.seamux.envDescribe(${JSON.stringify(set.id)})`);
    check('all three source kinds resolved', desc.count === 4, `keys=${desc.keys.join(',')}`);
    check('pasted var present', desc.keys.includes('API_TOKEN'));
    check('file var present', desc.keys.includes('FROM_FILE_VAR'));
    check('command var present', desc.keys.includes('CMD_VAR'));
    check('no resolution warnings', desc.warnings.length === 0, desc.warnings.join('; '));

    /* 4. the UI must not show the raw secret */
    const panelText = await js("document.querySelector('#envpanel').innerText");
    check('raw secret is NOT rendered in the panel', !panelText.includes(SECRET));
    check('masked form is shown', Object.values(desc.masked).every((v) => !String(v).includes(SECRET)));
    check('origin is attributed', desc.origins.FROM_FILE_VAR.startsWith('file '), desc.origins.FROM_FILE_VAR);

    /* 5. reveal returns the real value on demand */
    check('explicit reveal returns the real value',
      (await js(`window.seamux.envReveal(${JSON.stringify(set.id)}, 'API_TOKEN')`)) === SECRET);

    /* 6. bind to a project and launch a session there */
    await js(`window.seamux.bindEnvSets(${JSON.stringify(dir)}, ${JSON.stringify([set.id])})`);
    check('binding persisted', store.envSetsFor(dir).includes(set.id));

    await js('__envUI.toggleEnv(false)');
    await js(`openProject(${JSON.stringify(dir)}, 'envproj')`);
    await sleep(2000);

    const sess = ptys.list()[0];
    check('session reports the applied environment', (sess.envSetNames || []).includes('e2e-creds'),
      JSON.stringify(sess.envSetNames));
    check('session reports env keys', (sess.envKeys || []).includes('API_TOKEN'));

    /* 7. THE POINT: the variable is really in the process */
    ptys.write(sess.id, 'printf "TOKEN=[%s] HOST=[%s] FILE=[%s] CMD=[%s]\\n" "$API_TOKEN" "$DB_HOST" "$FROM_FILE_VAR" "$CMD_VAR"\n');
    await sleep(1800);
    const replay = ptys.replay(sess.id);
    check('pasted secret reached the shell', replay.includes(`TOKEN=[${SECRET}]`), 'not found in output');
    check('plain var reached the shell', replay.includes('HOST=[db.internal]'));
    check('file var reached the shell', replay.includes('FILE=[file-value]'));
    check('command var reached the shell', replay.includes('CMD=[from-command]'));

    /* 8. inherited env still present (we layer, not replace) */
    ptys.write(sess.id, 'printf "HOME=[%s]\\n" "$HOME"\n');
    await sleep(1200);
    check('inherited environment survives', /HOME=\[\/.+\]/.test(ptys.replay(sess.id)));

    /* 9. encrypted at rest */
    const secretsFile = path.join(app.getPath('userData'), 'seamux-secrets.json');
    const onDisk = fs.readFileSync(secretsFile, 'utf8');
    check('secrets file exists', onDisk.length > 0);
    check('secret is NOT stored in plaintext', !onDisk.includes(SECRET));
    check('file is marked encrypted', JSON.parse(onDisk).encrypted === true);
    const mode = fs.statSync(secretsFile).mode & 0o777;
    check('secrets file is 0600', mode === 0o600, '0' + mode.toString(8));

    /* 10. a session in an UNBOUND project gets nothing */
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-plain-'));
    await js(`openProject(${JSON.stringify(plain)}, 'plain')`);
    await sleep(1800);
    const s2 = ptys.list()[1];
    check('unbound project has no env sets', (s2.envSetNames || []).length === 0);
    ptys.write(s2.id, 'printf "LEAK=[%s]\\n" "$API_TOKEN"\n');
    await sleep(1400);
    check('secret does NOT leak into an unbound session', ptys.replay(s2.id).includes('LEAK=[]'),
      'variable leaked across projects');

    /* 11. deleting a set unbinds it everywhere */
    await js(`window.seamux.envRemove(${JSON.stringify(set.id)})`);
    check('deleted set removed from project bindings', !store.envSetsFor(dir).includes(set.id));
    const after = fs.readFileSync(secretsFile, 'utf8');
    check('deleted secret no longer decryptable from store', !after.includes(SECRET));
  } catch (e) {
    check('suite ran without throwing', false, String(e && e.stack || e));
  }

  console.log('\n===== ENV E2E =====');
  console.log(out.join('\n'));
  console.log(fails === 0 ? `\nALL ${out.length} PASSED` : `\n${fails} of ${out.length} FAILED`);
  app.exit(fails ? 1 : 0);
};
