'use strict';
/**
 * Campaign 2: project rules and the knowledge server, edges included.
 * Rule changes and their notices, duplicates, odd characters, plain sessions,
 * promoting with and without a selection; a knowledge server that crashes,
 * returns nothing or errors, settings the dialog must refuse, header
 * replacement, and agent access being turned off.
 * Stub `claude` on PATH; the knowledge server is test/fixtures/fake-mcp-server.js.
 */
const fs = require('fs');
const path = require('path');
const { harness } = require('./helpers');

const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-mcp-server.js');

module.exports = async function (ctx) {
  const h = harness(ctx, 'RULES AND KNOWLEDGE');
  const { S, js, sleep, ptys, board } = h;
  const server = { type: 'stdio', command: process.execPath, args: [FAKE], env: { ELECTRON_RUN_AS_NODE: '1' } };
  await sleep(700);

  await h.section('rules: changes, notices and odd text', async () => {
    const p = h.tmp('rk-rules');
    const t = await h.create({ cwd: p, title: 'Rule follower' });
    await h.start(t.id);
    await sleep(900);
    const pane = h.paneOf(t.id);
    const r1 = await js(`window.seamux.rulesAdd(${S(p)}, 'Use "quotes", $dollars and \`ticks\`\\nacross two lines')`);
    h.check('a rule with quotes, symbols and a line break is kept as written', board.rulesFor(p)[0].text === 'Use "quotes", $dollars and `ticks`\nacross two lines');
    const told = await h.waitFor(() => {
      const s = ptys.sessions.get(pane.id);
      const all = `${ptys.replay(pane.id)} ${s.pendingInjection || ''}`;
      return /Project rules changed: added/.test(all) ? all : null;
    });
    h.check('the notice reaches the running terminal on one line', !!told && !/added "Use "quotes", \$dollars and `ticks`\n/.test(told));
    const dup = await h.tryCall(`window.seamux.rulesAdd(${S(p)}, 'Use "quotes", $dollars and \`ticks\`\\nacross two lines')`);
    h.check('a duplicate rule is refused', !dup.ok && /already has that rule/.test(dup.error));
    const empty = await h.tryCall(`window.seamux.rulesAdd(${S(p)}, '   ')`);
    h.check('an empty rule is refused', !empty.ok && /cannot be empty/.test(empty.error));
    await js(`window.seamux.rulesUpdate(${S(p)}, ${S(r1.rule.id)}, 'Rule one, edited')`);
    await js(`window.seamux.rulesAdd(${S(p)}, 'Rule two')`);
    await js(`activate(${S(pane.id)})`);
    await sleep(300);
    h.check('the chip follows the current rules of a running Claude terminal', (await js("document.querySelector('#session-rules').textContent")) === 'Rules 2 ✓', await js("document.querySelector('#session-rules').textContent"));
    await js(`window.seamux.rulesRemove(${S(p)}, ${S(board.rulesFor(p)[1].id)})`);
    const removed = await h.waitFor(() => /removed "Rule two"/.test(`${ptys.replay(pane.id)} ${ptys.sessions.get(pane.id).pendingInjection || ''}`));
    h.check('removing a rule is announced too', removed);
    const gone = await h.tryCall(`window.seamux.rulesRemove(${S(p)}, 'r_missing')`);
    h.check('removing a rule that is not there is refused', !gone.ok && /no such rule/.test(gone.error));

    // A plain session (not a task) in the project also gets the rules.
    const meta = await js(`window.seamux.createSession({ cwd: ${S(p)}, title: 'plain' })`);
    await sleep(800);
    const args = h.argsOf(meta.id);
    const sys = args[args.indexOf('--append-system-prompt') + 1] || '';
    h.check('a plain session in the project gets the rules too', /1\. Rule one, edited/.test(sys), args);
    await js(`window.seamux.removeSession(${S(meta.id)})`);

    // A terminal that ended is not told, and nothing breaks.
    ptys.write(pane.id, 'exit\r');
    await h.waitFor(() => h.paneOf(t.id).exited);
    const r3 = await js(`window.seamux.rulesAdd(${S(p)}, 'Rule three')`);
    h.check('an ended terminal is not counted as told', r3.told === 0, r3);
  });

  await h.section('rules dialog and promote', async () => {
    const p = h.tmp('rk-dialog');
    await h.create({ cwd: p, title: 'Lane' });
    await js(`window.__board.rulesDialog(${S(p)})`);
    await sleep(400);
    await js("document.querySelector('#rule-new').value = 'From the dialog'");
    await h.clickButton('Add rule');
    await sleep(400);
    h.check('adding in the dialog lists the rule', /1\. From the dialog/.test(await h.modalText()));
    await js("document.querySelector('#rule-new').value = 'From the dialog'");
    await h.clickButton('Add rule');
    await sleep(400);
    h.check('the dialog shows a duplicate as an error', /already has that rule/.test(await h.modalText()));
    await h.escape();

    const t = await h.create({ cwd: p, title: 'Promote here', agent: 'shell' });
    await h.start(t.id);
    await sleep(700);
    await js(`activate(${S(h.paneOf(t.id).id)}); panes.get(${S(h.paneOf(t.id).id)}).term.clearSelection()`);
    ctx.win.webContents.send('ui:promoteRule');
    await sleep(500);
    h.check('promote with nothing selected opens an empty rule for this project', /Rules for/.test(await h.modalText()) && (await js("document.querySelector('#rule-new').value")) === '');
    await h.escape();
    await h.closeTaskPane(t.id);
  });

  await h.section('knowledge server: crash, empty and failing results', async () => {
    const p = h.tmp('rk-know');
    await h.create({ cwd: p, title: 'Seed' });
    await js(`window.seamux.knowledgeSet(${S({ server, importRules: { tool: 'find_rules', args: { project: '{project.name}' }, linePattern: 'RULE: (.+)' } })}, null)`);
    let r = await js(`window.seamux.knowledgeImportRules(${S(p)})`);
    h.check('import works', r.ok && r.rules.length === 2, r);
    const pid = ctx.knowledge.transport && ctx.knowledge.transport.pid;
    h.check('the server runs as its own process', !!pid);
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    await sleep(500);
    r = await js(`window.seamux.knowledgeImportRules(${S(p)})`);
    h.check('after the server crashes, the next call starts it again', r.ok && r.rules.length === 2 && ctx.knowledge.transport.pid !== pid, r);

    await js(`window.seamux.knowledgeSet(${S({ server, importRules: { tool: 'find_rules', args: { project: 'x' }, linePattern: 'NOTHING MATCHES (.+)' } })}, null)`);
    await js(`window.__board.rulesDialog(${S(p)})`);
    await sleep(400);
    await h.clickButton('Import from knowledge server…');
    h.check('an import that finds nothing says so', await h.waitFor(async () => /returned no rules/.test(await h.toastText())), await h.toastText());
    await h.escape();

    await js(`window.seamux.knowledgeSet(${S({ server, importRules: { tool: 'broken', args: {} } })}, null)`);
    await js(`window.__board.rulesDialog(${S(p)})`);
    await sleep(400);
    await h.clickButton('Import from knowledge server…');
    h.check('a failing import says why', await h.waitFor(async () => /Could not import rules: it broke/.test(await h.toastText())), await h.toastText());
    await h.escape();

    await js(`window.seamux.knowledgeSet(${S({ server, importRules: { tool: 'no_such_tool', args: {} } })}, null)`);
    r = await js(`window.seamux.knowledgeImportRules(${S(p)})`);
    h.check('a tool the server does not have gives an error, not a hang', !r.ok && r.error, r);
  });

  await h.section('settings the dialog refuses', async () => {
    await js('window.seamux.knowledgeSet(null, null)');
    const open = async () => { ctx.win.webContents.send('ui:knowledge'); await sleep(400); };
    const errorShown = async () => js("(() => { const e = document.querySelector('#modal-root .b-err'); return e && !e.hidden ? e.textContent : ''; })()");
    const setType = (v) => js(`document.querySelector('#kn-type').value = ${S(v)}; document.querySelector('#kn-type').onchange()`);
    const cases = [
      ['a command server without a command', async () => { await setType('stdio'); await js("document.querySelector('#kn-command').value = ''"); }, /enter the command/],
      ['arguments that are not JSON', async () => { await setType('stdio'); await js(`document.querySelector('#kn-command').value = 'x'; document.querySelector('#kn-save-tool').value = 'save'; document.querySelector('#kn-save-args').value = '{ not json'`); }, /not valid JSON/],
      ['a broken line pattern', async () => { await setType('stdio'); await js(`document.querySelector('#kn-command').value = 'x'; document.querySelector('#kn-importRules-tool').value = 't'; document.querySelector('#kn-importRules-pattern').value = '(unclosed'`); }, /line pattern .* not valid/],
      ['a URL that is not http', async () => { await setType('http'); await js("document.querySelector('#kn-url').value = 'ftp://example.com/mcp'"); }, /starting with http/],
      ['a header line without a colon', async () => { await setType('http'); await js("document.querySelector('#kn-url').value = 'https://example.com/mcp'; document.querySelector('#kn-headers').value = 'NoColonHere'"); }, /not in the form NAME:value/],
      ['an environment line without =', async () => { await setType('stdio'); await js("document.querySelector('#kn-command').value = 'x'; document.querySelector('#kn-env').value = 'JUSTANAME'"); }, /not in the form NAME=value/],
    ];
    for (const [label, fill, re] of cases) {
      await open();
      await fill();
      await h.clickButton('Save');
      await sleep(300);
      const e = await errorShown();
      h.check(`refused: ${label}`, re.test(e) && !(await js('window.seamux.knowledgeGet()')).configured, e);
      await h.escape();
      await sleep(150);
    }
  });

  await h.section('headers: kept, replaced, never shown', async () => {
    const url = 'http://127.0.0.1:9/mcp';
    const open = async () => { ctx.win.webContents.send('ui:knowledge'); await sleep(400); };
    await open();
    await js(`document.querySelector('#kn-type').value = 'http'; document.querySelector('#kn-type').onchange(); document.querySelector('#kn-url').value = ${S(url)}; document.querySelector('#kn-headers').value = 'Authorization: Bearer FIRST-SECRET'`);
    await h.clickButton('Save');
    await sleep(300);
    let st = await js('window.seamux.knowledgeGet()');
    h.check('headers are saved by name', S(st.headerNames) === S(['Authorization']));
    await open();
    const ph = await js("document.querySelector('#kn-headers').placeholder");
    h.check('the dialog says headers are saved without showing them', /Saved: Authorization \(values hidden\)/.test(ph) && !/FIRST-SECRET/.test(await js("document.querySelector('#modal-root').innerHTML")), ph);
    await h.clickButton('Save');
    await sleep(300);
    h.check('saving with the box empty keeps them', S((await js('window.seamux.knowledgeGet()')).headerNames) === S(['Authorization']));
    await open();
    await js("document.querySelector('#kn-headers').value = 'X-Api-Key: SECOND'");
    await h.clickButton('Save');
    await sleep(300);
    st = await js('window.seamux.knowledgeGet()');
    h.check('typing new headers replaces them all', S(st.headerNames) === S(['X-Api-Key']) && !S(st).includes('SECOND'));
  });

  await h.section('agent access turned off or removed', async () => {
    const p = h.tmp('rk-agent');
    await js(`window.seamux.knowledgeSet(${S({ server, agentAccess: true })}, null)`);
    const a = await h.create({ cwd: p, title: 'With access' });
    await h.start(a.id);
    await sleep(900);
    const file = h.argsOf(h.paneOf(a.id).id)[h.argsOf(h.paneOf(a.id).id).indexOf('--mcp-config') + 1];
    h.check('agent access gives Claude the server', !!file && fs.existsSync(file));
    await js('window.seamux.knowledgeSet(null, null)');
    const b = await h.create({ cwd: p, title: 'Without' });
    await js(`window.seamux.boardSetLimit(${S(p)}, 3)`);
    await h.start(b.id);
    await sleep(900);
    h.check('with no server, new terminals get no --mcp-config and the old file is gone', !h.argsOf(h.paneOf(b.id).id).includes('--mcp-config') && !fs.existsSync(file));
    await h.closeTaskPane(a.id); await h.closeTaskPane(b.id);
  });

  await h.finish();
};
