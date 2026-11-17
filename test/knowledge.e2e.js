'use strict';
/**
 * The knowledge server, end to end: settings, saving rules to it, importing
 * rules from it, giving Claude terminals access to it, and keeping header
 * values out of the renderer. Served by test/fixtures/fake-mcp-server.js.
 * Runs with a stub `claude` on PATH (scripts/run-board-e2e.js).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let fails = 0; const out = [];
const check = (n, c, d) => { out.push((c ? 'PASS  ' : 'FAIL  ') + n + (c || !d ? '' : `  (${d})`)); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAKE = path.join(__dirname, 'fixtures', 'fake-mcp-server.js');

module.exports = async function ({ win, ptys, app, board }) {
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const S = JSON.stringify;
  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) consoleErrors.push(message); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-kn-e2e-'));
  const cwd = fs.realpathSync(dir);
  const LOG = path.join(cwd, 'calls.log');
  const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  const modalText = () => js("document.querySelector('#modal-root').innerText");
  const clickButton = (label) => js(`[...document.querySelectorAll('#modal-root button')].find(b => b.textContent === ${S(label)}).click()`);
  const server = { type: 'stdio', command: process.execPath, args: [FAKE], env: { ELECTRON_RUN_AS_NODE: '1', FAKE_MCP_LOG: LOG } };
  const mappings = {
    save: { tool: 'save_note', args: { text: 'RULE: {rule}', project: '{project.path}' } },
    importRules: { tool: 'find_rules', args: { project: '{project.name}' }, linePattern: 'RULE: (.+)' },
  };

  try {
    await sleep(700);

    /* settings dialog */
    win.webContents.send('ui:knowledge');
    await sleep(500);
    check('the settings dialog opens', /Knowledge server/.test(await modalText()));
    await clickButton('Fill in the Jejak example');
    check('the Jejak example fills in plain settings', (await js("document.querySelector('#kn-command').value")) === 'uv'
      && (await js("document.querySelector('#kn-save-tool').value")) === 'jejak_save');
    await clickButton('Cancel');
    check('cancel saves nothing', !(await js('window.seamux.knowledgeGet()')).configured);

    win.webContents.send('ui:knowledge');
    await sleep(400);
    await js(`document.querySelector('#kn-type').value = 'stdio'; document.querySelector('#kn-type').onchange()`);
    await js(`document.querySelector('#kn-command').value = ${S(process.execPath)}`);
    await js(`document.querySelector('#kn-args').value = ${S(FAKE)}`);
    await js(`document.querySelector('#kn-env').value = 'ELECTRON_RUN_AS_NODE=1'`);
    await clickButton('Test connection');
    let status = '';
    for (let i = 0; i < 30 && !/Connected|Could not/.test(status); i++) { await sleep(300); status = await js("document.querySelector('.kn-status').textContent"); }
    check('Test connection lists the server’s tools', /Connected\. 4 tools: .*find_rules/.test(status), status);
    await clickButton('Cancel');
    check('testing saves nothing', !(await js('window.seamux.knowledgeGet()')).configured);
    await js(`window.seamux.knowledgeSet(${S({ name: 'kb', server, ...mappings, agentAccess: true })}, null)`);

    /* saving rules */
    await js(`window.seamux.boardCreate({ cwd: ${S(cwd)}, title: 'Seed', status: 'backlog' })`);
    await js(`window.seamux.rulesAdd(${S(cwd)}, 'Keep commits small')`);
    let saved = null;
    for (let i = 0; i < 30 && !saved; i++) { await sleep(300); saved = calls().find((c) => c.tool === 'save_note'); }
    check('adding a rule saves it to the knowledge server', saved && saved.args.text === 'RULE: Keep commits small' && saved.args.project === cwd, S(saved));
    await sleep(300);
    check('a notice confirms the save', /Rule saved to the knowledge server/.test(await js("document.querySelector('#toast').textContent")));

    /* importing rules */
    await js(`window.__board.rulesDialog(${S(cwd)})`);
    await sleep(500);
    await clickButton('Import from knowledge server…');
    let picked = '';
    for (let i = 0; i < 30 && !/Rules found/.test(picked); i++) { await sleep(300); picked = await modalText(); }
    check('import shows the rules found, without duplicates', /Never push to main/.test(picked) && /Run the tests before every commit/.test(picked)
      && (picked.match(/Never push to main/g) || []).length === 1, picked);
    await js("document.querySelector('#imp-1').checked = false");
    await clickButton('Add selected');
    await sleep(800);
    check('only the ticked rules are added', S(board.rulesFor(cwd).map((r) => r.text)) === S(['Keep commits small', 'Never push to main']), S(board.rulesFor(cwd)));
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");

    /* agent access */
    const t = await js(`window.seamux.boardCreate({ cwd: ${S(cwd)}, title: 'Agent', status: 'ready' })`);
    await js(`window.__board.start(${S(t.id)})`);
    await sleep(1200);
    const pane = ptys.list().find((s) => s.taskId === t.id);
    const args = pane ? ptys.sessions.get(pane.id).args : [];
    const file = args[args.indexOf('--mcp-config') + 1];
    check('a Claude terminal gets the server through --mcp-config', !!file && fs.existsSync(file), S(args));
    const conf = file && JSON.parse(fs.readFileSync(file, 'utf8'));
    check('the config names the server and how to start it', conf && conf.mcpServers.kb && conf.mcpServers.kb.command === process.execPath, S(conf));
    check('the config file is owner-only', file && (fs.statSync(file).mode & 0o777) === 0o600);
    const after = args[args.indexOf('--mcp-config') + 2] || '';
    check('--mcp-config is followed by an option, so it cannot swallow the opening message', after.startsWith('--'), S(args));

    await js(`window.seamux.knowledgeSet(${S({ name: 'kb', server, ...mappings, agentAccess: false })}, null)`);
    const t2 = await js(`window.seamux.boardCreate({ cwd: ${S(cwd)}, title: 'NoAgent', status: 'ready' })`);
    await js(`window.__board.start(${S(t2.id)})`);
    await sleep(1200);
    const p2 = ptys.list().find((s) => s.taskId === t2.id);
    check('with agent access off, no --mcp-config', p2 && !ptys.sessions.get(p2.id).args.includes('--mcp-config'));

    /* a failing save is reported */
    await js(`window.seamux.knowledgeSet(${S({ name: 'kb', server, save: { tool: 'broken', args: {} } })}, null)`);
    await js(`window.seamux.rulesAdd(${S(cwd)}, 'Another rule')`);
    let toast = '';
    for (let i = 0; i < 30 && !/Could not save/.test(toast); i++) { await sleep(300); toast = await js("document.querySelector('#toast').textContent"); }
    check('a failed save is reported, and the rule is still added', /Could not save the rule to the knowledge server: it broke/.test(toast) && board.rulesFor(cwd).length === 3, toast);

    /* header values stay in the main process */
    await js(`window.seamux.knowledgeSet(${S({ server: { type: 'http', url: 'http://127.0.0.1:9/mcp' } })}, { Authorization: 'Bearer SECRET-123' })`);
    const st = await js('window.seamux.knowledgeGet()');
    check('the renderer sees header names only', S(st.headerNames) === S(['Authorization']) && !S(st).includes('SECRET-123'));
    await js('window.seamux.knowledgeSet(null, null)');
    check('turning the server off clears it', !(await js('window.seamux.knowledgeGet()')).configured);
    check('and hides the Artifacts button', await js("document.querySelector('#session-artifacts').hidden"));

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  } catch (e) {
    check('suite ran without throwing', false, e.stack || e.message);
  } finally {
    console.log(out.join('\n'));
    console.log(fails ? `${fails} of ${out.length} FAILED` : `ALL ${out.length} PASSED`);
    fs.rmSync(dir, { recursive: true, force: true });
    app.exit(fails ? 1 : 0);
  }
};
