'use strict';

// Shared pieces for the end-to-end campaign suites: checks, waiting, and
// short ways to drive the window and read the board.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function harness({ win, ptys, app, board }, name) {
  const results = [];
  let fails = 0;
  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) consoleErrors.push(message); });
  const S = JSON.stringify;
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tmpRoots = [];

  const h = {
    S, js, sleep, ptys, board, app, win,
    check(n, c, d) {
      results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${c || d === undefined ? '' : `  (${typeof d === 'string' ? d : S(d)})`}`);
      if (!c) fails++;
    },
    async waitFor(fn, ms = 6000, step = 150) {
      const end = Date.now() + ms;
      let v;
      while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); }
      return v;
    },
    tmp(prefix) {
      const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
      tmpRoots.push(d);
      return d;
    },
    gitRepo(prefix, { commit = true } = {}) {
      const parent = h.tmp(prefix);
      const repo = path.join(parent, 'repo');
      fs.mkdirSync(repo);
      const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      g('config', 'user.email', 't@example.com');
      g('config', 'user.name', 'T');
      if (commit) {
        fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
        g('add', '.');
        g('commit', '-q', '-m', 'init');
      }
      return { repo, g };
    },
    create: (o) => js(`window.seamux.boardCreate(${S(o)})`),
    start: (id) => js(`window.seamux.boardStart(${S(id)})`),
    tryCall: async (code) => { try { return { ok: true, value: await js(code) }; } catch (e) { return { ok: false, error: String(e.message || e) }; } },
    paneOf: (taskId) => ptys.list().find((s) => s.taskId === taskId),
    argsOf: (paneId) => ptys.sessions.get(paneId).args,
    columnOf: (taskId) => js(`window.__board.columnOf(${S(taskId)})`),
    cardText: (taskId) => js(`(document.querySelector('[data-task="${taskId}"]') || {}).innerText || ''`),
    modalText: () => js("document.querySelector('#modal-root').hidden ? '' : document.querySelector('#modal-root').innerText"),
    flashText: () => js("document.querySelector('#board-flash').hidden ? '' : document.querySelector('#board-flash').textContent"),
    toastText: () => js("document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent"),
    escape: () => js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"),
    key: (k) => js(`document.querySelector('#boardview').dispatchEvent(new KeyboardEvent('keydown', { key: ${S(k)}, bubbles: true }))`),
    clickButton: (label) => js(`(() => { const b = [...document.querySelectorAll('#modal-root button')].find(x => x.textContent === ${S(label)}); if (!b) return false; b.click(); return true; })()`),
    async closeTaskPane(taskId) {
      const p = h.paneOf(taskId);
      if (p) await js(`closeSession(${S(p.id)})`);
      await sleep(400);
    },
    /**
     * End the suite: print, clean up, exit. With quit, leave the way a user
     * does (app.quit runs the quit handlers; app.exit skips them).
     */
    async finish({ quit = false } = {}) {
      h.check('no renderer console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
      console.log(`===== ${name} =====`);
      console.log(results.join('\n'));
      console.log(fails ? `${fails} of ${results.length} FAILED` : `ALL ${results.length} PASSED`);
      for (const d of tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
      if (quit && !fails) app.quit(); else app.exit(fails ? 1 : 0);
    },
    async section(title, fn) {
      try { await fn(); } catch (e) { h.check(`${title}: ran without throwing`, false, e.stack || e.message); }
    },
  };
  return h;
}

module.exports = { harness };
