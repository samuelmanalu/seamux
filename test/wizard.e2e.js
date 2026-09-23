'use strict';
/**
 * Drives the guided Add-context flow the way a person does: clicking buttons
 * by their visible label. If the copy changes, this breaks -- which is the
 * point, since the labels ARE the feature for someone who never opens a terminal.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let fails = 0; const out = [];
const check = (n, c, d) => { out.push((c?'PASS  ':'FAIL  ')+n+(c||!d?'':`  (${d})`)); if(!c) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SECRET = 'pw-WIZARD-9876-secret';

module.exports = async function ({ win, ptys, store, app }) {
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-wiz-'));
  const projName = path.basename(dir);   // projects are named by folder, not session title

  // click the first visible element matching selector whose text contains s
  const clickText = (sel, s) => js(`(() => {
    const t = [...document.querySelectorAll(${JSON.stringify(sel)})]
      .find(e => e.textContent.trim().toLowerCase().includes(${JSON.stringify(s.toLowerCase())}));
    if (!t) return 'NOT FOUND: ' + ${JSON.stringify(s)};
    t.click(); return 'ok';
  })()`);
  const modalText = () => js("document.querySelector('#modal-root').innerText");
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message); });

  try {
    await sleep(700);
    // a project must exist for the binding step to have something to show
    await js(`openProject(${JSON.stringify(dir)}, 'wizproj')`);
    await sleep(1500);

    /* 1. the entry point is visible, not just a shortcut */
    // CSS uppercases section headings, so innerText reads "CONTEXT"
    check('sidebar has a Context section',
      /context/i.test(await js("document.querySelector('#sidebar').innerText")));
    check('sidebar add button exists', (await js("!!document.querySelector('#secrets-new')")) === true);

    /* 2. open the wizard by clicking */
    await js("document.querySelector('#secrets-new').click()");
    await sleep(400);
    check('wizard opens', (await js("!document.querySelector('#modal-root').hidden")) === true);
    let t = await modalText();
    check('step 1 is in plain language', /Add context/i.test(t) && /Paste it exactly/i.test(t), t.slice(0, 120));

    /* 3. typing shows a live preview */
    await js(`(() => { const ta = document.querySelector('#modal-root textarea');
      ta.value = ${JSON.stringify(`# from the team\nexport DB_PASSWORD=${SECRET}\nAPI_BASE_URL=https://stage.internal\n`)};
      ta.dispatchEvent(new Event('input')); })()`);
    await sleep(700);
    t = await modalText();
    check('preview reports what it found', /Found 2 values/i.test(t), t.replace(/\n/g, ' | ').slice(0, 160));
    check('preview names the variables', t.includes('DB_PASSWORD') && t.includes('API_BASE_URL'));
    check('preview does NOT show the raw value', !t.includes(SECRET));

    /* 4. through review */
    check('continue button present', (await clickText('#modal-root button', 'continue')) === 'ok');
    await sleep(400);
    t = await modalText();
    check('review step lists the names', /Check what was found/i.test(t) && t.includes('DB_PASSWORD'));
    check('review masks values', !t.includes(SECRET));

    /* 5. name it */
    await clickText('#modal-root button', 'continue');
    await sleep(400);
    t = await modalText();
    check('naming step asks for a name', /Give these a name/i.test(t));
    await js(`(() => { const i = document.querySelector('#modal-root input.field');
      i.value = 'Wizard Stage'; i.dispatchEvent(new Event('input')); })()`);
    await sleep(250);

    /* 6. pick the project */
    await clickText('#modal-root button', 'continue');
    await sleep(500);
    t = await modalText();
    check('project step explains itself', /Which projects should use these/i.test(t));
    check('the project is listed', t.includes(projName), t.slice(0, 200));
    check('the project you are in is pre-ticked and marked',
      /open now/i.test(t) && (await js(`(() => {
        const row = [...document.querySelectorAll('#modal-root label.env-proj')]
          .find(l => l.textContent.includes(${JSON.stringify(projName)}));
        return row ? row.querySelector('input').checked : false; })()`)) === true);
    // tick by label, not position -- the list holds every known project
    check('can tick the right project by name', (await js(`(() => {
      const row = [...document.querySelectorAll('#modal-root label.env-proj')]
        .find(l => l.textContent.includes(${JSON.stringify(projName)}));
      if (!row) return 'NOT FOUND';
      const cb = row.querySelector('input');
      if (!cb.checked) cb.click();
      return cb.checked ? 'ok' : 'unchecked'; })()`)) === 'ok');
    await sleep(200);

    /* 7. save */
    check('save button present', (await clickText('#modal-root button', 'save')) === 'ok');
    await sleep(1200);
    t = await modalText();
    check('confirmation shown', /Saved/i.test(t), t.slice(0, 120));
    check('confirmation states what happened', /2 values/i.test(t), t.replace(/\n/g,' | ').slice(0,160));
    check('confirmation warns who can read it', /can read these values/i.test(t));

    await clickText('#modal-root button', 'done');
    await sleep(600);
    check('wizard closes', (await js("document.querySelector('#modal-root').hidden")) === true);

    /* 8. it actually saved and bound */
    const all = await js('window.seamux.envList()');
    // take the newest match, not the first -- a stale set from a previous run
    // would otherwise be picked up and the binding check would lie
    const matches = all.filter((s) => s && s.name === 'Wizard Stage');
    const set = matches[matches.length - 1];
    check('exactly one set for this run (clean userData)', matches.length === 1,
      'found ' + matches.length + ' — test data is leaking between runs');
    check('set was created', !!set);
    check('set holds both values', set && set.count === 2, set && `count=${set.count}`);
    check('project binding was applied', store.envSetsFor(dir).includes(set.id));
    check('sidebar lists the new context',
      (await js("document.querySelector('#secrets-list').innerText")).includes('Wizard Stage'));

    /* 9. and it reaches a real session */
    await js(`openProject(${JSON.stringify(dir)}, 'wizproj')`);
    await sleep(2000);
    const sess = ptys.list()[ptys.list().length - 1];
    ptys.write(sess.id, 'printf "PW=[%s] URL=[%s]\\n" "$DB_PASSWORD" "$API_BASE_URL"\n');
    await sleep(1800);
    const replay = ptys.replay(sess.id);
    check('value from the wizard reaches the session', replay.includes(`PW=[${SECRET}]`));
    check('second value reaches the session', replay.includes('URL=[https://stage.internal]'));

    /* 10. cancelling leaves nothing behind */
    const before = (await js('window.seamux.envList()')).length;
    await js("document.querySelector('#secrets-new').click()");
    await sleep(300);
    await clickText('#modal-root button', 'cancel');
    await sleep(300);
    check('cancel closes the wizard', (await js("document.querySelector('#modal-root').hidden")) === true);
    check('cancel creates nothing', (await js('window.seamux.envList()')).length === before);

    check('no renderer console errors', errors.length === 0, errors.join(' | '));
  } catch (e) {
    check('suite ran without throwing', false, String(e && e.stack || e));
  }

  console.log('\n===== WIZARD E2E =====');
  console.log(out.join('\n'));
  console.log(fails === 0 ? `\nALL ${out.length} PASSED` : `\n${fails} of ${out.length} FAILED`);
  app.exit(fails ? 1 : 0);
};
