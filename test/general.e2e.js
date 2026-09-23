'use strict';
/**
 * Two kinds of context:
 *   - general  : the global CLAUDE.md every session reads (confirmation + backup)
 *   - session  : values AND instructions, carried in at spawn
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let fails = 0; const out = [];
const check = (n, c, d) => { out.push((c?'PASS  ':'FAIL  ')+n+(c||!d?'':`  (${d})`)); if(!c) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = async function ({ win, ptys, app }) {
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const clickText = (sel, s) => js(`(() => {
    const t = [...document.querySelectorAll(${JSON.stringify(sel)})]
      .find(e => e.textContent.trim().toLowerCase().includes(${JSON.stringify(s.toLowerCase())}));
    if (!t) return 'NOT FOUND'; t.click(); return 'ok'; })()`);
  const modalText = () => js("document.querySelector('#modal-root').innerText");
  const GC = process.env.SEAMUX_GENERAL_CONTEXT;
  const errors = [];
  win.webContents.on('console-message', (_e, lvl, m) => { if (lvl >= 2) errors.push(m); });

  try {
    await sleep(700);
    check('test points at an isolated CLAUDE.md', !!GC && GC !== path.join(os.homedir(), '.claude', 'CLAUDE.md'), GC);

    /* ---------- general context ---------- */
    await js('__envUI.toggleEnv(true)');
    await js("__envUI.switchTab('general')");
    await sleep(600);
    check('General tab shows the file path',
      (await js("document.querySelector('#general-info').innerText")).includes(GC));
    check('existing rules are loaded into the editor',
      (await js("document.querySelector('#general-text').value")).includes('ORIGINAL RULE'));

    /* edit + save -> confirmation box with a diff */
    await js(`(() => { const t = document.querySelector('#general-text');
      t.value = t.value.replace('ORIGINAL RULE', 'CHANGED RULE') + '\\nA BRAND NEW LINE\\n'; })()`);
    await js('__envUI.saveGeneral()');
    await sleep(700);
    check('a confirmation box appears before writing',
      (await js("!document.querySelector('#modal-root').hidden")) === true);
    let t = await modalText();
    check('confirmation names the consequence', /rules for every session/i.test(t), t.slice(0, 90));
    check('confirmation shows what was added', t.includes('A BRAND NEW LINE'));
    check('confirmation shows what was removed', t.includes('ORIGINAL RULE'));
    // derive the numbers rather than hardcoding: appending to a file that already
    // ends in a newline also adds a blank line, which is easy to miscount by hand
    const counts = t.match(/\+(\d+) added[\s\S]*?(\d+) removed/);
    check('confirmation counts the changes',
      !!counts && Number(counts[1]) >= 2 && Number(counts[2]) === 1,
      counts ? `+${counts[1]} / -${counts[2]}` : 'no counts shown');
    check('confirmation warns running sessions are unaffected', /already running/i.test(t));

    /* cancel must not write */
    const before = fs.readFileSync(GC, 'utf8');
    await clickText('#modal-root button', 'cancel');
    await sleep(400);
    check('cancel writes nothing', fs.readFileSync(GC, 'utf8') === before);
    check('cancel closes the box', (await js("document.querySelector('#modal-root').hidden")) === true);

    /* confirm writes, and backs up */
    await js('__envUI.saveGeneral()');
    await sleep(700);
    await clickText('#modal-root button', 'save changes');
    await sleep(900);
    const after = fs.readFileSync(GC, 'utf8');
    check('confirming writes the file', after.includes('CHANGED RULE') && after.includes('A BRAND NEW LINE'));
    const backups = await js('window.seamux.generalBackups()');
    check('a backup was kept', backups.length === 1, JSON.stringify(backups.map(b => b.name)));
    check('backup holds the previous content',
      fs.readFileSync(backups[0].path, 'utf8').includes('ORIGINAL RULE'));

    /* no-op save is reported, not written */
    await js('__envUI.saveGeneral()');
    await sleep(500);
    check('an unchanged save asks for no confirmation',
      (await js("document.querySelector('#modal-root').hidden")) === true);
    check('and says so', /no changes/i.test(await js("document.querySelector('#general-status').innerText")));

    /* an edit made outside Seamux must not be clobbered */
    fs.writeFileSync(GC, 'EDITED OUTSIDE SEAMUX\n');
    await js(`(() => { document.querySelector('#general-text').value = 'my competing version'; })()`);
    await js('__envUI.saveGeneral()');
    await sleep(600);
    await clickText('#modal-root button', 'save changes');
    await sleep(900);
    check('refuses to clobber an outside edit', fs.readFileSync(GC, 'utf8') === 'EDITED OUTSIDE SEAMUX\n',
      'the outside edit was overwritten');
    t = await modalText();
    check('and explains why', /changed outside Seamux/i.test(t), t.slice(0, 120));
    await clickText('#modal-root button', 'ok');
    await sleep(400);

    /* ---------- session instructions ---------- */
    await js('__envUI.toggleEnv(false)');
    const setObj = await js("window.seamux.envCreate('With instructions')");
    await js(`window.seamux.envAddSource(${JSON.stringify(setObj.id)}, ${JSON.stringify(
      { type: 'instructions', text: 'ALWAYS USE THE STAGE DATABASE.' })})`);
    await js(`window.seamux.envImportText(${JSON.stringify(setObj.id)}, 'SOME_VAR=v1\\n')`);

    const desc = await js(`window.seamux.envDescribe(${JSON.stringify(setObj.id)})`);
    check('a context set holds instructions and values together',
      desc.instructionCount === 1 && desc.count === 1, JSON.stringify([desc.instructionCount, desc.count]));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-gen-'));
    await js(`window.seamux.bindEnvSets(${JSON.stringify(dir)}, ${JSON.stringify([setObj.id])})`);
    await js(`openProject(${JSON.stringify(dir)}, 'genproj')`);
    await sleep(2500);

    const sess = ptys.list()[ptys.list().length - 1];
    check('session reports its instruction count', sess.instructionCount === 1, String(sess.instructionCount));
    const replay = ptys.replay(sess.id);
    check('instructions are passed as --append-system-prompt',
      replay.includes('--append-system-prompt'), replay.slice(0, 200));
    check('the instruction text is what gets passed',
      replay.includes('ALWAYS USE THE STAGE DATABASE.'), replay.slice(0, 200));

    check('no renderer console errors', errors.length === 0, errors.join(' | '));
  } catch (e) {
    check('suite ran without throwing', false, String(e && e.stack || e));
  }

  console.log('\n===== GENERAL + INSTRUCTIONS E2E =====');
  console.log(out.join('\n'));
  console.log(fails === 0 ? `\nALL ${out.length} PASSED` : `\n${fails} of ${out.length} FAILED`);
  app.exit(fails ? 1 : 0);
};
