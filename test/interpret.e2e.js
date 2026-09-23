'use strict';
/**
 * Paste anything -> model sorts it -> user confirms -> the three kinds reach a
 * real session. Uses a stub `claude` that answers `-p` with fixed JSON, so the
 * flow is deterministic; interpreter.test.js covers the redaction rules and a
 * separate manual probe covers the real model.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let fails = 0; const out = [];
const check = (n, c, d) => { out.push((c?'PASS  ':'FAIL  ')+n+(c||!d?'':`  (${d})`)); if(!c) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SECRET = 'p@ssw0rd-NEVER-SENT';

module.exports = async function ({ win, ptys, app }) {
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const clickText = (sel, s) => js(`(() => {
    const t = [...document.querySelectorAll(${JSON.stringify(sel)})]
      .find(e => e.textContent.trim().toLowerCase().includes(${JSON.stringify(s.toLowerCase())}));
    if (!t) return 'NOT FOUND'; t.click(); return 'ok'; })()`);
  const modalText = () => js("document.querySelector('#modal-root').innerText");
  const errors = [];
  win.webContents.on('console-message', (_e, lvl, m) => { if (lvl >= 2) errors.push(m); });

  try {
    await sleep(700);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-int-'));
    await js(`openProject(${JSON.stringify(dir)}, 'intproj')`);
    await sleep(1600);

    /* open the wizard and paste something that is NOT just KEY=value */
    await js("document.querySelector('#secrets-new').click()");
    await sleep(400);
    const paste = `stage creds from the team\nDB_PASSWORD=${SECRET}\noracle user: svc_recon\n\n`
      + `Always use the stage config, never prod.\n\nStart by summarising the open MRs.`;
    await js(`(() => { const ta = document.querySelector('#modal-root textarea');
      ta.value = ${JSON.stringify(paste)}; ta.dispatchEvent(new Event('input')); })()`);
    await sleep(700);

    check('the interpret action is offered', /sort this out for me/i.test(await modalText()));
    check('the privacy promise is stated up front',
      /never leave this Mac/i.test(await modalText()));

    /* run it */
    check('interpret clicks', (await clickText('#modal-root button', 'sort this out for me')) === 'ok');
    await sleep(3500);
    let t = await modalText();
    check('it lands on the review step', /what it made of that/i.test(t), t.slice(0, 110));
    check('values bucket shown', /values/i.test(t) && t.includes('DB_PASSWORD'));
    // assert on what the MODEL returned, not the original paste -- the two differ
    check('standing instructions bucket shown',
      /standing instructions/i.test(t) && /Always stage\./.test(t), t.slice(0, 300));
    check('opening prompt bucket shown',
      /opening prompt/i.test(t) && /Summarise MRs\./.test(t), t.slice(0, 300));
    check('the secret is NOT displayed in the review', !t.includes(SECRET), 'secret shown on screen');

    /* name is pre-filled from the model's suggestion */
    await clickText('#modal-root button', 'continue');
    await sleep(500);
    const nameVal = await js("document.querySelector('#modal-root input.field').value");
    check('name is pre-filled by the model', nameVal === 'Stage DB', `"${nameVal}"`);

    await clickText('#modal-root button', 'continue');
    await sleep(600);
    await clickText('#modal-root button', 'save');
    await sleep(1500);
    check('saved', /saved/i.test(await modalText()));
    await clickText('#modal-root button', 'done');
    await sleep(600);

    /* the set holds all three kinds */
    const all = await js('window.seamux.envList()');
    const set = all.filter((x) => x && x.name === 'Stage DB').pop();
    check('set created from the proposal', !!set);
    const desc = await js(`window.seamux.envDescribe(${JSON.stringify(set.id)})`);
    check('values stored', desc.count === 1 && desc.keys.includes('DB_PASSWORD'), desc.keys.join(','));
    check('real secret restored locally into the store',
      (await js(`window.seamux.envReveal(${JSON.stringify(set.id)}, 'DB_PASSWORD')`)) === SECRET);
    check('instructions stored', desc.instructionCount === 1);
    check('opening prompt stored', desc.prePromptCount === 1);

    /* and all three reach a real session */
    await js(`window.seamux.bindEnvSets(${JSON.stringify(dir)}, ${JSON.stringify([set.id])})`);
    await js(`openProject(${JSON.stringify(dir)}, 'intproj')`);
    await sleep(2500);
    const sess = ptys.list()[ptys.list().length - 1];
    const replay = ptys.replay(sess.id);
    check('instructions passed as --append-system-prompt', replay.includes('--append-system-prompt'));
    check('instruction text passed', replay.includes('Always stage.'), replay.slice(0, 220));
    check('opening prompt passed as the positional argument',
      /Summarise MRs\.\]/.test(replay), replay.slice(0, 220));
    check('session counts both prose kinds',
      sess.instructionCount === 1 && sess.prePromptCount === 1,
      `${sess.instructionCount}/${sess.prePromptCount}`);
    check('value is in the session environment',
      (await (async () => { ptys.write(sess.id, 'printf "V=[%s]\\n" "$DB_PASSWORD"\n');
        await sleep(1400); return ptys.replay(sess.id); })()).includes(`V=[${SECRET}]`));

    check('no renderer console errors', errors.length === 0, errors.join(' | '));
  } catch (e) {
    check('suite ran without throwing', false, String(e && e.stack || e));
  }

  console.log('\n===== INTERPRET E2E =====');
  console.log(out.join('\n'));
  console.log(fails === 0 ? `\nALL ${out.length} PASSED` : `\n${fails} of ${out.length} FAILED`);
  app.exit(fails ? 1 : 0);
};
