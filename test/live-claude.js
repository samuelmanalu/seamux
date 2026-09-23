'use strict';
/**
 * The real thing: real window, real renderer, real `claude`. Asserts the
 * sidebar badge tracks an actual turn. Run:
 *   SEAMUX_E2E=$PWD/test/live-claude.js electron .  -- <dir>
 */
let fails = 0; const out = [];
const check = (n, c, d) => { out.push((c?'PASS  ':'FAIL  ')+n+(c||!d?'':`  (${d})`)); if(!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = async function ({ win, ptys, app }) {
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const dir = process.env.SEAMUX_LIVE_DIR;
  const label = () => js("document.querySelector('#session-list .row-sub')?.textContent");
  const dot   = () => js("document.querySelector('#session-list .dot')?.className");
  try {
    await sleep(600);
    await js(`openProject(${JSON.stringify(dir)}, 'live')`);
    await sleep(9000);

    check('session is live in the UI', (await js("document.querySelectorAll('#session-list li').length")) === 1);
    const l0 = await label();
    check('settles to idle at the prompt', l0 === 'idle', `label="${l0}"`);
    check('dot reflects idle', /\bidle\b/.test(await dot()));

    // drive a real turn
    const id = ptys.list()[0].id;
    ptys.write(id, 'Use the Bash tool to run: sleep 12 && echo LIVE_OK');
    await sleep(900); ptys.write(id, '\r');

    let sawWorking = false, seen = [];
    for (let i = 0; i < 24; i++) {
      await sleep(900);
      const l = await label(); seen.push(l);
      if (l === 'working…') { sawWorking = true; break; }
    }
    check('badge shows "working…" during a real turn', sawWorking, `saw: ${[...new Set(seen)].join(' -> ')}`);

    // wait for it to finish
    let backToIdle = false; seen = [];
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      const l = await label(); seen.push(l);
      if (l === 'idle') { backToIdle = true; break; }
    }
    check('badge returns to idle when the turn ends', backToIdle, `saw: ${[...new Set(seen)].join(' -> ')}`);

    const replay = ptys.replay(id);
    check('claude actually ran the command', /LIVE_OK/.test(replay));
  } catch (e) { check('suite ran without throwing', false, String(e && e.stack || e)); }

  console.log('\n===== LIVE CLAUDE =====');
  console.log(out.join('\n'));
  console.log(fails === 0 ? `\nALL ${out.length} PASSED` : `\n${fails} FAILED`);
  app.exit(fails ? 1 : 0);
};
