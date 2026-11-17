'use strict';
/**
 * Campaign 3: worktrees, the planner and Claude hooks, edges included.
 * Projects outside git and without commits, a worktree folder deleted by
 * hand, two tasks in parallel in one repository, awkward files in a diff;
 * reopening the planner, two planners, seamux errors and odd titles; hooks
 * for ended terminals, plain sessions and unknown terminals.
 * Stub `claude` on PATH.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { harness } = require('./helpers');

module.exports = async function (ctx) {
  const h = harness(ctx, 'WORKTREES, PLANNER, HOOKS');
  const { S, js, sleep, ptys, board, app } = h;
  await sleep(700);

  await h.section('worktrees: where they cannot be made', async () => {
    const plain = h.tmp('wph-nogit');
    const t = await h.create({ cwd: plain, title: 'Needs git', isolation: 'worktree', agent: 'shell' });
    const r = await h.tryCall(`window.seamux.boardStart(${S(t.id)})`);
    h.check('own worktree outside git: refused with the reason, task stays Ready', !r.ok && /not a git repository/.test(r.error) && board.get(t.id).status === 'ready' && !h.paneOf(t.id), r);
    const auto = await h.create({ cwd: plain, title: 'Auto outside git', agent: 'shell' });
    await js(`window.seamux.boardSetLimit(${S(plain)}, 3)`);
    await h.start(auto.id);
    await sleep(500);
    h.check('automatic outside git: runs in the project folder', ptys.sessions.get(h.paneOf(auto.id).id).cwd === plain && !board.get(auto.id).worktree);
    await h.closeTaskPane(auto.id);

    const { repo } = h.gitRepo('wph-empty', { commit: false });
    await js(`window.seamux.boardSetLimit(${S(repo)}, 3)`);
    const e1 = await h.create({ cwd: repo, title: 'Auto in empty repo', agent: 'shell' });
    await h.start(e1.id);
    await sleep(500);
    h.check('automatic in a repo with no commits: the project folder', ptys.sessions.get(h.paneOf(e1.id).id).cwd === repo && !board.get(e1.id).worktree);
    await h.closeTaskPane(e1.id);
    const e2 = await h.create({ cwd: repo, title: 'Forced in empty repo', isolation: 'worktree', agent: 'shell' });
    const r2 = await h.tryCall(`window.seamux.boardStart(${S(e2.id)})`);
    h.check('own worktree in a repo with no commits: refused, says why', !r2.ok && /no commits yet/.test(r2.error), r2);
  });

  await h.section('worktrees: deleted by hand, parallel, awkward diffs', async () => {
    const { repo, g } = h.gitRepo('wph-repo');
    await js(`window.seamux.boardSetLimit(${S(repo)}, 3)`);
    const a = await h.create({ cwd: repo, title: 'Task A' });
    const b = await h.create({ cwd: repo, title: 'Task B', agent: 'shell' });
    await h.start(a.id); await h.start(b.id);
    await sleep(1200);
    const wa = board.get(a.id).worktree; const wb = board.get(b.id).worktree;
    h.check('two tasks in one repo get separate worktrees and branches', wa && wb && wa.path !== wb.path && wa.branch !== wb.branch);
    fs.writeFileSync(path.join(wa.path, 'only-a.txt'), 'a\n');
    fs.writeFileSync(path.join(wb.path, 'only-b.txt'), 'b\nb\n');
    const da = await js(`window.seamux.boardDiff(${S(a.id)})`);
    const db = await js(`window.seamux.boardDiff(${S(b.id)})`);
    h.check('their changes stay apart', /only-a\.txt/.test(da.text) && !/only-b/.test(da.text) && /only-b\.txt/.test(db.text) && !/only-a/.test(db.text));
    h.check('the main checkout sees neither', !fs.existsSync(path.join(repo, 'only-a.txt')) && !fs.existsSync(path.join(repo, 'only-b.txt')));

    fs.writeFileSync(path.join(wa.path, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]));
    fs.writeFileSync(path.join(wa.path, 'name with spaces.txt'), 'spaced\n');
    fs.rmSync(path.join(wa.path, 'README.md'));
    fs.writeFileSync(path.join(wa.path, 'big.txt'), 'x'.repeat(300 * 1024));
    const d = await js(`window.seamux.boardDiff(${S(a.id)})`);
    h.check('a diff shows a deleted file', /deleted file|--- a\/README\.md/.test(d.text));
    h.check('…a binary file without dumping it', /logo\.png[\s\S]*Binary file/.test(d.text));
    h.check('…a file with spaces in its name', /name with spaces\.txt/.test(d.text));
    h.check('…and a large new file without its contents', /too large to show/.test(d.text) && d.text.length < 200 * 1024);
    await js(`window.__board.diffDialog(${S(a.id)})`);
    await sleep(500);
    h.check('the diff dialog lists every file', (await js("document.querySelectorAll('.d-file').length")) >= 5);
    await h.escape();

    // Deleted by hand while the task is not running.
    const sid = board.get(a.id).sessionId;
    await h.closeTaskPane(a.id);
    fs.rmSync(wa.path, { recursive: true, force: true });
    const r = await h.tryCall(`window.seamux.boardStart(${S(a.id)})`);
    await sleep(900);
    const pane = h.paneOf(a.id);
    h.check('a worktree folder deleted by hand is checked out again at the same path', r.ok && fs.existsSync(wa.path) && pane && ptys.sessions.get(pane.id).cwd === wa.runCwd, r);
    const args = pane ? h.argsOf(pane.id) : [];
    h.check('…and the conversation resumes there', args[args.indexOf('--resume') + 1] === sid);
    h.check('the main checkout is still on its branch', g('branch', '--show-current') === 'main');
    await h.closeTaskPane(a.id); await h.closeTaskPane(b.id);

    await js(`window.seamux.boardRemoveWorktree(${S(b.id)})`).catch(() => {});
    const removed = await h.tryCall(`window.seamux.boardRemoveWorktree(${S(b.id)})`);
    h.check('removing a worktree with uncommitted work is refused', !removed.ok && /not committed/.test(removed.error), removed);
  });

  await h.section('the planner', async () => {
    const p1 = h.tmp('wph-plan1'); const p2 = h.tmp('wph-plan2');
    await h.create({ cwd: p1, title: 'Seed one' });
    await h.create({ cwd: p2, title: 'Seed two' });
    await js(`window.__board.openPlanner(${S(p1)})`);
    await sleep(1000);
    const first = ptys.list().find((s) => s.planner && s.projectCwd === p1);
    await js(`closeSession(${S(first.id)})`);
    await sleep(300);
    h.check('closing the planner gives the board its full width back', !(await js("document.querySelector('#main').classList.contains('planner-open')")) && !(await js('window.__board.plannerId')));
    await js(`window.__board.openPlanner(${S(p1)})`);
    await sleep(1000);
    const second = ptys.list().find((s) => s.planner && s.projectCwd === p1 && !s.exited);
    h.check('a closed planner can be opened again', second && second.id !== first.id);
    await js(`window.__board.openPlanner(${S(p2)})`);
    await sleep(1000);
    h.check('two projects can each have a planner', ptys.list().filter((s) => s.planner && !s.exited).length === 2);

    const pl = second.id;
    const replay = () => ptys.replay(pl);
    ptys.write(pl, 'seamux task add "Ünïcode — \\"quoted\\" title 🚀" --brief "it\'s fine"\r');
    const odd = await h.waitFor(() => board.list().find((t) => t.cwd === p1 && t.title.startsWith('Ünïcode')));
    h.check('a title with Unicode and quotes arrives intact', odd && odd.title === 'Ünïcode — "quoted" title 🚀' && odd.brief === "it's fine", odd);
    ptys.write(pl, 'seamux task add "Waits on a ghost" --after t_nonexistent\r');
    h.check('--after an unknown task is refused and nothing is added', await h.waitFor(() => /seamux: no such task: t_nonexistent/.test(replay())) && !board.list().some((t) => t.title === 'Waits on a ghost'));
    const other = board.list().find((t) => t.cwd === p2);
    ptys.write(pl, `seamux task add "Cross project" --after ${other.id}\r`);
    h.check('--after a task of another project is refused', await h.waitFor(() => /only depend on tasks of its own project/.test(replay())));
    ptys.write(pl, 'seamux task add\r');
    h.check('no title: a clear error', await h.waitFor(() => /give the task a title/.test(replay())));
    ptys.write(pl, 'seamux frobnicate\r');
    h.check('an unknown command shows the help', await h.waitFor(() => /unknown command: frobnicate/.test(replay())));

    const t = await h.create({ cwd: p1, title: 'A worker', agent: 'shell' });
    await h.start(t.id);
    await sleep(600);
    ptys.write(h.paneOf(t.id).id, 'seamux task add "Follow-up from a task terminal"\r');
    h.check('seamux also works in a task’s own terminal', await h.waitFor(() => board.list().some((x) => x.title === 'Follow-up from a task terminal' && x.cwd === p1)));
    await h.closeTaskPane(t.id);
  });

  await h.section('hooks: unusual senders', async () => {
    const p = h.tmp('wph-hooks');
    const launcher = path.join(app.getPath('userData'), 'bin', 'seamux');
    const fire = (env, event, payload) => new Promise((resolve) => {
      const c = execFile(launcher, ['hook', event], { env: { ...process.env, ...env } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
      c.stdin.end(JSON.stringify(payload));
    });

    const meta = await js(`window.seamux.createSession({ cwd: ${S(p)}, title: 'plain claude' })`);
    await sleep(800);
    const plain = ptys.sessions.get(meta.id);
    const before = board.list().length;
    await fire({ ...plain.extraEnv, SEAMUX_SESSION_ID: meta.id }, 'notification', { session_id: plain.agentSessionId, message: 'Plain session asks' });
    const st = await h.waitFor(() => { const x = ptys.list().find((s) => s.id === meta.id); return x.state === 'needs_input' ? x : null; });
    h.check('a hook from a plain session updates its status and touches no task', !!st && st.reason === 'Plain session asks' && board.list().length === before);
    await fire({ ...plain.extraEnv, SEAMUX_SESSION_ID: meta.id }, 'stop', { session_id: plain.agentSessionId, last_assistant_message: 'done' });
    await sleep(400);
    h.check('a stop from a plain session sets no next step anywhere', !board.list().some((t) => t.nextStep === 'done'));

    const r1 = await fire({ ...plain.extraEnv, SEAMUX_SESSION_ID: 's99999' }, 'stop', { session_id: 'x' });
    const r2 = await fire({ ...plain.extraEnv, SEAMUX_SESSION_ID: meta.id }, 'teleport', { session_id: plain.agentSessionId });
    h.check('an unknown terminal or event is ignored quietly', [r1, r2].every((r) => r.code === 0 && !r.stdout && !r.stderr));

    ptys.write(meta.id, 'exit\r');
    await h.waitFor(() => ptys.list().find((s) => s.id === meta.id).exited);
    const r3 = await fire({ ...plain.extraEnv, SEAMUX_SESSION_ID: meta.id }, 'prompt', { session_id: plain.agentSessionId });
    await sleep(300);
    h.check('a hook for an ended terminal changes nothing', r3.code === 0 && ptys.list().find((s) => s.id === meta.id).state === 'exited');
    await js(`window.seamux.removeSession(${S(meta.id)})`);
  });

  await h.finish();
};
