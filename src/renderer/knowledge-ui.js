'use strict';

/* global H */

// Settings for the knowledge server: any MCP server, connected by command or
// URL, with the calls Seamux makes mapped to that server's own tools.
// Wrapped in a function so its names never collide with the other scripts.
(function () {
  const UI = () => window.__envUI;
  let state = null;
  let toastTimer = null;

  function h(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n[k] = v;
      else if (v === true) n.setAttribute(k, '');
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v);
    }
    for (const c of kids) if (c) n.append(c);
    return n;
  }

  function toast(text, bad) {
    const n = document.querySelector('#toast');
    n.textContent = text;
    n.className = bad ? 'bad' : '';
    n.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { n.hidden = true; }, bad ? 8000 : 4000);
  }

  function apply(s) {
    state = s;
    // The Artifacts panel needs a "session artifacts" call.
    const btn = document.querySelector('#session-artifacts');
    if (btn) btn.hidden = !(s && s.mapped && s.mapped.sessionArtifacts);
  }

  async function refresh() { apply(await H.knowledgeGet()); return state; }

  const lines = (text) => String(text || '').split('\n').map((x) => x.trim()).filter(Boolean);
  const pairs = (text, sep) => Object.fromEntries(lines(text).map((l) => {
    const i = l.indexOf(sep);
    if (i < 1) throw new Error(`"${l}" is not in the form NAME${sep}value`);
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }));

  const CALLS = [
    ['save', 'Save', 'Called when a project rule is added or changed. Placeholders: {rule}, {project.path}, {project.name}.', false],
    ['importRules', 'Import rules', 'Called from a project’s rules to find rules to add. Placeholders: {project.path}, {project.name}.', true],
    ['sessionArtifacts', 'Session artifacts', 'Fills the Artifacts panel for a terminal. Placeholder: {session.id}.', true],
  ];

  async function open() {
    await refresh();
    const cfg = state.config || { server: { type: 'none' } };
    let tools = [];

    const name = h('input', { class: 'field', id: 'kn-name', value: cfg.name || '', placeholder: 'knowledge' });
    const type = h('select', { class: 'field', id: 'kn-type' },
      ...[['none', 'None'], ['stdio', 'A command (local MCP server)'], ['http', 'A URL (remote MCP server)']].map(([v, l]) => {
        const o = h('option', { value: v, text: l }); if ((cfg.server || {}).type === v) o.selected = true; return o;
      }));
    const s = cfg.server || {};
    const command = h('input', { class: 'field mono', id: 'kn-command', value: s.command || '', placeholder: 'uv, npx, python3, /path/to/server' });
    const args = h('textarea', { class: 'field mono', id: 'kn-args', rows: '3', placeholder: 'One argument per line' });
    args.value = (s.args || []).join('\n');
    const env = h('textarea', { class: 'field mono', id: 'kn-env', rows: '2', placeholder: 'NAME=value, one per line (not secret)' });
    env.value = Object.entries(s.env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
    const url = h('input', { class: 'field mono', id: 'kn-url', value: s.url || '', placeholder: 'https://example.com/mcp' });
    const oauth = h('input', { type: 'checkbox', id: 'kn-oauth' }); oauth.checked = !!s.oauth;
    const headers = h('textarea', { class: 'field mono', id: 'kn-headers', rows: '2',
      placeholder: state.headerNames.length ? `Saved: ${state.headerNames.join(', ')} (values hidden). Type here to replace them all.` : 'Name: value, one per line. Stored encrypted.' });

    const stdioBox = h('div', { class: 'kn-grid' }, h('label', { text: 'Command' }), command, h('label', { text: 'Arguments' }), args, h('label', { text: 'Environment' }), env);
    const httpBox = h('div', { class: 'kn-grid' }, h('label', { text: 'URL' }), url,
      h('label', { text: 'Sign-in' }), h('label', { class: 'kn-check' }, oauth, document.createTextNode(' Sign in with the browser (OAuth)')),
      h('label', { text: 'Headers' }), headers);
    const showBoxes = () => { stdioBox.hidden = type.value !== 'stdio'; httpBox.hidden = type.value !== 'http'; };
    type.onchange = showBoxes;

    const toolList = h('datalist', { id: 'kn-tools' });
    const callFields = {};
    const callBoxes = CALLS.map(([key, label, help, hasPattern]) => {
      const c = cfg[key] || {};
      const tool = h('input', { class: 'field mono', id: `kn-${key}-tool`, value: c.tool || '', list: 'kn-tools', placeholder: 'tool name (empty: not used)' });
      const a = h('textarea', { class: 'field mono', id: `kn-${key}-args`, rows: '2', placeholder: '{ "argument": "value with {placeholders}" }' });
      a.value = c.args ? JSON.stringify(c.args, null, 1) : '';
      const pat = hasPattern ? h('input', { class: 'field mono', id: `kn-${key}-pattern`, value: c.linePattern || '', placeholder: 'Line pattern for text results (optional; group 1 is the value)' }) : null;
      callFields[key] = { tool, args: a, pattern: pat };
      return h('div', { class: 'kn-call' },
        h('div', { class: 'kn-call-head' }, h('strong', { text: label }), h('span', { class: 'dim small', text: help })),
        tool, a, pat);
    });

    const agent = h('input', { type: 'checkbox', id: 'kn-agent' }); agent.checked = cfg.agentAccess !== false;
    const status = h('p', { class: 'kn-status dim small' });
    const err = h('p', { class: 'b-err', hidden: true });

    function read() {
      if (type.value === 'none') return { config: null, headers: null };
      let server;
      if (type.value === 'stdio') {
        if (!command.value.trim()) throw new Error('enter the command that starts the server');
        server = { type: 'stdio', command: command.value.trim(), args: lines(args.value), env: pairs(env.value, '=') };
      } else {
        if (!/^https?:\/\//.test(url.value.trim())) throw new Error('enter the server’s URL, starting with http:// or https://');
        server = { type: 'http', url: url.value.trim(), oauth: oauth.checked };
      }
      const config = { name: name.value.trim() || 'knowledge', server, agentAccess: agent.checked };
      for (const [key, , , hasPattern] of CALLS) {
        const f = callFields[key];
        if (!f.tool.value.trim()) continue;
        let a = {};
        if (f.args.value.trim()) {
          try { a = JSON.parse(f.args.value); } catch (e) { throw new Error(`the arguments for ${key} are not valid JSON: ${e.message}`); }
        }
        config[key] = { tool: f.tool.value.trim(), args: a };
        if (hasPattern && f.pattern.value.trim()) {
          try { new RegExp(f.pattern.value.trim()); } catch (e) { throw new Error(`the line pattern for ${key} is not valid: ${e.message}`); }
          config[key].linePattern = f.pattern.value.trim();
        }
      }
      const hdrs = type.value === 'http' && headers.value.trim() ? pairs(headers.value, ':') : null;
      return { config, headers: hdrs };
    }
    const fail = (e) => { err.textContent = e.message || String(e); err.hidden = false; };

    async function saveOnly() { const r = read(); apply(await H.knowledgeSet(r.config, r.headers)); }

    async function test() {
      err.hidden = true;
      let draft;
      try { draft = read(); } catch (e) { fail(e); return; }
      if (!draft.config) { status.textContent = 'Choose a command or a URL first.'; return; }
      status.textContent = 'Connecting…';
      const r = await H.knowledgeTest(draft);   // tests what is on screen; nothing is saved
      if (!r.ok) {
        status.textContent = r.needsSignIn ? 'The server needs you to sign in. Tick “Sign in with the browser”, save, then press Sign in.' : `Could not connect: ${r.error}`;
        return;
      }
      tools = r.tools;
      toolList.replaceChildren(...tools.map((t) => h('option', { value: t.name })));
      status.textContent = `Connected. ${tools.length} tool${tools.length === 1 ? '' : 's'}: ${tools.map((t) => t.name).join(', ')}`;
    }

    const example = () => {
      const ex = state.examples.jejak;
      name.value = ex.name;
      type.value = ex.server.type;
      command.value = ex.server.command;
      args.value = ex.server.args.join('\n');
      env.value = '';
      for (const [key] of CALLS) {
        const c = ex[key] || {};
        callFields[key].tool.value = c.tool || '';
        callFields[key].args.value = c.args ? JSON.stringify(c.args, null, 1) : '';
        if (callFields[key].pattern) callFields[key].pattern.value = c.linePattern || '';
      }
      agent.checked = ex.agentAccess !== false;
      showBoxes();
      status.textContent = 'Filled in the Jejak example. Test it, then save.';
    };

    const signBtns = h('span', { class: 'kn-sign' });
    function renderSign() {
      signBtns.replaceChildren();
      if (!(cfg.server && cfg.server.type === 'http' && cfg.server.oauth) && !(type.value === 'http' && oauth.checked)) return;
      signBtns.append(state.signedIn
        ? h('button', { class: 'btn', text: 'Sign out', onclick: async () => { apply(await H.knowledgeSignOut()); renderSign(); } })
        : h('button', { class: 'btn', text: 'Sign in…', onclick: async () => {
          try { await saveOnly(); } catch (e) { fail(e); return; }
          status.textContent = 'Finish signing in in your browser…';
          const r = await H.knowledgeSignIn();
          status.textContent = r.ok ? 'Signed in.' : `Sign-in failed: ${r.error}`;
          await refresh(); renderSign();
        } }));
    }
    oauth.onchange = renderSign;

    const body = h('div', { class: 'kn-body' },
      h('div', { class: 'kn-grid' }, h('label', { text: 'Name' }), name, h('label', { text: 'Server' }), type),
      stdioBox, httpBox,
      h('div', { class: 'kn-actions' },
        h('button', { class: 'btn', text: 'Test connection', onclick: test }),
        signBtns,
        h('span', { class: 'spacer' }),
        h('button', { class: 'mini', text: 'Fill in the Jejak example', onclick: example })),
      status,
      h('h3', { class: 'kn-h', text: 'Calls Seamux makes' }),
      h('p', { class: 'dim small', text: 'Map each call to one of the server’s tools. Leave a tool empty to turn that call off. Text results are read line by line; a line pattern keeps only matching lines.' }),
      toolList,
      ...callBoxes,
      h('label', { class: 'kn-check' }, agent, document.createTextNode(' Give Claude Code terminals access to this server, so agents can search and save knowledge')),
      err);
    showBoxes();
    renderSign();

    const m = UI().openModal({
      title: 'Knowledge server',
      subtitle: 'Any MCP server you have installed. Seamux uses it to record project rules, import rules and list what each session produced.',
      body,
      footer: h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', text: 'Cancel', onclick: () => m.close() }),
        h('button', { class: 'btn primary', text: 'Save', onclick: async () => {
          try { await saveOnly(); m.close(); toast('Knowledge server saved.'); } catch (e) { fail(e); }
        } })),
      wide: true,
    });
  }

  /**
   * Rules found on the knowledge server, for the user to pick from.
   * @returns {Promise<string[]|null>} the chosen rules, or null if cancelled
   */
  async function pickImportedRules(cwd, name) {
    const r = await H.knowledgeImportRules(cwd);
    if (!r.ok) { toast(`Could not import rules: ${r.error}`, true); return null; }
    if (!r.rules.length) { toast('The knowledge server returned no rules for this project.'); return null; }
    return new Promise((resolve) => {
      const boxes = r.rules.map((text, i) => {
        const cb = h('input', { type: 'checkbox', id: `imp-${i}` });
        cb.checked = true;
        return { cb, text, row: h('label', { class: 'kn-check imp-row' }, cb, document.createTextNode(` ${text}`)) };
      });
      const m = UI().openModal({
        title: `Rules found for ${name}`,
        subtitle: 'Untick anything that is not a rule for this project.',
        body: h('div', { class: 'imp-list' }, ...boxes.map((b) => b.row)),
        footer: h('div', { class: 'modal-actions' },
          h('button', { class: 'btn', text: 'Cancel', onclick: () => { m.close(); resolve(null); } }),
          h('button', { class: 'btn primary', text: 'Add selected', onclick: () => { m.close(); resolve(boxes.filter((b) => b.cb.checked).map((b) => b.text)); } })),
        wide: true,
      });
    });
  }

  H.onKnowledge(open);
  H.onKnowledgeChanged(apply);
  H.onKnowledgeStatus((s) => toast(s.message, !s.ok));

  window.__knowledge = { open, refresh, toast, pickImportedRules, get state() { return state; } };
  refresh();
})();
