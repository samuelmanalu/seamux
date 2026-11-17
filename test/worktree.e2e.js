'use strict';
/**
 * Worktrees end to end on a real throwaway git repository: a task runs in
 * its own worktree, its changes show as +/- counts and a diff, resume keeps
 * its folder, the task panel shows it, and removing a worktree keeps the
 * branch and refuses while work is uncommitted. Stub `claude` on PATH.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let fails = 0; const out = [];
const check = (n, c, d) => { out.push((c ? 'PASS  ' : 'FAIL  ') + n + (c || !d ? '' : `  (${d})`)); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function ({ win, ptys, app, board }) {
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const S = JSON.stringify;
  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) consoleErrors.push(message); });
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-wt-e2e-')));
  const repo = path.join(tmp, 'shop');
  const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
  fs.mkdirSync(repo);
  g(tmp, 'init', '-q', '-b', 'main', repo);
  g(repo, 'config', 'user.email', 't@example.com');
  g(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'README.md'), 'shop\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'init');
  const paneOf = (id) => ptys.list().find((s) => s.taskId === id);
  const stop = async (paneId) => {
    ptys.emit('status', { ...ptys.list().find((x) => x.id === paneId), state: 'running' });
    ptys.emit('status', { ...ptys.list().find((x) => x.id === paneId), state: 'idle' });
    await sleep(800);
  };

  try {
    await sleep(700);
    await js(`window.seamux.boardSetLimit(${S(repo)}, 2)`);
    const a = await js(`window.seamux.boardCreate({ cwd: ${S(repo)}, title: 'Add greeting', status: 'ready' })`);
    await js(`window.__board.start(${S(a.id)})`);
    await sleep(1500);
    let t = board.get(a.id);
    const pA = paneOf(a.id);
    check('with a limit above 1 a task gets its own worktree', !!t.worktree && t.worktree.branch.startsWith('seamux/add-greeting-'), S(t.worktree));
    check('its terminal runs in the worktree, not the project folder', pA && ptys.sessions.get(pA.id).cwd === t.worktree.runCwd && t.worktree.runCwd !== repo);
    check('the pane still belongs to the project', pA && pA.projectCwd === repo);
    check('the main checkout stays on its branch', g(repo, 'branch', '--show-current') === 'main');

    ptys.write(pA.id, 'echo hello > greeting.txt\r');
    await sleep(800);
    await stop(pA.id);
    t = board.get(a.id);
    check('when the agent stops, the card gets +/- counts', t.diffStat && t.diffStat.files === 1 && t.diffStat.added === 1, S(t.diffStat));
    await js('window.__board.show()');
    await sleep(300);
    check('the card shows them', /\+1 −0/.test(await js(`document.querySelector('[data-task="${a.id}"]').innerText`)));
    await js(`window.__board.diffDialog(${S(a.id)})`);
    await sleep(600);
    const dt = await js("document.querySelector('#modal-root').innerText");
    check('the diff shows the new file and its line', /greeting\.txt/.test(dt) && /\+hello/.test(dt) && /seamux\/add-greeting-/.test(dt), dt.slice(0, 300));
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");

    /* task panel */
    await js(`window.seamux.boardUpdate(${S(a.id)}, { links: 'https://example.com/mr/1' })`);
    await js(`activate(${S(pA.id)})`);
    await sleep(200);
    check('a task terminal shows the Task button', !(await js("document.querySelector('#session-task').hidden")));
    await js('window.__board.toggleDrawer()');
    await sleep(300);
    const drawer = await js("document.querySelector('#taskdrawer').innerText");
    check('the task panel shows branch, changes and links', !(await js("document.querySelector('#taskdrawer').hidden"))
      && /seamux\/add-greeting-/.test(drawer) && /\+1/.test(drawer) && /example\.com\/mr\/1/.test(drawer), drawer);
    check('the terminal makes room for it', await js("document.querySelector('#main').classList.contains('drawer-open')"));
    await js('window.__board.toggleDrawer()');

    /* isolation choices */
    const b = await js(`window.seamux.boardCreate({ cwd: ${S(repo)}, title: 'In place', status: 'ready', isolation: 'main' })`);
    await js(`window.__board.start(${S(b.id)})`);
    await sleep(1200);
    check('a task set to the project folder runs there', paneOf(b.id) && ptys.sessions.get(paneOf(b.id).id).cwd === repo && !board.get(b.id).worktree);
    let refused = false;
    try { await js(`window.seamux.boardUpdate(${S(b.id)}, { isolation: 'worktree' })`); } catch { refused = true; }
    check('where a started task runs cannot change', refused);
    await js(`closeSession(${S(paneOf(b.id).id)})`);
    await sleep(500);

    /* resume keeps the folder */
    const sid = board.get(a.id).sessionId;
    await js(`closeSession(${S(pA.id)})`);
    await sleep(600);
    await js(`window.__board.start(${S(a.id)})`);
    await sleep(1200);
    const pA2 = paneOf(a.id);
    const args = ptys.sessions.get(pA2.id).args;
    check('resume runs in the same worktree', ptys.sessions.get(pA2.id).cwd === board.get(a.id).worktree.runCwd && args[args.indexOf('--resume') + 1] === sid, S(args));

    /* removing the worktree */
    let err = '';
    try { await js(`window.seamux.boardRemoveWorktree(${S(a.id)})`); } catch (e) { err = String(e.message || e); }
    check('removing is refused while its terminal runs', /close the task/.test(err), err);
    await js(`closeSession(${S(pA2.id)})`);
    await sleep(600);
    err = '';
    try { await js(`window.seamux.boardRemoveWorktree(${S(a.id)})`); } catch (e) { err = String(e.message || e); }
    check('removing is refused while work is uncommitted', /not committed/.test(err) && fs.existsSync(board.get(a.id).worktree.path), err);
    const wtPath = board.get(a.id).worktree.path;
    g(wtPath, 'add', '-A'); g(wtPath, 'commit', '-q', '-m', 'greeting');
    await js(`window.seamux.boardRemoveWorktree(${S(a.id)})`);
    t = board.get(a.id);
    check('a clean worktree is removed', !fs.existsSync(wtPath) && t.worktree.removed === true);
    check('its branch and commit are kept', g(repo, 'log', '--oneline', '-1', t.worktree.branch).includes('greeting'));
    await js('window.__board.show()');
    await sleep(300);
    check('the Diff button goes away', !/Diff/.test(await js(`document.querySelector('[data-task="${a.id}"] .b-actions').innerText`)));
    await js(`window.__board.start(${S(a.id)})`);
    await sleep(1200);
    const pA3 = paneOf(a.id);
    check('starting it again checks the branch out at the same folder', pA3 && fs.existsSync(wtPath) && ptys.sessions.get(pA3.id).cwd === wtPath
      && g(wtPath, 'log', '--oneline', '-1').includes('greeting'));

    /* limit 1: no worktree */
    await js(`window.seamux.boardSetLimit(${S(repo)}, 1)`);
    const c = await js(`window.seamux.boardCreate({ cwd: ${S(repo)}, title: 'Solo', status: 'ready' })`);
    await js(`closeSession(${S(pA3.id)})`);
    await sleep(500);
    await js(`window.__board.start(${S(c.id)})`);
    await sleep(1200);
    check('with a limit of 1, automatic means the project folder', paneOf(c.id) && ptys.sessions.get(paneOf(c.id).id).cwd === repo && !board.get(c.id).worktree);

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  } catch (e) {
    check('suite ran without throwing', false, e.stack || e.message);
  } finally {
    console.log(out.join('\n'));
    console.log(fails ? `${fails} of ${out.length} FAILED` : `ALL ${out.length} PASSED`);
    try { g(repo, 'worktree', 'prune'); } catch { /* fine */ }
    fs.rmSync(tmp, { recursive: true, force: true });
    app.exit(fails ? 1 : 0);
  }
};
