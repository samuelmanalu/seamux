'use strict';
/**
 * Planning end to end: the project's planner opens beside the board with its
 * instructions, `seamux task add` typed in its terminal puts cards on the
 * board through the control socket, dependencies block a start until done,
 * and there is one planner per project. Stub `claude` on PATH.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let fails = 0; const out = [];
const check = (n, c, d) => { out.push((c ? 'PASS  ' : 'FAIL  ') + n + (c || !d ? '' : `  (${d})`)); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function ({ win, ptys, app, board }) {
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const S = JSON.stringify;
  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) consoleErrors.push(message); });
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-plan-e2e-')));
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(250); } return v; };

  try {
    await sleep(700);
    const existing = await js(`window.seamux.boardCreate({ cwd: ${S(cwd)}, title: 'Set up CI', status: 'ready' })`);

    await js(`window.__board.openPlanner(${S(cwd)})`);
    await sleep(1500);
    const planner = ptys.list().find((s) => s.planner);
    check('the planner opens as its own terminal', !!planner && !planner.taskId && planner.title.startsWith('Plan · '));
    const args = planner ? ptys.sessions.get(planner.id).args : [];
    const sys = args[args.indexOf('--append-system-prompt') + 1] || '';
    check('it gets planner instructions in its system prompt', /You are the planner for the project/.test(sys) && /seamux task add/.test(sys), S(args).slice(0, 300));
    check('it sits beside the board', await js("document.querySelector('#main').classList.contains('planner-open') && !document.querySelector('#boardview').hidden"));
    check('it does not count toward the project limit', (await js("document.querySelector('.b-lanehead .b-limit').textContent")) === '0 / 3');
    const env = ptys.sessions.get(planner.id).extraEnv;
    check('its terminal knows the socket and the project', env.SEAMUX_SOCKET && env.SEAMUX_PROJECT === cwd && env.PATH.includes(path.join(app.getPath('userData'), 'bin')));
    check('the context list stays clean', !(ptys.list().find((s) => s.id === planner.id).envKeys || []).includes('SEAMUX_SOCKET'));

    ptys.write(planner.id, `seamux task add "Write the deploy guide" --brief "Cover rollback too" --after ${existing.id}\r`);
    const added = await waitFor(() => board.list().find((t) => t.title === 'Write the deploy guide'));
    check('seamux task add in the planner puts a card on the board', !!added && added.status === 'backlog' && added.brief === 'Cover rollback too' && added.cwd === cwd, S(added));
    check('with its dependency', added && S(added.dependsOn) === S([existing.id]));
    check('the command prints the new id', await waitFor(() => new RegExp(`${added && added.id}  added to Backlog`).test(ptys.replay(planner.id))));

    ptys.write(planner.id, 'seamux task list\r');
    check('seamux task list shows the board', await waitFor(() => /\[Ready\]  Set up CI/.test(ptys.replay(planner.id)) && /\[Backlog\]  Write the deploy guide  \(waits for /.test(ptys.replay(planner.id))));
    ptys.write(planner.id, 'seamux task add "Elsewhere" --project /tmp/not-a-project\r');
    check('a folder that is not on the board is refused', await waitFor(() => /seamux: not a project on the Seamux board/.test(ptys.replay(planner.id))));

    await js(`window.__board.show(); document.querySelector('[data-status="backlog"]') || null`);
    await js(`window.seamux.boardMove(${S(added.id)}, 'ready')`);
    await sleep(400);
    const card = await js(`document.querySelector('[data-task="${added.id}"]').innerText`);
    check('a waiting card says what it waits for', /Waits for: Set up CI/.test(card), card);
    check('its Start button is disabled', await js(`document.querySelector('[data-task="${added.id}"] .b-actions .mini').classList.contains('disabled')`));
    let refused = '';
    try { await js(`window.seamux.boardStart(${S(added.id)})`); } catch (e) { refused = String(e.message || e); }
    check('starting it is refused', /waits for “Set up CI”/.test(refused), refused);
    await js(`window.seamux.boardMove(${S(existing.id)}, 'done')`);
    await sleep(300);
    const r = await js(`window.seamux.boardStart(${S(added.id)})`);
    check('once the dependency is done it starts', r.status === 'started');

    const again = await js(`window.seamux.boardOpenPlanner(${S(cwd)})`);
    check('one planner per project', again.id === planner.id && ptys.list().filter((s) => s.planner).length === 1);

    await js(`window.__board.show()`);
    await js(`[...document.querySelectorAll('.b-card')].find(c => c.dataset.task === ${S(added.id)}).querySelector('.b-actions button:last-child').click()`);
    await sleep(300);
    check('the edit dialog shows the dependency ticked', await js(`document.querySelector('#task-deps [data-dep="${existing.id}"]').checked`));
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");

    await js('window.__board.hide()');
    await sleep(200);
    check('leaving the board ends the side-by-side layout', !(await js("document.querySelector('#main').classList.contains('planner-open')")));

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  } catch (e) {
    check('suite ran without throwing', false, e.stack || e.message);
  } finally {
    console.log(out.join('\n'));
    console.log(fails ? `${fails} of ${out.length} FAILED` : `ALL ${out.length} PASSED`);
    fs.rmSync(cwd, { recursive: true, force: true });
    app.exit(fails ? 1 : 0);
  }
};
