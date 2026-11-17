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
    check('the task moves to Running or Needs you', board.get(alpha.id).status === 'active' && ['running', 'needs'].includes(await columnOf(alpha.id)), await columnOf(alpha.id));
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

    /* ---------------- phase 2: rules, waiting, next step, peek ---------------- */
    const rules = await js(`window.seamux.rulesAdd(${S(cwd)}, 'Never push to main')`);
    check('a rule can be added to a project', rules.rule && rules.rule.text === 'Never push to main');
    check('running agent terminals are counted to be told', rules.told === 1, S(rules));
    let told = false;
    for (let i = 0; i < 20 && !told; i++) {
      await sleep(300);
      const s = ptys.sessions.get(pA2.id);
      told = /Project rules changed: added "Never push to main"/.test(ptys.replay(pA2.id)) || /Project rules changed/.test(s.pendingInjection || '');
    }
    check('a running Claude terminal is told about the new rule', told);
    check('the shell terminal is not sent the notice', !/Project rules changed/.test(ptys.replay(pB.id)));

    const delta = await js(`window.seamux.boardCreate({ cwd: ${S(cwd)}, title: 'Delta', brief: 'Check rules', status: 'ready' })`);
    await js(`window.seamux.boardSetLimit(${S(cwd)}, 5)`);
    await js(`window.__board.start(${S(delta.id)})`);
    await sleep(1200);
    const pD = paneOf(delta.id);
    const dArgs = pD ? argsOf(pD.id) : [];
    const sys = dArgs[dArgs.indexOf('--append-system-prompt') + 1] || '';
    check('a new Claude terminal gets the rules in its system prompt', /Project rules for .*\n1\. Never push to main/.test(sys), S(dArgs));
    check('the pane records the rules it received', pD && pD.projectRuleCount === 1 && pD.rulesVia === 'system');
    await js(`activate(${S(pD.id)})`);
    await sleep(200);
    check('the rules chip says the terminal has them', (await js("document.querySelector('#session-rules').textContent")) === 'Rules 1 ✓');
    await js(`activate(${S(pB.id)})`);
    await sleep(200);
    check('the chip warns when a terminal has no way to take rules', (await js("document.querySelector('#session-rules').textContent")) === 'Rules not delivered');

    const gem = await js(`window.seamux.boardCreate({ cwd: ${S(cwd)}, title: 'Gee', agent: 'gemini', status: 'ready' })`);
    await js(`window.__board.start(${S(gem.id)})`);
    await sleep(1200);
    const pG = paneOf(gem.id);
    const gArgs = pG ? argsOf(pG.id) : [];
    const gi = gArgs[gArgs.indexOf('-i') + 1] || '';
    check('Gemini gets the rules in its opening message, before the task', /^Project rules for [\s\S]*\n1\. Never push to main\n\nTask: Gee$/.test(gi), S(gArgs));
    check('and the pane says so', pG && pG.rulesVia === 'opening');

    await js(`window.seamux.boardWait(${S(beta.id)}, 'code review on 2 MRs')`);
    await js('window.__board.show()');
    await sleep(300);
    check('Waiting on others has its own column', await columnOf(beta.id) === 'waiting');
    check('the card says what it waits for', /Waiting: code review on 2 MRs/.test(await cardText(beta.id)), await cardText(beta.id));

    ptys.write(pD.id, "printf '\\xe2\\x8f\\xba Next I will drop the three config keys\\n'\r");
    await sleep(600);
    ptys.emit('status', { ...ptys.list().find((x) => x.id === pD.id), state: 'running' });
    ptys.emit('status', { ...ptys.list().find((x) => x.id === pD.id), state: 'idle' });
    await sleep(300);
    check('when the agent stops, its latest message becomes the next step', board.get(delta.id).nextStep === 'Next I will drop the three config keys', board.get(delta.id).nextStep);
    check('the card shows it', /Next I will drop the three config keys/.test(await cardText(delta.id)), await cardText(delta.id));

    await js(`window.__board.select(${S(delta.id)})`);
    await js(`document.querySelector('#boardview').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))`);
    await sleep(900);
    check('Space peeks at the terminal from the board', await js("!document.querySelector('#board-peek').hidden") && /STUB_ARGS/.test(await js("document.querySelector('.p-screen').textContent")));
    await js("[...document.querySelectorAll('#board-peek .p-keys button')].find(b => b.textContent === 'Enter').click()");
    await js("document.querySelector('#peek-reply').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await sleep(200);
    check('Esc closes the peek and stays on the board', await js("document.querySelector('#board-peek').hidden") && await js("!document.querySelector('#boardview').hidden"));

    await js(`activate(${S(pD.id)}); panes.get(${S(pD.id)}).term.selectLines(0, 0)`);
    const selected = await js(`panes.get(${S(pD.id)}).term.getSelection().trim()`);
    await js('window.__board.rulesDialog && null');
    win.webContents.send('ui:promoteRule');
    await sleep(500);
    check('promote opens the rules dialog with the selected text', selected.length > 0 && (await js("document.querySelector('#rule-new')?.value")) === selected, selected);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

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
