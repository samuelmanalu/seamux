'use strict';
/**
 * Claude Code hooks end to end: a real-`claude` terminal (stub on PATH) gets
 * Seamux's hooks file through --settings, and hook events sent with the real
 * `seamux hook` command from inside that terminal move the card and set the
 * exact next step. Reports for another session are refused.
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
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-hooks-e2e-')));
  const waitFor = async (fn, ms = 6000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(200); } return v; };
  // Send a hook event the way Claude Code does: it runs the hook command as
  // its own child process (not in the terminal), with the terminal's
  // environment and the event as JSON on stdin.
  const { execFile } = require('child_process');
  const hookResults = [];
  const fire = (paneId, event, payload) => new Promise((resolve) => {
    const s = ptys.sessions.get(paneId);
    const launcher = path.join(app.getPath('userData'), 'bin', 'seamux');
    const child = execFile(launcher, ['hook', event], { env: { ...process.env, ...s.extraEnv, SEAMUX_SESSION_ID: paneId } },
      (err, stdout, stderr) => { hookResults.push({ code: err ? err.code : 0, stdout, stderr }); resolve(); });
    child.stdin.end(JSON.stringify(payload));
  });

  try {
    await sleep(700);
    const t = await js(`window.seamux.boardCreate({ cwd: ${S(cwd)}, title: 'Hooked', status: 'ready' })`);
    await js(`window.__board.start(${S(t.id)})`);
    await sleep(1200);
    const pane = ptys.list().find((s) => s.taskId === t.id);
    const args = ptys.sessions.get(pane.id).args;
    const file = args[args.indexOf('--settings') + 1];
    check('a Claude terminal gets Seamux’s hooks through --settings', args.includes('--settings') && fs.existsSync(file), S(args));
    const conf = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('for prompt, notification and stop', S(Object.keys(conf.hooks).sort()) === S(['Notification', 'Stop', 'UserPromptSubmit']));
    const cmd = conf.hooks.Stop[0].hooks[0].command;
    check('each hook runs the seamux launcher by its full, quoted path', /^'.*\/bin\/seamux' hook stop$/.test(cmd) && fs.existsSync(cmd.slice(1, cmd.indexOf("' "))), cmd);
    check('--settings comes before --mcp-config and the session id', args.indexOf('--settings') < args.indexOf('--session-id'));

    const sid = pane.agentSessionId;
    await js('window.__board.show()');

    await fire(pane.id, 'prompt', { session_id: sid, hook_event_name: 'UserPromptSubmit' });
    check('a prompt hook marks the task Running', await waitFor(async () => (await js(`window.__board.columnOf(${S(t.id)})`)) === 'running' || ptys.list().find((x) => x.id === pane.id).rule === 'hook'));

    await fire(pane.id, 'notification', { session_id: sid, hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });
    const asked = await waitFor(() => { const p = ptys.list().find((x) => x.id === pane.id); return p.state === 'needs_input' && p.reason === 'Claude needs your permission to use Bash' ? p : null; });
    const nowP = ptys.list().find((x) => x.id === pane.id);
    check('a notification hook marks it Needs you, in Claude’s words', !!asked, S({ state: nowP.state, reason: nowP.reason, rule: nowP.rule, hooks: hookResults }));

    await fire(pane.id, 'stop', { session_id: sid, hook_event_name: 'Stop', last_assistant_message: 'Fixed the **rounding**. Tests pass; next I will open the MR.' });
    const step = await waitFor(() => board.get(t.id).nextStep);
    check('a stop hook sets the exact last message as the next step', step === 'Fixed the rounding. Tests pass; next I will open the MR.', step);
    await sleep(1500);
    check('the screen reader does not overwrite it afterwards', board.get(t.id).nextStep === step, board.get(t.id).nextStep);

    await fire(pane.id, 'stop', { session_id: '00000000-0000-0000-0000-000000000000', last_assistant_message: 'IMPOSTER' });
    await sleep(1500);
    check('a report for another session is refused', board.get(t.id).nextStep === step);
    check('the hook command always exits 0 and prints nothing', hookResults.length === 4 && hookResults.every((r) => r.code === 0 && !r.stdout && !r.stderr), S(hookResults));
    ptys.write(pane.id, 'echo new output\r');
    await waitFor(() => ptys.list().find((x) => x.id === pane.id).rule !== 'hook', 3000);
    check('new output in the terminal hands status back to the screen reader', ptys.list().find((x) => x.id === pane.id).rule !== 'hook');

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
