'use strict';
/**
 * Campaign 5: time per task and focus mode, in the real window.
 * Time ticks every 300 ms here (SEAMUX_TIME_TICK_MS), and terminal states are
 * set the way Claude's hooks set them. Stub `claude` on PATH.
 */
const { harness } = require('./helpers');

module.exports = async function (ctx) {
  const h = harness(ctx, 'TIME AND FOCUS');
  const { S, js, sleep, ptys, board, win } = h;
  const { focus, view } = ctx;
  await sleep(700);
  // The window may run in the background here; "your time" needs it focused.
  let focused = true;
  win.isFocused = () => focused;
  const time = (id) => (board.get(id).time || {});
  const grows = async (id, bucket, ms = 1500) => {
    const before = time(id)[bucket] || 0;
    await sleep(ms);
    return (time(id)[bucket] || 0) - before;
  };
  const sidebarShown = () => js("getComputedStyle(document.querySelector('#sidebar')).display !== 'none'");
  const activeId = () => js('activeId');

  const p = h.tmp('tf-proj');
  await js(`window.seamux.boardSetLimit(${S(p)}, 3)`);

  await h.section('time per task', async () => {
    const t = await h.create({ cwd: p, title: 'Timed', agent: 'shell' });
    await h.start(t.id);
    await sleep(600);
    const pane = h.paneOf(t.id);
    await js(`activate(${S(pane.id)})`);
    await sleep(300);

    ptys.hint(pane.id, 'running', 'working');
    const agent = await grows(t.id, 'agent');
    h.check('while its agent works, agent time grows', agent >= 900, agent);
    h.check('…and with its terminal in front of you, your time too', (await grows(t.id, 'you', 900)) >= 500);

    ptys.hint(pane.id, 'needs_input', 'A question');
    await sleep(400);
    const blocked = await grows(t.id, 'needsYou');
    const agentMeanwhile = await grows(t.id, 'agent', 0);
    h.check('while it asks you something, time blocked on you grows', blocked >= 900, blocked);
    h.check('…and agent time stops', agentMeanwhile === 0);

    focused = false;
    await sleep(400);
    h.check('with the window in the background, your time stops', (await grows(t.id, 'you')) === 0);
    focused = true;

    await js('window.__board.show()');
    await sleep(400);
    h.check('the board on screen: the reported view says so', view.boardVisible === true);
    h.check('with the board in front, nobody is on the task', (await grows(t.id, 'you')) === 0);
    await js(`window.__board.peek(${S(t.id)})`);
    await sleep(400);
    h.check('peeking at it from the board counts as your time', view.peekPaneId === pane.id && (await grows(t.id, 'you')) >= 900);
    await js('window.__board.closePeek()');
    await js('window.__board.hide()');

    const w = await h.create({ cwd: p, title: 'Waits on legal', agent: 'shell' });
    await js(`window.seamux.boardWait(${S(w.id)}, 'legal')`);
    await sleep(400);
    h.check('a task in Waiting on others counts waiting time without a terminal', (await grows(w.id, 'waiting')) >= 900);
    const r = await h.create({ cwd: p, title: 'Idle in Ready', agent: 'shell' });
    await sleep(1000);
    h.check('a task nobody touches counts nothing', !board.get(r.id).time);

    // Long totals, as after a day of work, to check what the board shows.
    board.addTime(t.id, 'agent', 2 * 3600e3);
    board.addTime(t.id, 'needsYou', 3 * 3600e3);
    await js('window.__board.show()');
    await js('window.__board.refresh()');
    await sleep(300);
    const chip = await js(`(() => { const n = document.querySelector('[data-task="${t.id}"] .b-time'); return n ? { text: n.textContent, title: n.title, warn: n.classList.contains('warn') } : null; })()`);
    h.check('the card shows time worked', chip && /^⏱ 2h/.test(chip.text), chip);
    h.check('…the split on hover', chip && /Agent working: 2h/.test(chip.title) && /Blocked on you: 3h/.test(chip.title));
    h.check('…and marks a task mostly blocked on you', chip && chip.warn);
    h.check('a task with under a minute shows no time chip', !(await js(`!!document.querySelector('[data-task="${r.id}"] .b-time')`)));
    await js('window.__board.hide()');
    await js(`activate(${S(pane.id)})`);
    await js('window.__board.toggleDrawer()');
    await sleep(300);
    const drawer = await js("document.querySelector('#taskdrawer').innerText");
    h.check('the task panel prints nothing for sections a task does not have', !/\bnull\b/.test(drawer), drawer);
    h.check('the task panel lists each kind of time', /Agent working\s*2h/.test(drawer) && /Blocked on you\s*3h/.test(drawer), drawer);
    await js('window.__board.toggleDrawer()');
    await h.closeTaskPane(t.id);
  });

  await h.section('focus: starting it', async () => {
    const none = await js('window.__focus.dialog(null) || 1');
    await sleep(200);
    h.check('with no task picked, focus asks you to pick one', none && /Pick a task to focus on/.test(await h.toastText()));

    const t = await h.create({ cwd: p, title: 'Deep work', agent: 'shell' });
    await js('window.__board.show()');
    await sleep(300);
    await js(`window.__board.select(${S(t.id)})`);
    await h.key('f');
    await sleep(300);
    h.check('F on a card without a terminal offers to start it first', /Starts its terminal/.test(await h.modalText()));
    for (const bad of ['0', '241', 'abc', '2.5']) {
      await js(`document.querySelector('#focus-minutes').value = ${S(bad)}`);
      await h.clickButton('Start focus');
      await sleep(300);
      const err = await js("document.querySelector('#focus-error').hidden ? '' : document.querySelector('#focus-error').textContent");
      if (!/between 1 and 240/.test(err) || focus.current) { h.check(`a focus length of “${bad}” is refused`, false, err); break; }
    }
    h.check('lengths outside 1–240 whole minutes are refused, and nothing starts', !focus.current);
    await js("document.querySelector('#focus-minutes').value = '25'");
    await h.clickButton('Start focus');
    await sleep(900);
    const pane = h.paneOf(t.id);
    h.check('starting focus starts the task’s terminal and focuses it', !!pane && focus.current && focus.current.paneId === pane.id);
    h.check('the board steps aside and the terminal is in front', !(await js('window.__board.visible')) && (await activeId()) === pane.id);
    h.check('the sidebar is hidden', !(await sidebarShown()));
    const bar = await js("document.querySelector('#focusbar').innerText");
    h.check('the focus bar shows the task and a countdown', /Deep work/.test(bar) && /2[45]:\d\d/.test(bar), bar);
  });

  await h.section('focus: keeping you on the task', async () => {
    const cur = focus.current;
    const other = await h.create({ cwd: p, title: 'Other task', agent: 'shell' });
    await h.start(other.id);
    await sleep(700);
    const op = h.paneOf(other.id);
    h.check('a task started during focus does not take the window', (await activeId()) === cur.paneId);
    ptys.hint(op.id, 'needs_input', 'Pick one');
    await sleep(400);
    h.check('another task needing you is held, not announced', focus.current.held.includes(op.id));
    const bar = await js("document.querySelector('#focusbar').innerText");
    h.check('…and only counted in the focus bar', /1 other needs you/.test(bar) && !/Other task/.test(bar), bar);
    await js(`activate(${S(op.id)})`);
    await sleep(200);
    h.check('switching to another terminal is refused, with how to end focus', (await activeId()) === cur.paneId && /End focus \(⌘⇧F\) to switch/.test(await h.toastText()));
    await js('window.__board.show()');
    h.check('the board stays closed', !(await js('window.__board.visible')));
    await js('window.__board.nextNeeds()');
    h.check('⌘J stays on the task', (await activeId()) === cur.paneId);
    ptys.hint(op.id, 'running', 'answered elsewhere');
    await sleep(300);
    h.check('a held task that stops needing you is released', !focus.current.held.includes(op.id));
    ptys.hint(op.id, 'needs_input', 'Again');
    await sleep(300);
    const before = focus.current.endsAt;
    await js("[...document.querySelectorAll('#focusbar button')].find((b) => b.textContent === '+5 min').click()");
    await sleep(300);
    h.check('+5 min moves the end by five minutes', focus.current.endsAt - before === 5 * 60000, focus.current.endsAt - before);

    // The session runs out (shortened here rather than waiting 30 minutes).
    focus.session.endsAt = Date.now() + 400;
    focus._arm();
    await sleep(900);
    h.check('when time is up, focus ends', !focus.current && !(await js("document.body.classList.contains('focus-mode')")));
    const toast = await h.toastText();
    h.check('…says so, with how many others need you', /^Focus done: .*Deep work/.test(toast) && /1 other task needs you \(⌘J\)/.test(toast), toast);
    h.check('…the sidebar comes back', await sidebarShown());
    const f = board.get(cur.taskId).focus;
    h.check('…and the session is recorded on the task as completed', f && f.sessions === 1 && f.completed === 1 && f.ms > 0, f);
    await js('window.__board.nextNeeds()');
    await sleep(200);
    h.check('after focus, ⌘J goes to the held task', (await activeId()) === op.id);
    await h.closeTaskPane(other.id);
  });

  await h.section('focus: ending it every other way', async () => {
    const t = board.list().find((x) => x.title === 'Deep work');
    await js(`window.__focus.begin(${S(t.id)}, 50)`);
    await sleep(300);
    win.webContents.send('ui:focus');   // ⌘⇧F
    await sleep(400);
    h.check('⌘⇧F during focus ends it early', !focus.current && /^Focus ended after/.test(await h.toastText()));
    const f = board.get(t.id).focus;
    h.check('…recorded as a session, not completed', f.sessions === 2 && f.completed === 1);

    await js(`activate(${S(h.paneOf(t.id).id)})`);
    win.webContents.send('ui:focus');
    await sleep(300);
    h.check('⌘⇧F with a task’s terminal in front offers focus on that task', /Focus on “Deep work”/.test(await h.modalText()));
    await h.clickButton('Start focus');
    await sleep(400);
    h.check('…and starts it with the last length used', focus.current && focus.current.minutes === 50);
    ptys.write(focus.current.paneId, 'exit\r');
    await h.waitFor(() => !focus.current, 4000);
    h.check('the focused terminal ending ends focus, and says why', !focus.current && /terminal of “Deep work” closed/.test(await h.toastText()));
    await h.closeTaskPane(t.id);

    const d = await h.create({ cwd: p, title: 'Doomed', agent: 'shell' });
    await js(`window.__focus.begin(${S(d.id)}, 25)`);
    await sleep(500);
    const del = await h.tryCall(`window.seamux.boardRemove(${S(d.id)})`);
    h.check('the focused task cannot be deleted while its terminal runs; focus goes on', !del.ok && focus.current && focus.current.taskId === d.id, del);
    await h.closeTaskPane(d.id);
    h.check('closing its terminal ends focus', !focus.current && /terminal of “Doomed” closed/.test(await h.toastText()));
    await js(`window.seamux.boardRemove(${S(d.id)})`);
    h.check('…and then it can be deleted', !board.get(d.id));
  });

  await h.section('focus: tasks that cannot get it', async () => {
    const q = h.tmp('tf-full');
    await js(`window.seamux.boardSetLimit(${S(q)}, 1)`);
    const a = await h.create({ cwd: q, title: 'Holds the slot', agent: 'shell' });
    await h.start(a.id);
    await sleep(500);
    const b = await h.create({ cwd: q, title: 'Would queue', agent: 'shell' });
    await js('window.__board.show()');
    await js(`window.__focus.dialog(${S(b.id)})`);
    await sleep(200);
    await h.clickButton('Start focus');
    await sleep(500);
    const err = await js("document.querySelector('#focus-error').textContent");
    h.check('a task that would only queue cannot get focus, and says why', !focus.current && /it is queued/.test(err), err);
    await h.escape();
    await js(`window.seamux.boardMove(${S(b.id)}, 'ready')`);

    const c = await h.create({ cwd: q, title: 'Waits for A', agent: 'shell', dependsOn: [a.id] });
    await js(`window.__focus.dialog(${S(c.id)})`);
    await sleep(200);
    h.check('a task waiting on another cannot get focus', !(await h.modalText()) && /waits for Holds the slot/.test(await h.toastText()));
    await h.closeTaskPane(a.id);
  });

  await h.finish();
};
