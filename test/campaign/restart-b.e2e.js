'use strict';
/**
 * Campaign 4, part B: the app starts again on the data folder part A left.
 * Everything must come back, and the task that was running must resume its
 * conversation in its worktree.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { harness } = require('./helpers');

module.exports = async function (ctx) {
  const h = harness(ctx, 'RESTART, AFTER');
  const { S, js, sleep, ptys, board, app } = h;
  await sleep(900);
  const ho = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'handoff.json'), 'utf8'));

  await h.section('what comes back', async () => {
    h.check('no terminal survives the restart', ptys.list().length === 0);
    const run = board.get(ho.running);
    h.check('the running task is back in Ready, with its conversation and worktree', run.status === 'ready' && run.sessionId === ho.sessionId && run.worktree && run.worktree.path === ho.worktree.path && fs.existsSync(run.worktree.path));
    h.check('the queued task is back in Ready', board.get(ho.queued).status === 'ready');
    h.check('the waiting task still waits, with its note', board.get(ho.waiting).status === 'waiting' && board.get(ho.waiting).waitingFor === 'legal review');
    h.check('the blocked task is still blocked', board.blockedBy(ho.blocked).length === 1);
    h.check('links, rules and limits are kept', S(run.links) === S(['https://example.com/mr/7']) && board.rulesFor(ho.repo)[0].text === 'Rule kept across restarts' && board.limitFor(ho.repo) === 1 && board.globalLimit() === 6);
    const kn = await js('window.seamux.knowledgeGet()');
    h.check('the knowledge server settings are kept', kn.configured && kn.config.name === 'kb');
    h.check('the board opens by itself when it has tasks', await js("!document.querySelector('#boardview').hidden"));
    h.check('time held in memory was written at quit', (run.time || {}).agent >= 7 * 60000, run.time);
    h.check('the focus session cut short by the quit is recorded, not completed', run.focus && run.focus.sessions === 1 && run.focus.completed === 0, run.focus);
    h.check('no focus session runs after a restart', !ctx.focus.current && !(await js("document.body.classList.contains('focus-mode')")));
    h.check('cards offer Resume for the conversation', /Resume/.test(await h.cardText(ho.running)), await h.cardText(ho.running));
  });

  await h.section('resuming', async () => {
    await h.start(ho.running);
    await sleep(1200);
    const pane = h.paneOf(ho.running);
    const args = pane ? h.argsOf(pane.id) : [];
    h.check('the conversation resumes with its id, in its worktree', args[args.indexOf('--resume') + 1] === ho.sessionId && ptys.sessions.get(pane.id).cwd === ho.worktree.runCwd, args);
    h.check('…with the project rules again', /Rule kept across restarts/.test(args[args.indexOf('--append-system-prompt') + 1] || ''));
    const r = await h.start(ho.queued);
    h.check('limits still apply after the restart', r.status === 'queued');
    const imp = await js(`window.seamux.knowledgeImportRules(${S(ho.repo)})`);
    h.check('the knowledge server works after the restart', imp.ok && imp.rules.length === 2);
    const out = await new Promise((resolve) => execFile(path.join(app.getPath('userData'), 'bin', 'seamux'), ['task', 'list'],
      { env: { ...process.env, ...ptys.sessions.get(pane.id).extraEnv } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));
    h.check('the seamux command works on the new socket', out.code === 0 && /Was running/.test(out.stdout), out);
  });

  await h.section('clean up', async () => {
    for (const s of ptys.list()) await js(`closeSession(${S(s.id)})`);
    await sleep(400);
    fs.rmSync(ho.parent, { recursive: true, force: true });
  });
  await h.finish();
};
