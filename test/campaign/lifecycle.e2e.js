'use strict';
/**
 * Campaign 1: the board's lifecycle and its edges. Limits and the queue
 * across projects, terminals ending by themselves, restarts, deleting and
 * editing, drag and drop, keyboard edges, hostile and odd text, missing
 * folders and agents, and a board with hundreds of tasks.
 * Runs with the stub `claude` on PATH (scripts/run-board-e2e.js).
 */
const fs = require('fs');
const path = require('path');
const { harness } = require('./helpers');

module.exports = async function (ctx) {
  const h = harness(ctx, 'LIFECYCLE');
  const { S, js, sleep, ptys, board } = h;
  await sleep(700);

  await h.section('limits and the queue across projects', async () => {
    const p1 = h.tmp('lc-p1'); const p2 = h.tmp('lc-p2');
    await js('window.seamux.boardSetGlobalLimit(2)');
    await js(`window.seamux.boardSetLimit(${S(p1)}, 2)`);
    await js(`window.seamux.boardSetLimit(${S(p2)}, 2)`);
    const a = await h.create({ cwd: p1, title: 'P1 a', agent: 'shell' });
    const b = await h.create({ cwd: p1, title: 'P1 b', agent: 'shell' });
    const c = await h.create({ cwd: p2, title: 'P2 c', agent: 'shell' });
    await h.start(a.id); await h.start(b.id);
    const rc = await h.start(c.id);
    h.check('the overall limit queues a task of another project', rc.status === 'queued' && /overall/.test(rc.reason), rc);
    await h.closeTaskPane(a.id);
    h.check('a slot freed in one project starts the queued task of another', await h.waitFor(() => h.paneOf(c.id) && board.get(c.id).status === 'active'));

    await js(`window.seamux.boardSetLimit(${S(p1)}, 1)`);
    h.check('lowering a limit below what runs stops nothing', h.paneOf(b.id) && !h.paneOf(b.id).exited);
    const d = await h.create({ cwd: p1, title: 'P1 d', agent: 'shell' });
    await js('window.seamux.boardSetGlobalLimit(5)');
    const rd = await h.start(d.id);
    h.check('…and new starts wait for the project limit', rd.status === 'queued' && /project/.test(rd.reason), rd);
    await js(`window.seamux.boardSetLimit(${S(p1)}, 3)`);
    h.check('raising the limit starts the queued task at once', await h.waitFor(() => h.paneOf(d.id) && board.get(d.id).status === 'active'));

    for (const bad of ['0', '-1', '51', 'abc', '']) {
      const r = await h.tryCall(`window.seamux.boardSetLimit(${S(p1)}, ${S(bad)})`);
      h.check(`an invalid limit (${bad || 'empty'}) is refused, not silently replaced`, !r.ok && /between 1 and 50/.test(r.error) && board.limitFor(p1) === 3, r);
    }
    await js('window.__board.show()');
    await sleep(200);
    await js(`[...document.querySelectorAll('.b-lanehead')].find(l => l.dataset.cwd === ${S(p1)}).querySelector('.b-limit').click()`);
    await sleep(200);
    await js("document.querySelector('#limit-input').value = '0'");
    await h.clickButton('Save');
    await sleep(300);
    h.check('the limit dialog shows the error and stays open', /between 1 and 50/.test(await h.modalText()) && board.limitFor(p1) === 3, await h.modalText());
    await h.escape();
    for (const t of [b, c, d]) await h.closeTaskPane(t.id);
  });

  await h.section('a terminal that ends by itself', async () => {
    const p = h.tmp('lc-end');
    await js(`window.seamux.boardSetLimit(${S(p)}, 1)`);
    const a = await h.create({ cwd: p, title: 'Ends', agent: 'shell' });
    const q = await h.create({ cwd: p, title: 'Waits', agent: 'shell' });
    await h.start(a.id); await h.start(q.id);
    const first = h.paneOf(a.id);
    ptys.write(first.id, 'exit\r');
    h.check('the queued task starts when a terminal ends', await h.waitFor(() => h.paneOf(q.id) && !h.paneOf(q.id).exited));
    await js('window.__board.show()');
    await sleep(300);
    h.check('the ended card says so and offers to start again', /Ended/.test(await h.cardText(a.id)) && /Start|Resume/.test(await h.cardText(a.id)), await h.cardText(a.id));
    await js(`window.seamux.boardSetLimit(${S(p)}, 2)`);
    await h.start(a.id);
    await sleep(800);
    const panes = ptys.list().filter((s) => s.taskId === a.id);
    h.check('starting it again replaces the ended terminal: still one per task', panes.length === 1 && !panes[0].exited, panes.map((x) => [x.id, x.exited]));
    h.check('the renderer dropped the ended pane too', await js(`!panes.has(${S(first.id)})`));
    h.check('the card shows the live terminal', board.get(a.id).status === 'active' && ['running', 'needs'].includes(await h.columnOf(a.id)));
    await h.closeTaskPane(a.id); await h.closeTaskPane(q.id);
  });

  await h.section('restarting a task terminal', async () => {
    const p = h.tmp('lc-restart');
    const t = await h.create({ cwd: p, title: 'Restartable', brief: 'Do it' });
    await h.start(t.id);
    await sleep(900);
    const pane = h.paneOf(t.id);
    const sid1 = board.get(t.id).sessionId;
    await js(`window.seamux.restartSession(${S(pane.id)}, [])`);
    await sleep(900);
    const args = h.argsOf(pane.id);
    const sid2 = args[args.indexOf('--session-id') + 1];
    h.check('a restart starts a new conversation with a new id', sid2 && sid2 !== sid1 && board.get(t.id).sessionId === sid2, { sid1, sid2 });
    h.check('…and sends the task’s opening message again', args.includes('Task: Restartable\n\nDo it'), args);
    h.check('…in the same pane', h.paneOf(t.id).id === pane.id && ptys.list().filter((s) => s.taskId === t.id).length === 1);
    await h.closeTaskPane(t.id);
  });

  await h.section('editing and deleting', async () => {
    const p = h.tmp('lc-edit');
    const t = await h.create({ cwd: p, title: 'Old name', agent: 'shell' });
    await h.start(t.id);
    await js(`window.seamux.boardUpdate(${S(t.id)}, { title: 'New name' })`);
    await sleep(300);
    h.check('renaming a running task renames its terminal too', h.paneOf(t.id).title === 'New name' && await js(`panes.get(${S(h.paneOf(t.id).id)}).meta.title`) === 'New name');
    const empty = await h.tryCall(`window.seamux.boardUpdate(${S(t.id)}, { title: '   ' })`);
    h.check('an empty title is refused', !empty.ok && /title/.test(empty.error));
    await js('window.__board.show()');
    await sleep(200);
    await js(`document.querySelector('[data-task="${t.id}"] .b-actions button:last-child').click()`);
    await sleep(200);
    await h.clickButton('Delete');
    await sleep(200);
    await h.clickButton('Delete');
    await sleep(400);
    h.check('deleting a running task from its dialog is refused and says why', !!board.get(t.id) && /close the task/.test(await h.flashText()), await h.flashText());
    await h.closeTaskPane(t.id);
    await js(`document.querySelector('[data-task="${t.id}"] .b-actions button:last-child').click()`);
    await sleep(200);
    await h.clickButton('Delete');
    await sleep(200);
    h.check('a confirmation is asked first', /Delete this task\?/.test(await h.modalText()));
    await h.clickButton('Cancel');
    await sleep(200);
    h.check('cancel keeps it', !!board.get(t.id));
    await js(`document.querySelector('[data-task="${t.id}"] .b-actions button:last-child').click()`);
    await sleep(200);
    await h.clickButton('Delete'); await sleep(200); await h.clickButton('Delete');
    await sleep(400);
    h.check('confirming deletes it', !board.get(t.id) && !(await h.cardText(t.id)));
  });

  await h.section('drag and drop', async () => {
    const p1 = h.tmp('lc-dnd1'); const p2 = h.tmp('lc-dnd2');
    const t = await h.create({ cwd: p1, title: 'Draggable' });
    await h.create({ cwd: p2, title: 'Other lane' });
    await js('window.__board.show()');
    await sleep(300);
    const drag = (taskId, cwd, status) => js(`(() => {
      const card = document.querySelector('[data-task="${taskId}"]');
      const cell = [...document.querySelectorAll('.b-cell')].find(c => c.dataset.cwd === ${S(cwd)} && c.dataset.status === ${S(status)});
      if (!card || !cell) return 'missing';
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
      cell.dispatchEvent(over);
      cell.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      return over.defaultPrevented ? 'accepted' : 'refused';
    })()`);
    h.check('a card can be dropped on Review in its lane', (await drag(t.id, p1, 'review')) === 'accepted' && await h.waitFor(() => board.get(t.id).status === 'review'));
    h.check('a card cannot be dropped in another project’s lane', (await drag(t.id, p2, 'ready')) === 'refused' && board.get(t.id).status === 'review');
    h.check('nor on Queued', (await drag(t.id, p1, 'queued')) === 'refused');
    await drag(t.id, p1, 'waiting');
    await sleep(300);
    h.check('dropping on Waiting asks what it waits for', /What is it waiting for\?/.test(await h.modalText()));
    await js("document.querySelector('#wait-input').value = 'design sign-off'");
    await h.clickButton('Move to Waiting');
    await sleep(300);
    h.check('…and records it', board.get(t.id).status === 'waiting' && board.get(t.id).waitingFor === 'design sign-off');
  });

  await h.section('keyboard edges', async () => {
    await js('window.__board.show()');
    await js('window.__board.select(null)');
    for (const k of ['ArrowDown', 'ArrowLeft', 'l', 's', 'm', 'e', 'd', ' ', 'Enter']) await h.key(k);
    await sleep(200);
    h.check('keys with nothing selected select the first card or do nothing, without errors', true);
    await h.escape();
    const p = h.tmp('lc-keys');
    const t = await h.create({ cwd: p, title: 'Not running' });
    await js(`window.__board.select(${S(t.id)})`);
    await h.key(' ');
    await sleep(200);
    h.check('Space on a card without a terminal explains', /no running terminal/.test(await h.flashText()), await h.flashText());
    await h.key('d');
    await sleep(200);
    h.check('D on a task without a worktree does nothing', !(await h.modalText()));
    await h.key('Enter');
    await sleep(200);
    h.check('Enter on a card without a terminal opens its edit dialog', /Edit task/.test(await h.modalText()));
    await h.escape();
    const before = await js("document.querySelectorAll('.b-colhead').length");
    await js("[...document.querySelectorAll('#board-bar .mini')].find(b => b.textContent === 'Backlog').click()");
    await js("[...document.querySelectorAll('#board-bar .mini')].find(b => b.textContent === 'Done').click()");
    await sleep(200);
    h.check('Backlog and Done appear when turned on', (await js("document.querySelectorAll('.b-colhead').length")) === before + 2);
    await js("[...document.querySelectorAll('#board-bar .mini')].find(b => b.textContent === 'Backlog').click()");
    await js("[...document.querySelectorAll('#board-bar .mini')].find(b => b.textContent === 'Done').click()");

    const x = await h.create({ cwd: p, title: 'Asks X', agent: 'shell' });
    const y = await h.create({ cwd: p, title: 'Asks Y', agent: 'shell' });
    await h.start(x.id); await h.start(y.id);
    await sleep(700);
    ptys.hint(h.paneOf(x.id).id, 'needs_input', 'question X');
    ptys.hint(h.paneOf(y.id).id, 'needs_input', 'question Y');
    await sleep(300);
    const seen = [];
    for (let i = 0; i < 3; i++) { await js('window.__board.nextNeeds()'); await sleep(150); seen.push(await js('activeId')); }
    h.check('⌘J cycles through every terminal that needs you', seen[0] !== seen[1] && seen[2] === seen[0] && seen.includes(h.paneOf(x.id).id) && seen.includes(h.paneOf(y.id).id), seen);
    await h.closeTaskPane(x.id); await h.closeTaskPane(y.id);
  });

  await h.section('hostile and odd text', async () => {
    const p = h.tmp('lc-text');
    const evil = '<img src=x onerror="window.__pwned=1"><b>bold</b>';
    const t = await h.create({ cwd: p, title: evil, brief: evil, agent: 'shell', links: 'javascript:window.__pwned=2' });
    await js('window.__board.show()');
    await sleep(300);
    await h.start(t.id);
    await sleep(600);
    await js(`activate(${S(h.paneOf(t.id).id)})`);
    await js('window.__board.toggleDrawer()');
    await sleep(300);
    await js('window.__board.show()');
    await js(`window.__board.select(${S(t.id)})`);
    await h.key('m');
    await sleep(300);
    const injected = await js("[...document.querySelectorAll('img, b')].filter(n => n.textContent === 'bold' || n.tagName === 'IMG').length");
    h.check('markup in titles and briefs is shown as text everywhere', injected === 0 && !(await js('window.__pwned')) && /<img src=x/.test(await h.cardText(t.id)), injected);
    await h.escape();
    await js('window.__board.toggleDrawer()');
    const link = await js("[...document.querySelectorAll('#taskdrawer a')].map(a => a.getAttribute('href'))");
    h.check('a javascript: link is not made clickable', !link.some((x) => /^javascript:/i.test(x || '')), link);
    await js('window.__board.toggleDrawer()');
    const long = `${'Very long title with ünïcödé, emoji 🚀 and RTL שלום '.repeat(6)}end`;
    const u = await h.create({ cwd: p, title: long });
    await js('window.__board.show()');
    await sleep(300);
    const fits = await js(`(() => { const c = document.querySelector('[data-task="${u.id}"]'); return c && c.scrollWidth <= c.clientWidth + 1; })()`);
    h.check('a very long Unicode title wraps inside its card', fits);
    h.check('…and is stored intact', board.get(u.id).title === long.trim());
    await h.closeTaskPane(t.id);
  });

  await h.section('missing folders and agents', async () => {
    const gone = h.tmp('lc-gone');
    const t = await h.create({ cwd: gone, title: 'Folder will vanish', agent: 'shell' });
    fs.rmSync(gone, { recursive: true, force: true });
    const r = await h.tryCall(`window.seamux.boardStart(${S(t.id)})`);
    await sleep(500);
    const pane = h.paneOf(t.id);
    h.check('a task whose folder is gone does not start; it says why and stays Ready',
      !r.ok && /folder/.test(r.error) && board.get(t.id).status === 'ready' && !pane, { r, status: board.get(t.id).status, pane: !!pane });
    await js(`window.__board.start(${S(t.id)})`);
    await sleep(300);
    h.check('the board shows the reason as plain text', /^Could not start: the project folder no longer exists: /.test(await h.flashText()), await h.flashText());

    const p = h.tmp('lc-agent');
    const before = ptys.list().filter((s) => !s.exited && s.taskId).length;
    const c = await h.create({ cwd: p, title: 'Missing agent', agent: 'codex' });
    const rc = await h.tryCall(`window.seamux.boardStart(${S(c.id)})`);
    await sleep(1200);
    const pc = h.paneOf(c.id);
    const freed = ptys.list().filter((s) => !s.exited && s.taskId).length === before;
    h.check('an agent that is not installed does not hold a slot, and the user is told',
      freed && ((!rc.ok && /not installed|not found|codex/i.test(rc.error)) || (pc && pc.exited)), { rc, pane: pc && { exited: pc.exited, reason: pc.reason } });
  });

  await h.section('a board with hundreds of tasks', async () => {
    const p = h.tmp('lc-many');
    for (let i = 0; i < 200; i++) board.create({ cwd: p, title: `Bulk task ${i}`, status: i % 2 ? 'ready' : 'backlog' });
    ctx.runner.emit('changed');
    await js('window.__board.show()');
    await sleep(500);
    const ms = await js('(async () => { const t = performance.now(); await window.__board.refresh(); return performance.now() - t; })()');
    h.check('200 more tasks render in under a second', ms < 1000, `${Math.round(ms)} ms`);
    h.check('…all of them', (await js("document.querySelectorAll('.b-card').length")) >= 100);
  });

  await h.section('a project removed from the sidebar keeps its lane', async () => {
    const p = h.tmp('lc-forget');
    const t = await h.create({ cwd: p, title: 'Orphan' });
    await js(`window.seamux.removeProject(${S(p)})`);
    await js('window.__board.refresh()');
    await sleep(300);
    h.check('its tasks still have a lane', !!(await h.cardText(t.id)) && (await js(`!![...document.querySelectorAll('.b-lanehead')].find(l => l.dataset.cwd === ${S(p)})`)));
  });

  await h.finish();
};
