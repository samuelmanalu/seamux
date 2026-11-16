'use strict';
/**
 * Artifacts panel, end to end in the real window, served by a knowledge
 * server's mapped "sessionArtifacts" call (a fake MCP server here).
 * SEAMUX_CLAUDE_BIN=/bin/bash means panes get no Claude session id, so the test
 * first checks that state, then gives the pane one by hand.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let fails = 0; const out = [];
const check = (n, c, d) => { out.push((c ? 'PASS  ' : 'FAIL  ') + n + (c || !d ? '' : `  (${d})`)); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAKE = path.join(__dirname, 'fixtures', 'fake-mcp-server.js');

module.exports = async function ({ win, ptys, app }) {
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const S = JSON.stringify;
  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) consoleErrors.push(message); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-art-'));
  const panel = () => js(`({
    hidden: document.querySelector('#artifactspanel').hidden,
    body: document.querySelector('#artifacts-body').innerText,
    titles: [...document.querySelectorAll('.artifact-title')].map(e => e.textContent),
    links: [...document.querySelectorAll('.artifact-link')].map(e => e.getAttribute('href')),
  })`);
  const configure = (cfg) => js(`window.seamux.knowledgeSet(${S(cfg)}, null)`);
  // Electron's own binary runs the fake server as plain Node.
  const server = (extra = {}) => ({ type: 'stdio', command: process.execPath, args: [FAKE], env: { ELECTRON_RUN_AS_NODE: '1' }, ...extra });

  try {
    await sleep(700);
    await js(`openProject(${S(dir)}, 'p1')`);
    await sleep(1500);
    const s = ptys.list()[0];
    check('a session is running', !!s && !s.exited);
    check('a non-claude binary gets no agent session id', s && s.agentSessionId === null);

    await js(`document.querySelector('#session-artifacts').click()`);
    await sleep(300);
    let p = await panel();
    check('Artifacts button opens the panel', p.hidden === false);
    check('pane without a session id says so', /Only Claude Code terminals/.test(p.body), p.body);

    const sid = '11111111-2222-3333-4444-555555555555';
    ptys.sessions.get(s.id).agentSessionId = sid;
    await js(`panes.get(${S(s.id)}).meta.agentSessionId = ${S(sid)}`);

    await js('refreshArtifacts()');
    await sleep(500);
    p = await panel();
    check('without a knowledge server the panel says how to set one up', /Set up a knowledge server/.test(p.body), p.body);

    await configure({ server: server(), sessionArtifacts: { tool: 'session_items', args: { session_id: '{session.id}' }, linePattern: '^(?:Artifact|Document): ' } });
    await js('refreshArtifacts()');
    await sleep(2500);
    p = await panel();
    check('text results: only pattern-kept lines with a link or file', p.titles.length === 2, S(p.titles));
    check('titles come through', p.titles.includes('Release plan') && p.titles.includes('Runbook'), S(p.titles));
    check('a published artifact is a link', S(p.links) === S(['https://example.com/a/plan']), S(p.links));

    await configure({ server: server(), sessionArtifacts: { tool: 'session_items', args: { session_id: '{session.id}', json: true } } });
    await js('refreshArtifacts()');
    await sleep(2500);
    p = await panel();
    check('JSON results work too', p.titles.length === 2 && p.titles.includes('Notes'), S(p.titles));

    await configure({ server: server({ args: ['/nonexistent/server.js'] }), sessionArtifacts: { tool: 'session_items', args: {} } });
    await js('refreshArtifacts()');
    await sleep(3000);
    p = await panel();
    check('a broken server shows as a message', /Could not reach the knowledge server/.test(p.body), p.body);

    await js(`document.querySelector('#artifacts-close').click()`);
    await sleep(200);
    check('close button hides the panel', (await panel()).hidden === true);
    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  } catch (e) {
    check('suite ran without throwing', false, e.stack || e.message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(out.join('\n'));
    console.log(fails ? `${fails} of ${out.length} FAILED` : `ALL ${out.length} PASSED`);
    app.exit(fails ? 1 : 0);
  }
};
