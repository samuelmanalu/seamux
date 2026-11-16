'use strict';
/**
 * The board, end to end in the real window: tasks, one terminal per task, the
 * project limit and queue, resume, moving, deleting, and opening a card.
 * `claude` is a stub on PATH (see scripts/run-board-e2e.js) that echoes its
 * arguments, so the exact launch flags can be checked.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let fails = 0; const out = [];
const check = (n, c, d) => { out.push((c ? 'PASS  ' : 'FAIL  ') + n + (c || !d ? '' : `  (${d})`)); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

module.exports = async function ({ win, ptys, app, board }) {
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) consoleErrors.push(message); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-board-e2e-'));
  const cwd = fs.realpathSync(dir);
  const S = JSON.stringify;
  const paneOf = (taskId) => ptys.list().find((s) => s.taskId === taskId);
  const argsOf = (paneId) => ptys.sessions.get(paneId).args;
  const cardText = (taskId) => js(`(document.querySelector('[data-task="${taskId}"]') || {}).innerText || ''`);
  const columnOf = (taskId) => js(`(document.querySelector('[data-task="${taskId}"]')?.closest('.b-cell') || {}).dataset?.status || null`);

  try {
    await sleep(700);

    /* empty board */
    await js('window.__board.show()');
    await sleep(300);
    check('board opens', await js("!document.querySelector('#boardview').hidden"));
    check('empty board offers to add a project', /No projects yet/.test(await js("document.querySelector('#board-lanes').innerText")));

    /* a task and its lane */
    const alpha = await js(`window.seamux.boardCreate({ cwd: ${S(cwd)}, title: 'Alpha', brief: 'Do alpha', status: 'ready' })`);
    await sleep(300);
    check('a new task lands in Ready', await columnOf(alpha.id) === 'ready', await columnOf(alpha.id));
    check('its project gets a lane', (await js("document.querySelector('.b-lanename')?.textContent")) === path.basename(cwd));
    await js(`window.seamux.boardSetLimit(${S(cwd)}, 1)`);
    await sleep(200);
    check('lane header shows live / limit', (await js("document.querySelector('.b-lanehead .b-limit').textContent")) === '0 / 1');

    /* start: one terminal, with session id and opening message */
    await js(`window.__board.start(${S(alpha.id)})`);
    await sleep(1200);
    const pA = paneOf(alpha.id);
    check('starting a task opens one terminal for it', !!pA && !pA.exited);
    check('the task moves to In progress', board.get(alpha.id).status === 'active' && await columnOf(alpha.id) === 'active');
    const aArgs = pA ? argsOf(pA.id) : [];
    const sid = aArgs[aArgs.indexOf('--session-id') + 1];
    check('claude gets a session id', aArgs.includes('--session-id') && UUID.test(sid || ''), S(aArgs));
    check('the session id is stored on the task', board.get(alpha.id).sessionId === sid);
    check('the opening message carries title and brief', aArgs.includes('Task: Alpha\n\nDo alpha'), S(aArgs));
    check('the renderer got a pane for it', await js(`panes.has(${S(pA && pA.id)})`));
    check('the pane is still the only one for the task', ptys.list().filter((s) => s.taskId === alpha.id).length === 1);
    check('lane header counts it', (await js("document.querySelector('.b-lanehead .b-limit').textContent")) === '1 / 1');

    /* the limit queues the next one */
    const beta = await js(`window.seamux.boardCreate({ cwd: ${S(cwd)}, title: 'Beta', agent: 'shell', status: 'ready' })`);
    const r = await js(`window.seamux.boardStart(${S(beta.id)})`);
    await sleep(300);
    check('beyond the limit a task is queued', r.status === 'queued' && board.get(beta.id).status === 'queued', S(r));
    check('a queued card says what it waits for', /Waiting: a free slot/.test(await cardText(beta.id)), await cardText(beta.id));
    check('no terminal for the queued task', !paneOf(beta.id));

    /* closing Alpha's pane starts Beta */
    await js(`closeSession(${S(pA.id)})`);
    await sleep(1200);
    const pB = paneOf(beta.id);
    check('closing a task terminal starts the queued task', !!pB && !pB.exited && board.get(beta.id).status === 'active');
    check('the queued task got a pane in the renderer', await js(`panes.has(${S(pB && pB.id)})`));
    check('the shell agent gets no opening message', pB && argsOf(pB.id).length === 0, S(pB && argsOf(pB.id)));
    check('the closed task is back in Ready', board.get(alpha.id).status === 'ready');
    check('its card offers Resume', /Resume/.test(await cardText(alpha.id)), await cardText(alpha.id));

    /* resume continues the same conversation */
    await js(`window.seamux.boardSetLimit(${S(cwd)}, 2)`);
    await js(`window.__board.start(${S(alpha.id)})`);
    await sleep(1200);
    const pA2 = paneOf(alpha.id);
    const a2 = pA2 ? argsOf(pA2.id) : [];
    check('resume passes --resume with the same id', a2[a2.indexOf('--resume') + 1] === sid, S(a2));
    check('resume does not send the opening message again', !a2.some((x) => /^Task: /.test(x)), S(a2));
    check('resume does not mint a new session id', !a2.includes('--session-id'));

    /* moving and deleting */
    await js(`window.__board.move(${S(beta.id)}, 'review')`);
    await sleep(300);
    check('a running task can move to Review', board.get(beta.id).status === 'review' && await columnOf(beta.id) === 'review');
    check('its terminal keeps running', !paneOf(beta.id).exited);
    let refused = false;
    try { await js(`window.seamux.boardRemove(${S(beta.id)})`); } catch { refused = true; }
    check('deleting a task with a live terminal is refused', refused && !!board.get(beta.id));

    /* opening a card shows its terminal */
    await js('window.__board.show()');
    await sleep(300);
    await js(`document.querySelector('[data-task="${alpha.id}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await sleep(300);
    check('opening a running card shows its terminal', await js("document.querySelector('#boardview').hidden") && await js(`activeId === ${S(pA2.id)}`));

    /* keyboard */
    await js('window.__board.show()');
    await sleep(300);
    await js(`window.__board.select(${S(alpha.id)})`);
    await js(`document.querySelector('#boardview').dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }))`);
    await sleep(200);
    check('M opens the move dialog', /Move “Alpha”/.test(await js("document.querySelector('#modal-root').innerText")));
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await js(`document.querySelector('#boardview').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    await sleep(300);
    check('Enter opens the selected card', await js(`activeId === ${S(pA2.id)}`));

    /* new task dialog */
    await js('window.__board.show()');
    await sleep(200);
    await js("document.querySelector('#boardview').dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }))");
    await sleep(200);
    check('N opens the new task dialog', /New task/.test(await js("document.querySelector('#modal-root').innerText")));
    await js("document.querySelector('#task-title').value = 'Gamma'");
    await js("[...document.querySelectorAll('#modal-root button')].find(b => b.textContent === 'Add to Backlog').click()");
    await sleep(400);
    const gamma = board.list().find((t) => t.title === 'Gamma');
    check('the dialog adds a task to Backlog', !!gamma && gamma.status === 'backlog' && gamma.cwd === cwd);
    check('Backlog is hidden until asked for', await columnOf(gamma.id) === null);

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  } catch (e) {
    check('suite ran without throwing', false, e.stack || e.message);
  } finally {
    console.log(out.join('\n'));
    console.log(fails ? `${fails} of ${out.length} FAILED` : `ALL ${out.length} PASSED`);
    fs.rmSync(dir, { recursive: true, force: true });
    app.exit(fails ? 1 : 0);
  }
};
