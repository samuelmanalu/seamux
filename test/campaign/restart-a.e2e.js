'use strict';
/**
 * Campaign 4, part A: set up a busy board, then quit without tidying up.
 * Part B (restart-b.e2e.js) starts the app again on the same data folder.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { harness } = require('./helpers');

const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-mcp-server.js');

module.exports = async function (ctx) {
  const h = harness(ctx, 'RESTART, BEFORE');
  const { S, js, sleep, board, app } = h;
  await sleep(700);
  // Folders made by hand so they outlive this run (part B removes them).
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'restart-')));
  const repo = path.join(parent, 'repo');
  fs.mkdirSync(repo);
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  g('config', 'user.email', 't@e.com'); g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g('add', '.'); g('commit', '-q', '-m', 'init');

  await h.section('a busy board', async () => {
    await js(`window.seamux.boardSetLimit(${S(repo)}, 1)`);
    await js('window.seamux.boardSetGlobalLimit(6)');
    const running = await h.create({ cwd: repo, title: 'Was running', isolation: 'worktree', links: 'https://example.com/mr/7' });
    const queued = await h.create({ cwd: repo, title: 'Was queued', agent: 'shell' });
    const waiting = await h.create({ cwd: repo, title: 'Was waiting', agent: 'shell' });
    const blocked = await h.create({ cwd: repo, title: 'Was blocked', dependsOn: [waiting.id] });
    await h.start(running.id);
    await sleep(1200);
    const q = await h.start(queued.id);
    h.check('one running, one queued', q.status === 'queued' && board.get(running.id).status === 'active');
    await js(`window.seamux.boardWait(${S(waiting.id)}, 'legal review')`);
    await js(`window.seamux.rulesAdd(${S(repo)}, 'Rule kept across restarts')`);
    await js(`window.seamux.knowledgeSet(${S({ name: 'kb', server: { type: 'stdio', command: process.execPath, args: [FAKE], env: { ELECTRON_RUN_AS_NODE: '1' } }, importRules: { tool: 'find_rules', args: { project: 'x' }, linePattern: 'RULE: (.+)' } })}, null)`);
    await js(`window.__board.openPlanner(${S(repo)})`);
    await sleep(800);
    const r = board.get(running.id);
    h.check('the running task has a worktree and a conversation', !!r.worktree && fs.existsSync(r.worktree.path) && !!r.sessionId);
    fs.writeFileSync(path.join(app.getPath('userData'), 'handoff.json'), JSON.stringify({
      parent, repo, running: running.id, queued: queued.id, waiting: waiting.id, blocked: blocked.id,
      sessionId: r.sessionId, worktree: r.worktree,
    }));
  });
  // Quit with terminals still running, as a user closing the app would.
  await h.finish();
};
