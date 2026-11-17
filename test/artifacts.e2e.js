'use strict';
/**
 * Artifacts panel, end to end in the real window, against a fake `jejak`
 * (SEAMUX_JEJAK_BIN). SEAMUX_CLAUDE_BIN=/bin/bash means panes get no Claude
 * session id, so the test first checks that state, then gives the pane one by
 * hand to exercise the cards, the empty state and the error state.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let fails = 0; const out = [];
const check = (n, c, d) => { out.push((c?'PASS  ':'FAIL  ')+n+(c||!d?'':`  (${d})`)); if(!c) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = async function ({ win, ptys, app }) {
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-art-'));
  const bin = (name, body) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return p;
  };
  const records = JSON.stringify([
    { id: '1', type: 'artifact', created_at: '2026-01-02T10:00:00', content: 'Artifact: plan.html — Test plan. (https://claude.ai/artifact/AbC)', source_file: 'https://claude.ai/artifact/AbC' },
    { id: '2', type: 'artifact', created_at: '2026-01-01T09:00:00', content: 'Artifact: Artifact (https://claude.ai/artifact/AbC,)', source_file: 'https://claude.ai/artifact/AbC,' },
    { id: '3', type: 'artifact', created_at: '2026-01-03T08:00:00', content: 'Document: Notes <b>x</b> (draft) (/tmp/notes.md) — Summary.', source_file: '/tmp/notes.md' },
    { id: '4', type: 'decision', created_at: '2026-01-03T08:00:00', content: 'not shown' },
  ]);
  const panel = () => js(`({
    hidden: document.querySelector('#artifactspanel').hidden,
    body: document.querySelector('#artifacts-body').innerText,
    titles: [...document.querySelectorAll('.artifact-title')].map(e => e.textContent),
    links: [...document.querySelectorAll('.artifact-link')].map(e => e.getAttribute('href')),
    injected: !!document.querySelector('#artifacts-body b'),
  })`);

  try {
    await sleep(700);
    await js(`openProject(${JSON.stringify(dir)}, 'p1')`);
    await sleep(1500);
    const s = ptys.list()[0];
    check('a session is running', !!s && !s.exited);
    check('a non-claude binary gets no Jejak session id', s && s.jejakSessionId === null);

    await js(`document.querySelector('#session-artifacts').click()`);
    await sleep(300);
    let p = await panel();
    check('Artifacts button opens the panel', p.hidden === false);
    check('pane without a session id says so', /no Jejak session id/.test(p.body), p.body);

    // Give the pane an id, as a real claude pane would have from spawn.
    const sid = '11111111-2222-3333-4444-555555555555';
    ptys.sessions.get(s.id).jejakSessionId = sid;
    await js(`panes.get(${JSON.stringify(s.id)}).meta.jejakSessionId = ${JSON.stringify(sid)}`);

    process.env.SEAMUX_JEJAK_BIN = bin('ok', `[ "$2" = "${sid}" ] || exit 7\nprintf '%s' '${records}'`);
    await js('refreshArtifacts()');
    await sleep(800);
    p = await panel();
    check('only artifact records, duplicate URL collapsed', p.titles.length === 2, JSON.stringify(p.titles));
    check('newest first, title keeps its parentheses', p.titles[0] === 'Notes <b>x</b> (draft)', JSON.stringify(p.titles));
    check('published artifact is a link', p.links.length === 1 && p.links[0] === 'https://claude.ai/artifact/AbC', JSON.stringify(p.links));
    check('content is escaped, not injected as HTML', p.injected === false);

    process.env.SEAMUX_JEJAK_BIN = bin('none', `printf '[]'`);
    await js('refreshArtifacts()');
    await sleep(800);
    p = await panel();
    check('empty state', /No artifacts indexed for this session yet/.test(p.body), p.body);

    process.env.SEAMUX_JEJAK_BIN = bin('down', `echo 'Error: Cannot reach the Jejak server' >&2; exit 1`);
    await js('refreshArtifacts()');
    await sleep(800);
    p = await panel();
    check('error state shows Jejak\'s message', /Could not reach Jejak: Error: Cannot reach the Jejak server/.test(p.body), p.body);

    await js(`document.querySelector('#artifacts-close').click()`);
    await sleep(200);
    check('close button hides the panel', (await panel()).hidden === true);

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  } catch (e) {
    check('suite ran without throwing', false, e.message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(out.join('\n'));
    console.log(fails ? `${fails} of ${out.length} FAILED` : `ALL ${out.length} PASSED`);
    app.exit(fails ? 1 : 0);
  }
};
