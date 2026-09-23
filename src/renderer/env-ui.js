'use strict';

/* Wrapped in an IIFE: renderer.js and this file share one global lexical
 * scope, so a bare top-level `const` here can collide with one there and kill
 * the whole script with a SyntaxError. That happened once (`el`), silently.
 * Everything this module exposes goes through window.__envUI. */
(function () {

const E = window.seamux;

let sets = [];
let selectedId = null;
const revealed = new Set();   // "setId\0key" while explicitly revealed
let open = false;

const q = (s) => document.querySelector(s);
const panel = q('#envpanel');
const detail = q('#env-detail');
const modalRoot = q('#modal-root');

/* ------------------------------------------------------------------ helpers */

function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') throw new Error('never innerHTML here');
    else if (k.startsWith('on')) n[k] = v;
    else if (v === true) n.setAttribute(k, '');
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v);
  }
  for (const c of kids) if (c) n.append(c);
  return n;
}
const btn = (label, onclick, cls = 'mini') => h('button', { class: cls, text: label, onclick });

/* ------------------------------------------------------------------- modals */

/**
 * In-app modal. Replaces window.prompt/confirm/alert, which cannot mask a
 * secret value and look alarming to anyone not expecting them.
 */
function openModal({ title, subtitle, body, footer, wide }) {
  const card = h('div', { class: 'modal-card' + (wide ? ' wide' : '') },
    h('div', { class: 'modal-head' },
      h('h2', { text: title }),
      subtitle ? h('p', { text: subtitle }) : null),
    h('div', { class: 'modal-body' }, body),
    h('div', { class: 'modal-foot' }, footer));

  modalRoot.replaceChildren(card);
  modalRoot.hidden = false;

  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() {
    document.removeEventListener('keydown', onKey);
    modalRoot.hidden = true;
    modalRoot.replaceChildren();
  }
  return { close, card };
}

function confirmDialog(title, message, confirmLabel = 'Delete') {
  return new Promise((resolve) => {
    const m = openModal({
      title,
      body: h('p', { class: 'modal-text', text: message }),
      footer: h('div', { class: 'modal-actions' },
        btn('Cancel', () => { m.close(); resolve(false); }, 'btn'),
        btn(confirmLabel, () => { m.close(); resolve(true); }, 'btn danger')),
    });
  });
}

function textDialog(title, subtitle, { value = '', label = '', secret = false, okLabel = 'Save' }) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'field', value, type: secret ? 'password' : 'text' });
    const toggle = secret
      ? btn('show', () => {
          const showing = input.type === 'text';
          input.type = showing ? 'password' : 'text';
          toggle.textContent = showing ? 'show' : 'hide';
        })
      : null;
    const body = h('div', {},
      label ? h('label', { class: 'field-label', text: label }) : null,
      h('div', { class: 'field-row' }, input, toggle));
    const m = openModal({
      title, subtitle, body,
      footer: h('div', { class: 'modal-actions' },
        btn('Cancel', () => { m.close(); resolve(null); }, 'btn'),
        btn(okLabel, () => { m.close(); resolve(input.value); }, 'btn primary')),
    });
    input.focus();
    input.select();
    input.onkeydown = (e) => { if (e.key === 'Enter') { m.close(); resolve(input.value); } };
  });
}

/* ------------------------------------------------------------------- wizard */

/**
 * Guided add. One question per screen, plain language, nothing written until
 * the final step -- so backing out or closing leaves nothing behind.
 */
