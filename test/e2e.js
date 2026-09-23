'use strict';

/**
 * Drives the REAL window: real renderer, real preload, real PTYs.
 * Run: SEAMUX_CLAUDE_BIN=/bin/bash SEAMUX_E2E=$PWD/test/e2e.js npx electron .
 *
 * Unit tests on the detector passed while the UI was unusable, because nothing
 * exercised layout, focus or keystroke delivery. This does.
 */

let fails = 0;
const results = [];
function check(name, cond, detail) {
  results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (cond || !detail ? '' : `\n        ${detail}`));
  if (!cond) fails++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll for a condition instead of sleeping a fixed time. Under full-suite load
 * a shell can take noticeably longer to echo, which made output assertions
 * flaky — the assertion was right, the fixed wait was not.
 */
async function waitFor(fn, timeout = 8000, step = 150) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await sleep(step);
  }
}

module.exports = async function run({ win, ptys, app }) {
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);

  const consoleErrors = [];
  wc.on('console-message', (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });

  try {
    await sleep(600);

    /* ---- renderer scripts all initialised ---- */
    check('renderer.js initialised', (await js('typeof activate')) === 'function');
    check('env-ui.js initialised', (await js('typeof window.__envUI')) === 'object',
      'the env module failed to load — check for a global name collision');

    /* ---- 0. the renderer's internals are reachable for testing ---- */
    check('renderer globals reachable', (await js('typeof openProject')) === 'function');

    /* ---- 1. overlay visibility BEFORE any session ---- */
    check('empty overlay shown when no sessions',
      (await js("getComputedStyle(document.querySelector('#empty')).display")) === 'flex');

    /* ---- 2. create a session through the real renderer path ---- */
    await js(`openProject(${JSON.stringify(process.env.HOME)}, 'e2e')`);
    await sleep(1800);

    check('session created', ptys.list().length === 1);
    check('pane added to DOM', (await js("document.querySelectorAll('.term-pane').length")) === 1);
    check('sidebar row rendered', (await js("document.querySelectorAll('#session-list li').length")) === 1);

    /* ---- 3. THE REGRESSION: overlay must be gone once a session is active ---- */
    const emptyDisplay = await js("getComputedStyle(document.querySelector('#empty')).display");
    check('empty overlay hidden once a session is active', emptyDisplay === 'none',
      `#empty computed display is "${emptyDisplay}" — it is covering the terminal`);

    /* ---- 4. nothing is covering the terminal: hit-test the centre of the pane ---- */
    const onTop = await js(`(() => {
      const p = document.querySelector('.term-pane.active');
      if (!p) return 'NO ACTIVE PANE';
      const r = p.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el ? (el.closest('.term-pane') ? 'terminal' : '#' + (el.id || el.className)) : 'nothing';
    })()`);
    check('terminal is the topmost element at pane centre', onTop === 'terminal',
      `element at pane centre is "${onTop}"`);

    /* ---- 5. the terminal actually has usable dimensions ---- */
    const dims = await js(`(() => { const p = [...panes.values()][0];
      return { cols: p.term.cols, rows: p.term.rows,
               w: p.el.getBoundingClientRect().width, h: p.el.getBoundingClientRect().height }; })()`);
    check('terminal has sane columns', dims.cols > 20, `cols=${dims.cols}`);
    check('terminal has sane rows', dims.rows > 5, `rows=${dims.rows}`);
    check('pane has non-zero size', dims.w > 100 && dims.h > 100, `${dims.w}x${dims.h}`);

    /* ---- 6. the PTY was resized to match what is on screen ---- */
    const sess = [...ptys.sessions.values()][0];
    check('pty cols match terminal cols', sess.proc.cols === dims.cols,
      `pty=${sess.proc.cols} term=${dims.cols}`);
    check('mirror cols match terminal cols', sess.mirror.cols === dims.cols,
      `mirror=${sess.mirror.cols} term=${dims.cols}`);

    /* ---- 7. KEYBOARD: focus, then send real key events through Chromium ---- */
    const focused = await js("document.activeElement && document.activeElement.className");
    check('a terminal textarea holds focus', /xterm-helper-textarea/.test(focused || ''),
      `activeElement.className = "${focused}"`);

    for (const ch of 'echo E2E_KEYBOARD_OK') {
      wc.sendInputEvent({ type: 'char', keyCode: ch });
      await sleep(12);
    }
    wc.sendInputEvent({ type: 'char', keyCode: '\r' });

    check('typed characters reached the pty',
      await waitFor(() => ptys.replay(sess.id).includes('echo E2E_KEYBOARD_OK')),
      'keystrokes never arrived at the shell');
    check('shell echoed the result back',
      await waitFor(() => /^E2E_KEYBOARD_OK$/m.test(ptys.replay(sess.id))),
      'pty produced no echoed output');

    /* ---- 8. output rendered into the visible terminal, not just the mirror ---- */
    const visible = await js(`(() => { const t = [...panes.values()][0].term, b = t.buffer.active, o = [];
      for (let i = 0; i < b.length; i++) o.push(b.getLine(i).translateToString(true));
      return o.join('\\n'); })()`);
    check('output is in the visible terminal buffer', visible.includes('E2E_KEYBOARD_OK'));

    /* ---- 9. a second session, created while the first is active ---- */
    await js(`openProject(${JSON.stringify(process.env.HOME)}, 'e2e-two')`);
    await sleep(1600);
    check('two sessions exist', ptys.list().length === 2);

    const d2 = await js(`(() => { const p = [...panes.values()][1];
      return { cols: p.term.cols, rows: p.term.rows, active: p.el.classList.contains('active') }; })()`);
    check('second pane became active', d2.active === true);
    check('second terminal sized correctly (not opened blind)', d2.cols > 20 && d2.rows > 5,
      `${d2.cols}x${d2.rows}`);

    /* ---- 10. switching back re-fits and refocuses the first ---- */
    const firstId = ptys.list()[0].id;
    await js(`activate(${JSON.stringify(firstId)})`);
    await sleep(700);
    // activate() focuses inside requestAnimationFrame; under load that frame can
    // land well after a fixed sleep, so wait for the focus rather than assume it
    const refocused = await waitFor(() => js(
      "/xterm-helper-textarea/.test(document.activeElement.className || '')"));
    const back = await js(`(() => { const p = panes.get(${JSON.stringify(firstId)});
      return { active: p.el.classList.contains('active'), cols: p.term.cols }; })()`);
    check('switching back activates the first pane', back.active === true);
    check('first pane still correctly sized after switch', back.cols > 20, `cols=${back.cols}`);
    check('focus returns to the terminal after switch', refocused === true);

    /* ---- 11. typing after a switch goes to the RIGHT session ---- */
    for (const ch of 'echo SECOND_ROUND') {
      wc.sendInputEvent({ type: 'char', keyCode: ch });
      await sleep(12);
    }
    wc.sendInputEvent({ type: 'char', keyCode: '\r' });
    const routed = await waitFor(() => ptys.replay(firstId).includes('echo SECOND_ROUND'));
    let why = '';
    if (!routed) {
      // Capture the state instead of guessing on the next run
      const dom = await js(`(() => {
        const a = document.activeElement;
        const active = document.querySelector('.term-pane.active');
        const panesArr = [...panes.entries()].map(([id, p]) => id + (p.el.classList.contains('active') ? '*' : ''));
        return { activeEl: a ? a.className : null,
                 activeInActivePane: !!(active && a && active.contains(a)),
                 panes: panesArr, hidden: document.hidden, hasFocus: document.hasFocus() };
      })()`);
      const sess1 = ptys.sessions.get(firstId);
      why = ` activeEl=${dom.activeEl} inActivePane=${dom.activeInActivePane}`
        + ` panes=${dom.panes.join(',')} docHidden=${dom.hidden} docFocus=${dom.hasFocus}`
        + ` exited=${sess1 && sess1.exited} winFocused=${win.isFocused()}`
        + ` tail=${JSON.stringify(ptys.replay(firstId).slice(-80))}`;
    }
    check('input routed to the active session', routed, why);
    check('input did NOT leak to the other session',
      !ptys.replay(ptys.list()[1].id).includes('SECOND_ROUND'));

    /* ---- 12. debug pane toggles (same specificity trap as #empty) ---- */
    await js('toggleDebug()');
    await sleep(700);
    check('debug pane shows when toggled on',
      (await js("getComputedStyle(document.querySelector('#debug')).display")) !== 'none');
    check('debug pane has screen text',
      ((await js("document.querySelector('#debug-screen').textContent")) || '').length > 0);
    await js('toggleDebug()');
    await sleep(400);
    check('debug pane hides when toggled off',
      (await js("getComputedStyle(document.querySelector('#debug')).display")) === 'none');

    /* ---- 13. alert banner obeys hidden too ---- */
    check('alert banner hidden when nothing is waiting',
      (await js("getComputedStyle(document.querySelector('#alert')).display")) === 'none');

    /* ---- 14. closing a session cleans up ---- */
    await js(`closeSession(${JSON.stringify(firstId)})`);
    await sleep(700);
    check('session removed from manager', ptys.list().length === 1);
    check('pane removed from DOM', (await js("document.querySelectorAll('.term-pane').length")) === 1);

    /* ---- 15. closing the last one restores the empty overlay ---- */
    await js(`closeSession(${JSON.stringify(ptys.list()[0].id)})`);
    await sleep(700);
    check('empty overlay returns when last session closes',
      (await js("getComputedStyle(document.querySelector('#empty')).display")) === 'flex');
    /* a non-Claude profile really spawns: Seamux is not a Claude-only tool */
    const shellSess = await js(`window.seamux.createSession({ cwd: ${JSON.stringify(process.env.HOME)}, title: 'shell', profileId: 'shell' })`);
    await sleep(1500);
    check('a shell-profile session spawns', !!shellSess && shellSess.profileId === 'shell',
      JSON.stringify(shellSess && shellSess.profileId));
    ptys.write(shellSess.id, 'echo PROFILE_SHELL_OK\n');
    check('the shell session runs commands',
      await waitFor(() => ptys.replay(shellSess.id).includes('PROFILE_SHELL_OK')));
    check('no context flags were passed to a shell',
      !(ptys.sessions.get(shellSess.id).args || []).length,
      JSON.stringify(ptys.sessions.get(shellSess.id).args));

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  } catch (err) {
    check('suite ran without throwing', false, String(err && err.stack || err));
  }

  console.log('\n===== SEAMUX E2E =====');
  console.log(results.join('\n'));
  console.log(fails === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${fails} of ${results.length} FAILED`);
  app.exit(fails === 0 ? 0 : 1);
};