function startWizard() {
  const state = {
    step: 0,
    text: '',
    file: null, fileMode: 'live', fileFound: null,
    command: '', commandFound: null,
    name: '',
    instructions: '',
    preprompt: '',
    interpreted: null,
    projects: new Set(),
    found: { count: 0, keys: [], masked: {} },
    saved: null,
  };

  const m = openModal({ title: '', body: h('div'), footer: h('div'), wide: true });

  const STEPS = [stepAdd, stepReview, stepName, stepProjects, stepDone];

  function go(n) { state.step = n; render(); }

  function shell({ title, subtitle, body, back, next, nextLabel = 'Continue', nextEnabled = true, done }) {
    const total = STEPS.length - 1;
    const dots = h('div', { class: 'wiz-dots' });
    for (let i = 0; i < total; i++) {
      dots.append(h('span', { class: 'wiz-dot' + (i === state.step ? ' on' : '') + (i < state.step ? ' past' : '') }));
    }
    m.card.replaceChildren(
      h('div', { class: 'modal-head' },
        h('h2', { text: title }),
        subtitle ? h('p', { text: subtitle }) : null),
      h('div', { class: 'modal-body' }, body),
      h('div', { class: 'modal-foot' },
        state.step < total ? dots : h('span'),
        h('div', { class: 'modal-actions' },
          done
            ? btn('Done', () => { m.close(); refreshEnv(); refreshSecretsSidebar(); }, 'btn primary')
            : h('span', {}),
          back ? btn('Back', back, 'btn') : (done ? null : btn('Cancel', () => m.close(), 'btn')),
          next ? btn(nextLabel, next, 'btn primary' + (nextEnabled ? '' : ' disabled')) : null)),
    );
  }

  /* --- step 1: get the secrets in --- */
  function stepAdd() {
    const ta = h('textarea', {
      class: 'field mono',
      placeholder: 'DB_PASSWORD=s3cret\nAPI_KEY=abc123\n\nPaste as many lines as you like.',
      rows: '9',
    });
    ta.value = state.text;

    const found = h('div', { class: 'wiz-found' });
    const more = h('div', { class: 'wiz-more', hidden: true });

    const renderFound = () => {
      found.replaceChildren();
      const f = state.found;
      if (!state.text.trim() && !state.file && !state.command) {
        found.append(h('span', { class: 'dim', text: 'Nothing added yet.' }));
      } else if (f.count === 0) {
        found.append(h('span', { class: 'bad',
          text: "Couldn't find anything that looks like NAME=value. Check the lines above." }));
      } else {
        found.append(h('span', { class: 'good', text: `Found ${f.count} value${f.count === 1 ? '' : 's'}: ` }),
          h('span', { text: f.keys.slice(0, 6).join(', ') + (f.keys.length > 6 ? `, +${f.keys.length - 6} more` : '') }));
      }
      updateNext();
    };

    let t = null;
    ta.oninput = () => {
      state.text = ta.value;
      clearTimeout(t);
      t = setTimeout(async () => {
        state.found = await E.envPreview(state.text);
        renderFound();
      }, 200);
    };

    const updateNext = () => {
      const ok = state.found.count > 0 || (state.file && state.fileMode === 'live')
        || state.command || state.instructions || state.preprompt;
      const b = m.card.querySelector('.modal-actions .primary');
      if (b) b.classList.toggle('disabled', !ok);
    };

    /* advanced ways in, hidden until asked for */
    const fileRow = h('div', { class: 'wiz-adv-row' });
    const cmdRow = h('div', { class: 'wiz-adv-row' });

    const renderFile = () => {
      fileRow.replaceChildren(
        btn(state.file ? 'Choose a different file…' : 'Choose a file…', async () => {
          const r = await E.envChooseFile();
          if (!r) return;
          state.file = r.file;
          state.fileFound = r.preview;
          state.found = r.preview.count ? r.preview : state.found;
          renderFile(); renderFound();
        }, 'btn'),
        state.file
          ? h('div', { class: 'wiz-adv-detail' },
              h('div', { text: state.file.split('/').pop() }),
              h('div', { class: 'dim', text: state.fileFound && state.fileFound.count
                ? `${state.fileFound.count} values in this file` : 'No NAME=value lines found in this file' }),
              h('label', { class: 'wiz-check' },
                (() => {
                  const c = h('input', { type: 'checkbox' });
                  c.checked = state.fileMode === 'live';
                  c.onchange = () => { state.fileMode = c.checked ? 'live' : 'snapshot'; };
                  return c;
                })(),
                h('span', { text: 'Keep it linked — if the file changes, sessions get the new values' })),
              btn('Remove', () => { state.file = null; state.fileFound = null; renderFile(); renderFound(); }, 'mini danger'))
          : null);
    };

    const renderCmd = () => {
      const input = h('input', { class: 'field mono', placeholder: 'e.g. vault kv get -format=env secret/my-app' });
      input.value = state.command;
      input.oninput = () => { state.command = input.value; };
      const result = h('div', { class: 'dim' });
      cmdRow.replaceChildren(
        h('p', { class: 'dim small', text: 'Runs each time a session starts, and reads NAME=value from its output. Nothing is stored except the command itself.' }),
        input,
        h('div', { class: 'field-row' },
          btn('Test it', async () => {
            result.textContent = 'Running…';
            const r = await E.envPreviewCommand(state.command, '');
            state.commandFound = r;
            if (r.error) { result.className = 'bad'; result.textContent = r.error; }
            else if (!r.count) { result.className = 'bad'; result.textContent = 'The command ran but produced no NAME=value lines.'; }
            else {
              result.className = 'good';
              result.textContent = `Found ${r.count}: ${r.keys.join(', ')}`;
              state.found = r;
            }
            renderFound();
          }, 'btn'),
          result));
    };

    renderFile(); renderCmd();
    more.append(
      h('h4', { text: 'Use a file' }), fileRow,
      h('h4', { text: 'Run a command (advanced)' }), cmdRow);

    const interpretBox = h('div', { class: 'wiz-interpret' });
    const renderInterpret = (state2) => {
      interpretBox.replaceChildren(
        btn('Sort this out for me', async () => {
          interpretBox.replaceChildren(h('span', { class: 'dim', text: 'Reading it…' }));
          try {
            const r = await E.envInterpret(state.text);
            state.interpreted = r;
            state.found = {
              count: Object.keys(r.variables).length,
              keys: Object.keys(r.variables),
              masked: Object.fromEntries(Object.keys(r.variables).map((k) => [k, '••••••'])),
            };
            state.variables = r.variables;
            state.instructions = r.instructions;
            state.preprompt = r.preprompt;
            if (!state.name) state.name = r.name || '';
            go(1);
          } catch (err) {
            interpretBox.replaceChildren(
              h('span', { class: 'bad', text: String(err && err.message || err)
                .replace(/^Error invoking remote method '[^']+': ?(Error: )?/, '') }),
              btn('Try again', () => renderInterpret(), 'mini'));
          }
        }, 'btn'),
        h('span', { class: 'dim small',
          text: '  Pasted something that is not just NAME=value? A small model sorts it into '
              + 'values, standing rules and an opening prompt. Passwords are replaced with '
              + 'placeholders before anything is sent — they never leave this Mac.' }));
    };
    renderInterpret();

    const moreToggle = btn('More ways to add ▾', () => {
      more.hidden = !more.hidden;
      moreToggle.textContent = more.hidden ? 'More ways to add ▾' : 'Fewer options ▴';
    }, 'linkish');

    renderFound();

    shell({
      title: 'Add context',
      subtitle: 'Paste it exactly as you copied it — from a .env file, a password manager, or a message from a teammate.',
      body: h('div', {},
        h('label', { class: 'field-label', text: 'One per line, as NAME=value' }),
        ta, found, interpretBox, moreToggle, more),
      next: () => {
        const ok = state.found.count > 0 || (state.file && state.fileMode === 'live')
          || state.command || state.instructions || state.preprompt;
        if (ok) go(1);
      },
    });
    ta.focus();
    updateNext();
  }

  /* --- step 2: show exactly what will be stored --- */
  function stepReview() {
    const f = state.found;
    const table = h('table', { class: 'env-vars' });
    table.append(h('thead', {}, h('tr', {},
      h('th', { text: 'Name' }), h('th', { text: 'Value' }))));
    const tb = h('tbody');
    for (const k of f.keys) {
      tb.append(h('tr', {}, h('td', { class: 'k', text: k }),
        h('td', { class: 'v', text: (f.masked && f.masked[k]) || '' })));
    }
    table.append(tb);

    const body = h('div', {});
    if (f.keys.length) {
      body.append(h('h4', { class: 'wiz-bucket', text: 'Values' }), table);
    }
    if (state.instructions) {
      body.append(h('h4', { class: 'wiz-bucket', text: 'Standing instructions' }),
        h('p', { class: 'wiz-quote', text: state.instructions }),
        h('p', { class: 'dim small', text: 'Rules the agent follows all session, without appearing in the conversation.' }));
    }
    if (state.preprompt) {
      body.append(h('h4', { class: 'wiz-bucket', text: 'Opening prompt' }),
        h('p', { class: 'wiz-quote', text: state.preprompt }),
        h('p', { class: 'dim small', text: 'Sent as the first message each time a session starts.' }));
    }
    if (!f.keys.length && !state.instructions && !state.preprompt) {
      body.append(h('p', { class: 'dim', text: 'These will be read when a session starts.' }));
    }
    if (state.file) body.append(h('p', { class: 'dim small', text: `From file: ${state.file}` }));
    if (state.command) body.append(h('p', { class: 'dim small', text: `From command: ${state.command}` }));
    if (state.interpreted && state.interpreted.notes) {
      body.append(h('p', { class: 'dim small', text: `Note from the model: ${state.interpreted.notes}` }));
    }
    if (state.interpreted && state.interpreted.unknown.length) {
      body.append(h('div', { class: 'env-warn',
        text: `Dropped ${state.interpreted.unknown.join(', ')} — the model referred to a value that was not in your paste.` }));
    }

    shell({
      title: state.interpreted ? 'Here is what it made of that' : 'Check what was found',
      subtitle: state.interpreted
        ? 'Change anything that looks wrong after saving — nothing is fixed.'
        : 'Values are hidden here for safety — you can reveal them any time.',
      body,
      back: () => go(0),
      next: () => {
        if (!state.name) {
          state.name = state.file
            ? state.file.split('/').pop().replace(/^\./, '').replace(/\.env$/, '') || 'my secrets'
            : '';
        }
        go(2);
      },
    });
  }

  /* --- step 3: name it --- */
  function stepName() {
    const input = h('input', { class: 'field', placeholder: 'e.g. Stage database' });
    input.value = state.name;
    input.oninput = () => {
      state.name = input.value;
      const b = m.card.querySelector('.modal-actions .primary');
      if (b) b.classList.toggle('disabled', !state.name.trim());
    };
    const next = () => { if (state.name.trim()) go(3); };
    input.onkeydown = (e) => { if (e.key === 'Enter') next(); };

    shell({
      title: 'Give these a name',
      subtitle: "Something you'll recognise later, like “Stage database” or “AWS production”.",
      body: h('div', {}, h('label', { class: 'field-label', text: 'Name' }), input),
      back: () => go(1),
      next,
      nextEnabled: !!state.name.trim(),
    });
    input.focus();
  }

  /* --- step 4: who gets them --- */
  async function stepProjects() {
    let projects = await E.listProjects();

    // The project you are looking at is almost always the one you mean, so
    // pre-tick it and put it first -- otherwise it is lost in a long list and
    // the context silently applies to nothing.
    const current = typeof activeProjectCwd === 'function' ? activeProjectCwd() : null;
    if (current) {
      if (!state.touchedProjects) { state.projects.add(current); state.touchedProjects = true; }
      projects = [...projects].sort((a, b) => (b.cwd === current) - (a.cwd === current));
    }

    const list = h('div', {});
    if (!projects.length) {
      list.append(h('p', { class: 'dim',
        text: 'No projects yet. Save this now, then tick the project once you open one.' }));
    }
    for (const p of projects) {
      const c = h('input', { type: 'checkbox' });
      c.checked = state.projects.has(p.cwd);
      c.onchange = () => { c.checked ? state.projects.add(p.cwd) : state.projects.delete(p.cwd); };
      const row = h('label', { class: 'env-proj' + (p.cwd === current ? ' current' : '') }, c,
        h('span', { text: p.name }), h('span', { class: 'path', text: p.cwd }));
      if (p.cwd === current) row.append(h('span', { class: 'env-chip', text: 'open now' }));
      list.append(row);
    }

    shell({
      title: 'Which projects should use these?',
      subtitle: 'Every session you start in a ticked project will get this context. You can change this any time.',
      body: list,
      back: () => go(2),
      nextLabel: 'Save',
      next: async () => {
        try {
          state.saved = await E.envCreateFrom({
            name: state.name.trim(),
            // when the model sorted it, store its buckets instead of the raw blob
            text: state.interpreted ? '' : state.text,
            variables: state.interpreted ? state.variables : undefined,
            instructions: state.instructions,
            preprompt: state.preprompt,
            file: state.file,
            fileMode: state.fileMode,
            command: state.command,
            projects: [...state.projects],
          });
          go(4);
        } catch (err) {
          shell({
            title: "Couldn't save",
            subtitle: String(err && err.message || err).replace(/^Error invoking remote method '[^']+': ?/, ''),
            body: h('p', { class: 'dim', text: 'Nothing was saved. Go back and check the values.' }),
            back: () => go(3),
          });
        }
      },
    });
  }

  /* --- step 5: confirmation --- */
  function stepDone() {
    const s = state.saved || { name: state.name, count: 0 };
    const n = state.projects.size;
    shell({
      title: 'Saved',
      subtitle: `“${s.name}” now holds ${s.count} value${s.count === 1 ? '' : 's'}.`,
      body: h('div', {},
        h('p', { class: 'modal-text', text: n
          ? `Sessions you start in ${n} project${n === 1 ? '' : 's'} will get them automatically.`
          : 'Tick a project in the Context screen to start using it.' }),
        h('p', { class: 'dim small', text: 'Stored encrypted on this Mac. The agent and any command it runs can read these values, so only keep what those projects need.' })),
      done: true,
    });
    refreshSecretsSidebar();
  }

  function render() { STEPS[state.step](); }
  render();
}

/* ------------------------------------------------------------- manager panel */

async function toggleEnv(force) {
  open = force === undefined ? !open : force;
  panel.hidden = !open;
  if (open) await refreshEnv();
  else revealed.clear();
}

async function refreshEnv() {
  const status = await E.envStatus();
  const badge = q('#env-crypto');
  if (status.available) {
    badge.className = 'ok';
    badge.textContent = 'Stored encrypted on this Mac';
  } else {
    badge.className = 'warn';
    badge.textContent = 'NOT ENCRYPTED — macOS Keychain unavailable';
  }
  badge.title = status.file;

  sets = (await E.envList()).filter(Boolean);
  if (!sets.some((s) => s.id === selectedId)) selectedId = sets.length ? sets[0].id : null;
  renderSetList();
  await renderDetail();
  refreshSecretsSidebar();
}

function summarise(s) {
  const bits = [];
  if (s.count) bits.push(`${s.count} value${s.count === 1 ? '' : 's'}`);
  if (s.instructionCount) bits.push('instructions');
  if (s.prePromptCount) bits.push('opening prompt');
  return bits.length ? bits.join(' · ') : 'empty';
}

function renderSetList() {
  const ul = q('#env-sets');
  ul.replaceChildren();
  for (const s of sets) {
    const li = h('li', { class: 'row' + (s.id === selectedId ? ' active' : '') },
      h('div', { class: 'row-text' },
        h('div', { class: 'row-title', text: s.name }),
        h('div', { class: 'row-sub', text: summarise(s) })));
    if (s.warnings.length) li.append(h('span', { class: 'dot needs_input', title: s.warnings.join('\n') }));
    li.onclick = async () => { selectedId = s.id; renderSetList(); await renderDetail(); };
    ul.append(li);
  }
  if (!sets.length) ul.append(h('p', { class: 'row-sub', text: 'Nothing saved yet.' }));
}

async function renderDetail() {
  detail.replaceChildren();
  if (!selectedId) {
    detail.append(h('div', { id: 'env-empty' },
      h('h2', { text: 'Nothing here yet' }),
      h('p', { text: 'Add information once — API keys, database passwords, service URLs — and your agent will have it in the projects you choose.' }),
      btn('Add context', startWizard, 'btn primary big')));
    return;
  }

  const set = await E.envDescribe(selectedId);
  if (!set) { await refreshEnv(); return; }

  /* name */
  const name = h('input', { class: 'env-name-input', value: set.name });
  name.onchange = async () => { await E.envRename(set.id, name.value.trim() || 'untitled'); await refreshEnv(); };
  detail.append(h('section', {}, h('h3', { text: 'Name' }), name));

  if (set.warnings.length) {
    const box = h('section', {});
    for (const w of set.warnings) box.append(h('div', { class: 'env-warn', text: w }));
    detail.append(box);
  }

  /* the secrets themselves */
  const vs = h('section', {}, h('h3', { text: `Values (${set.count})` }));
  if (set.count) {
    const table = h('table', { class: 'env-vars' });
    table.append(h('thead', {}, h('tr', {},
      h('th', { text: 'Name' }), h('th', { text: 'Value' }),
      h('th', { text: 'Comes from' }), h('th', { text: '' }))));
    const tb = h('tbody');
    for (const k of set.keys) {
      const rk = `${set.id}\0${k}`;
      const isOpen = revealed.has(rk);
      const cell = h('td', { class: 'v', text: isOpen ? '…' : (set.masked[k] || '(empty)') });
      if (isOpen) E.envReveal(set.id, k).then((v) => { cell.textContent = v === null ? '(gone)' : v; });
      tb.append(h('tr', {},
        h('td', { class: 'k', text: k }), cell,
        h('td', { class: 'o', text: set.origins[k] || '' }),
        h('td', { class: 'a' },
          btn(isOpen ? 'hide' : 'reveal', async () => {
            isOpen ? revealed.delete(rk) : revealed.add(rk);
            await renderDetail();
          }),
          btn('edit', async () => {
            const current = await E.envReveal(set.id, k);
            const next = await textDialog('Edit value', k,
              { value: current === null ? '' : current, label: 'Value', secret: true });
            if (next === null) return;
            await E.envSetVar(set.id, k, next);
            await refreshEnv();
          }),
          btn('delete', async () => {
            if (!await confirmDialog('Delete this value?', `${k} will be removed from “${set.name}”.`, 'Delete')) return;
            await E.envRemoveVar(set.id, k);
            await refreshEnv();
          }, 'mini danger'))));
    }
    table.append(tb);
    vs.append(table);
  } else {
    vs.append(h('p', { class: 'dim', text: 'Nothing resolved yet.' }));
  }

  vs.append(h('div', { class: 'env-add-row' },
    btn('Add one by hand', async () => {
      const key = await textDialog('Add a value', 'The name is what the agent will see, e.g. DB_PASSWORD.',
        { label: 'Name', okLabel: 'Next' });
      if (!key || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key.trim())) {
        if (key !== null) await confirmDialog('That name will not work',
          'Use letters, numbers and underscores, starting with a letter — like DB_PASSWORD.', 'OK');
        return;
      }
      const value = await textDialog('Add a value', key.trim(), { label: 'Value', secret: true });
      if (value === null) return;
      await E.envSetVar(set.id, key.trim(), value);
      await refreshEnv();
    }, 'btn'),
    btn('Paste more', () => startWizard(), 'btn'),
    btn('Standing instructions', () => editTextSource(set, 'instructions'), 'btn'),
    btn('Opening prompt', () => editTextSource(set, 'preprompt'), 'btn')));
  detail.append(vs);

  /* the two prose kinds behave very differently, so say which is which */
  if (set.instructionCount) {
    const ins = h('section', {}, h('h3', { text: 'Standing instructions' }));
    for (const t of set.instructions) {
      ins.append(h('div', { class: 'env-src' }, h('span', { class: 'grow', text: t })));
    }
    ins.append(h('p', { class: 'dim small',
      text: 'Rules the agent follows for the whole session. Not shown in the conversation.' }));
    detail.append(ins);
  }

  if (set.prePromptCount) {
    const pp = h('section', {}, h('h3', { text: 'Opening prompt' }));
    for (const t of set.prePrompts) {
      pp.append(h('div', { class: 'env-src' }, h('span', { class: 'grow', text: t })));
    }
    pp.append(h('p', { class: 'dim small',
      text: 'Sent as the first message when the session starts. The agent answers it right away, '
          + 'then the session carries on as normal.' }));
    detail.append(pp);
  }

  /* where they come from */
  const src = h('section', {}, h('h3', { text: 'Where these come from' }));
  for (const s of set.sources) {
    src.append(h('div', { class: 'env-src' },
      h('span', { class: 'tag', text: s.type === 'inline' ? 'typed in' : s.type === 'file' ? 'file' : 'command' }),
      h('span', { class: 'grow', text: s.label }),
      s.type === 'file'
        ? btn(s.mode === 'live' ? 'linked — updates automatically' : 'copied once', async () => {
            await E.envUpdateSource(set.id, s.id, { mode: s.mode === 'live' ? 'snapshot' : 'live' });
            await refreshEnv();
          })
        : null,
      btn('remove', async () => {
        if (!await confirmDialog('Remove this source?', s.label, 'Remove')) return;
        await E.envRemoveSource(set.id, s.id);
        await refreshEnv();
      }, 'mini danger')));
  }
  detail.append(src);

  /* bindings */
  const projects = await E.listProjects();
  const bind = h('section', {}, h('h3', { text: 'Projects using this' }));
  if (!projects.length) bind.append(h('p', { class: 'dim', text: 'No projects yet.' }));
  for (const p of projects) {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = (p.envSetIds || []).includes(set.id);
    cb.onchange = async () => {
      const ids = new Set(p.envSetIds || []);
      cb.checked ? ids.add(set.id) : ids.delete(set.id);
      await E.bindEnvSets(p.cwd, [...ids]);
      if (typeof refreshProjects === 'function') refreshProjects();
    };
    bind.append(h('label', { class: 'env-proj' }, cb,
      h('span', { text: p.name }), h('span', { class: 'path', text: p.cwd })));
  }
  detail.append(bind);

  detail.append(h('section', {},
    btn(`Delete “${set.name}”`, async () => {
      if (!await confirmDialog('Delete this context?',
        `“${set.name}” and its ${set.count} value${set.count === 1 ? '' : 's'} will be removed from this Mac. This cannot be undone.`,
        'Delete')) return;
      await E.envRemove(set.id);
      selectedId = null;
      if (typeof refreshProjects === 'function') refreshProjects();
      await refreshEnv();
    }, 'mini danger')));
}


/**
 * Editor for the two prose source kinds.
 *   instructions -> --append-system-prompt : standing rules, invisible
 *   preprompt    -> claude's [prompt] arg  : an opening message, answered once
 */
function editTextSource(set, kind) {
  const existing = set.sources.find((x) => x.type === kind);
  const isPrompt = kind === 'preprompt';

  const ta = h('textarea', { class: 'field mono', placeholder: isPrompt
    ? 'e.g. Summarise the open MRs on this service and list anything blocking release.'
    : 'e.g. This service uses Oracle. Always use the stage config, never prod.' });
  ta.value = existing ? (existing.text || '') : '';

  const m = openModal({
    title: isPrompt ? 'Opening prompt' : 'Standing instructions',
    subtitle: isPrompt
      ? 'Sent as the first message every time a session starts with this context. The agent answers it, then you carry on.'
      : 'Rules the agent follows for the whole session, without appearing in the conversation. Not for credentials — those belong in values.',
    body: h('div', {}, ta,
      h('p', { class: 'dim small', text: isPrompt
        ? 'Runs on every new session and on restart, so keep it something worth repeating.'
        : 'Passed in the process arguments, which other programs of yours can see. Keep secrets out of it.' })),
    wide: true,
    footer: h('div', { class: 'modal-actions' },
      existing ? btn('Remove', async () => {
        m.close();
        await E.envRemoveSource(set.id, existing.id);
        await refreshEnv();
      }, 'btn danger') : null,
      btn('Cancel', () => m.close(), 'btn'),
      btn('Save', async () => {
        m.close();
        if (existing) await E.envUpdateSource(set.id, existing.id, { text: ta.value });
        else await E.envAddSource(set.id, { type: kind, text: ta.value });
        await refreshEnv();
      }, 'btn primary')),
  });
  ta.focus();
}

/* ---------------------------------------------------------- general context */

/**
 * General context = the global CLAUDE.md every session reads at startup.
 * This edits a file the user already depends on, so every save goes through a
 * diff and an explicit confirmation, and the main process keeps a backup.
 */
let generalLoaded = null;   // { file, content, mtime, exists }

async function loadGeneral() {
  generalLoaded = await E.generalRead();
  q('#general-text').value = generalLoaded.content;
  const info = q('#general-info');
  info.replaceChildren(
    h('div', {}, h('span', { text: 'Rules every session with this agent starts with. Stored in ' }),
      h('code', { text: generalLoaded.file })),
    h('div', { text: generalLoaded.exists
      ? `${generalLoaded.lines} lines. Sessions already running keep the rules they started with.`
      : 'This file does not exist yet — saving will create it.' }));
  q('#general-status').textContent = '';
}

function renderDiff(hunks) {
  const box = h('div', { class: 'diff' });
  // collapse long runs of unchanged lines so the real change is visible
  let run = 0;
  const flush = () => {
    if (run > 6) box.append(h('div', { class: 'gap', text: `⋯ ${run - 6} unchanged lines ⋯` }));
    run = 0;
  };
  const kept = [];
  hunks.forEach((x, i) => {
    const near = hunks.slice(Math.max(0, i - 3), i + 4).some((y) => y.type !== 'same');
    kept.push({ ...x, show: x.type !== 'same' || near });
  });
  for (const x of kept) {
    if (!x.show) { run++; continue; }
    flush();
    const sign = x.type === 'added' ? '+ ' : x.type === 'removed' ? '- ' : '  ';
    box.append(h('div', { class: x.type, text: sign + x.text }));
  }
  flush();
  return box;
}

async function saveGeneral() {
  const next = q('#general-text').value;
  const pv = await E.generalPreview(next);

  if (pv.unchanged) {
    q('#general-status').textContent = 'No changes to save.';
    return;
  }

  // The confirmation box: what changes, and that it affects every session.
  const body = h('div', {},
    h('p', { class: 'diff-summary' },
      h('span', { class: 'good', text: `+${pv.added} added` }),
      h('span', { text: '   ' }),
      h('span', { class: 'bad', text: `−${pv.removed} removed` })),
    renderDiff(pv.hunks),
    h('p', { class: 'dim small',
      text: 'This changes the rules for every session you start with this agent from now on. '
          + 'Sessions already running keep the rules they started with until you restart them. '
          + 'The current version is backed up first.' }));

  const m = openModal({
    title: 'Update the rules for every session?',
    subtitle: generalLoaded.file,
    body, wide: true,
    footer: h('div', { class: 'modal-actions' },
      btn('Cancel', () => m.close(), 'btn'),
      btn('Save changes', async () => {
        m.close();
        try {
          const r = await E.generalWrite(next, generalLoaded.mtime);
          generalLoaded = r;
          q('#general-status').textContent = r.backup
            ? 'Saved. Previous version kept in Earlier versions.'
            : 'Saved.';
        } catch (err) {
          const msg = String(err && err.message || err)
            .replace(/^Error invoking remote method '[^']+': ?(Error: )?/, '');
          await confirmDialog('Not saved', msg, 'OK');
          await loadGeneral();
        }
      }, 'btn primary')),
  });
}

async function showBackups() {
  const list = await E.generalBackups();
  const body = h('div', {});
  if (!list.length) body.append(h('p', { class: 'dim', text: 'No earlier versions yet.' }));
  for (const b of list) {
    const when = b.name.replace('CLAUDE.md.', '').replace(/-/g, ':').replace('T', '  ').slice(0, 19);
    body.append(h('div', { class: 'env-src' },
      h('span', { class: 'grow', text: when }),
      btn('Restore', async () => {
        m.close();
        if (!await confirmDialog('Restore this version?',
          'Your current rules will be replaced, and backed up first.', 'Restore')) return;
        await E.generalRestore(b.name);
        await loadGeneral();
        q('#general-status').textContent = 'Restored.';
      })));
  }
  const m = openModal({
    title: 'Earlier versions',
    subtitle: 'Seamux keeps a copy each time you save.',
    body,
    footer: h('div', { class: 'modal-actions' }, btn('Close', () => m.close(), 'btn')),
  });
}

function switchTab(name) {
  for (const b of document.querySelectorAll('#env-tabs button')) {
    b.classList.toggle('on', b.dataset.tab === name);
  }
  q('#env-body').hidden = name !== 'session';
  q('#general-body').hidden = name !== 'general';
  q('#env-crypto').hidden = name !== 'session';
  if (name === 'general') loadGeneral();
}

/* --------------------------------------------------------- sidebar shortcut */

async function refreshSecretsSidebar() {
  const ul = q('#secrets-list');
  if (!ul) return;
  const all = (await E.envList()).filter(Boolean);
  ul.replaceChildren();
  for (const s of all) {
    const li = h('li', { class: 'row' },
      h('span', { class: 'dot idle' }),
      h('div', { class: 'row-text' },
        h('div', { class: 'row-title', text: s.name }),
        h('div', { class: 'row-sub', text: `${s.count} value${s.count === 1 ? '' : 's'}` })));
    li.title = 'Open the Context screen';
    li.onclick = async () => { selectedId = s.id; await toggleEnv(true); };
    ul.append(li);
  }
  if (!all.length) {
    const li = h('li', { class: 'row' },
      h('div', { class: 'row-text' },
        h('div', { class: 'row-sub', text: 'None yet — click + to add' })));
    li.onclick = startWizard;
    ul.append(li);
  }
}

/* --------------------------------------------------------------------- wire */

for (const b of document.querySelectorAll('#env-tabs button')) {
  b.onclick = () => switchTab(b.dataset.tab);
}
q('#general-save').onclick = saveGeneral;
q('#general-revert').onclick = () => loadGeneral();
q('#general-backups').onclick = showBackups;

q('#env-new').onclick = startWizard;
q('#secrets-new').onclick = startWizard;
q('#env-close').onclick = () => toggleEnv(false);
E.onToggleEnv(() => toggleEnv());
refreshSecretsSidebar();

/**
 * Pick context for ONE session. Resolves to the chosen ids, or null if
 * cancelled. Context belongs to the session, so this is the primary control;
 * the project binding only decides what is ticked when a session starts.
 */
function chooseContext(currentIds) {
  return new Promise(async (resolve) => {
    const all = (await E.envList()).filter(Boolean);
    const chosen = new Set(currentIds || []);
    const list = h('div', {});

    if (!all.length) {
      list.append(h('p', { class: 'dim', text: 'No context saved yet.' }),
        btn('Add context', () => { m.close(); resolve(null); startWizard(); }, 'btn primary big'));
    }
    for (const set of all) {
      const c = h('input', { type: 'checkbox' });
      c.checked = chosen.has(set.id);
      c.onchange = () => { c.checked ? chosen.add(set.id) : chosen.delete(set.id); };
      list.append(h('label', { class: 'env-proj' }, c,
        h('span', { text: set.name }),
        h('span', { class: 'path', text: `${set.count} value${set.count === 1 ? '' : 's'}` })));
    }

    const m = openModal({
      title: 'Context for this session',
      subtitle: 'A running session keeps the environment it started with, so changing this asks you to restart the session.',
      body: list,
      footer: h('div', { class: 'modal-actions' },
        btn('Cancel', () => { m.close(); resolve(null); }, 'btn'),
        btn('Apply', () => { m.close(); resolve([...chosen]); }, 'btn primary')),
    });
  });
}

/**
 * Pick which agent a project uses. Seamux drives any interactive CLI; the
 * profile decides the command, how instructions and an opening prompt are
 * passed, and which global-rules file the General tab edits.
 */
function chooseProfile(currentId) {
  return new Promise(async (resolve) => {
    const all = await E.profilesList();
    const list = h('div', {});
    for (const p of all) {
      const row = h('label', { class: 'env-proj' + (p.id === currentId ? ' current' : '') },
        (() => { const r = h('input', { type: 'radio', name: 'seamux-profile' });
          r.checked = p.id === currentId;
          r.onchange = () => { chosen = p.id; };
          return r; })(),
        h('span', { text: p.label }),
        h('span', { class: 'path', text: p.command }));
      if (!p.verified) row.append(h('span', { class: 'env-chip pending', text: 'unverified' }));
      if (p.unsupported.length) {
        row.append(h('span', { class: 'path', text: `no ${p.unsupported.join('/')}` }));
      }
      list.append(row);
      if (p.unverifiedNote) list.append(h('p', { class: 'dim small', text: p.unverifiedNote }));
    }
    let chosen = currentId || 'claude';

    const m = openModal({
      title: 'Which agent runs in this project?',
      subtitle: 'Seamux drives any interactive CLI. The agent decides how context is passed and which rules file the General tab edits.',
      body: list,
      footer: h('div', { class: 'modal-actions' },
        btn('Cancel', () => { m.close(); resolve(null); }, 'btn'),
        btn('Use this agent', () => { m.close(); resolve(chosen); }, 'btn primary')),
    });
  });
}

window.__envUI = {
  chooseProfile,
  toggleEnv, refreshEnv, startWizard, refreshSecretsSidebar, chooseContext,
  switchTab, loadGeneral, saveGeneral,
  get selectedSetId() { return selectedId; },
};

})();
