'use strict';

/* global H, panes, activate, addPane, activeId */

// The board: one lane per project, one column per status, one card per task.
// A card owns at most one terminal; opening a running card shows that
// terminal. Wrapped in a function so its names never collide with the other
// classic scripts on the page.
(function () {
  const UI = () => window.__envUI;
  // renderer.js declares activeId with let: shared by name, not on window.
  const currentId = () => (typeof activeId === 'undefined' ? null : activeId);
  const root = document.querySelector('#boardview');
  const lanesEl = document.querySelector('#board-lanes');
  const barEl = document.querySelector('#board-bar');
  const toggleBtn = document.querySelector('#toggle-board');

  const COLUMNS = [
    { id: 'backlog', label: 'Backlog', optional: true },
    { id: 'ready', label: 'Ready' },
    { id: 'queued', label: 'Queued' },
    { id: 'active', label: 'In progress' },
    { id: 'review', label: 'Review' },
    { id: 'done', label: 'Done', optional: true },
  ];
  const MOVABLE = ['backlog', 'ready', 'active', 'review', 'done'];

  let snap = { projects: [], tasks: [], globalLimit: 8, liveTotal: 0 };
  let visible = false;
  let selectedId = null;
  let profiles = [];
  const shown = { backlog: false, done: false };

  /* ------------------------------------------------------------ helpers */

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

  function age(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '';
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'now';
    if (m < 60) return `${m}m`;
    const hr = Math.floor(m / 60);
    if (hr < 48) return `${hr}h`;
    return `${Math.floor(hr / 24)}d`;
  }

  function agentLabel(task) {
    const project = snap.projects.find((p) => p.cwd === task.cwd);
    const id = task.agent || (project && project.profileId) || 'claude';
    const p = profiles.find((x) => x.id === id);
    return p ? p.label : id;
  }

  /** Live state of a task's pane, preferring the renderer's freshest copy. */
  function paneState(task) {
    if (!task.pane) return null;
    const live = panes.get(task.pane.id);
    const m = live ? live.meta : task.pane;
    return { id: task.pane.id, state: m.exited ? 'exited' : m.state, reason: m.reason };
  }

  function nextLine(task, ps) {
    if (task.status === 'queued') return ['Waiting', 'a free slot'];
    if (ps) {
      if (ps.state === 'needs_input') return ['Asks', ps.reason || 'your input'];
      if (ps.state === 'exited') return ['Ended', 'the terminal closed'];
      if (ps.state === 'running') return ['Working', ps.reason || ''];
      if (ps.state === 'idle') return ['Your move', 'the agent is at its prompt'];
    }
    if (task.sessionId && (task.status === 'ready' || task.status === 'backlog')) return ['Resume', 'continues its conversation'];
    if (task.brief) return ['Brief', task.brief.split('\n')[0]];
    return null;
  }

  function columnsShown() { return COLUMNS.filter((c) => !c.optional || shown[c.id]); }

  /* ------------------------------------------------------------- render */

  function render() {
    renderBar();
    const cols = columnsShown();
    // Columns share the width; below 180px each, the board scrolls sideways.
    lanesEl.style.gridTemplateColumns = `170px repeat(${cols.length}, minmax(180px, 1fr))`;
    lanesEl.style.minWidth = `${170 + cols.length * 180}px`;
    lanesEl.replaceChildren();

    lanesEl.append(h('div', { class: 'b-corner' }));
    for (const c of cols) {
      const count = snap.tasks.filter((t) => t.status === c.id).length;
      lanesEl.append(h('div', { class: 'b-colhead' }, h('span', { text: c.label }), h('span', { class: 'b-count', text: String(count) })));
    }

    if (!snap.projects.length) {
      lanesEl.append(h('div', { class: 'b-empty', style: `grid-column: 1 / span ${cols.length + 1}` },
        h('p', { text: 'No projects yet. Add one, then add tasks to it.' }),
        h('button', { class: 'btn primary', text: 'Add a project…', onclick: addProject })));
      return;
    }

    for (const p of snap.projects) {
      const tasks = snap.tasks.filter((t) => t.cwd === p.cwd).sort((a, b) => (a.order || 0) - (b.order || 0));
      const atLimit = p.live >= p.limit;
      const backlog = tasks.filter((t) => t.status === 'backlog').length;
      const done = tasks.filter((t) => t.status === 'done').length;
      lanesEl.append(h('div', { class: 'b-lanehead', 'data-cwd': p.cwd },
        h('div', { class: 'b-lanename', text: p.name, title: p.cwd }),
        h('button', {
          class: 'b-limit' + (atLimit ? ' at' : ''),
          text: `${p.live} / ${p.limit}`,
          title: 'Live task terminals / limit for this project. Click to change the limit.',
          onclick: () => editLimit(p),
        }),
        h('div', { class: 'b-lanesub', text: `backlog ${backlog} · done ${done}` }),
        h('button', { class: 'mini', text: '+ Task', onclick: () => taskDialog({ cwd: p.cwd }) })));

      for (const c of cols) {
        const cell = h('div', { class: 'b-cell', 'data-cwd': p.cwd, 'data-status': c.id });
        cell.ondragover = (e) => {
          if (dragging && dragging.cwd === p.cwd && MOVABLE.includes(c.id)) { e.preventDefault(); cell.classList.add('drop'); }
        };
        cell.ondragleave = () => cell.classList.remove('drop');
        cell.ondrop = (e) => {
          e.preventDefault();
          cell.classList.remove('drop');
          if (dragging && dragging.cwd === p.cwd && dragging.status !== c.id) move(dragging.id, c.id);
        };
        for (const t of tasks.filter((x) => x.status === c.id)) cell.append(card(t));
        lanesEl.append(cell);
      }
    }
    const sel = selectedId && lanesEl.querySelector(`[data-task="${selectedId}"]`);
    if (sel) sel.classList.add('selected');
  }

  function renderBar() {
    const needs = snap.tasks.filter((t) => { const ps = paneState(t); return ps && ps.state === 'needs_input'; }).length;
    barEl.replaceChildren(...[
      h('strong', { text: 'Board' }),
      h('button', {
        class: 'b-limit' + (snap.liveTotal >= snap.globalLimit ? ' at' : ''),
        text: `terminals ${snap.liveTotal} / ${snap.globalLimit}`,
        title: 'Live task terminals across all projects / overall limit. Click to change.',
        onclick: editGlobalLimit,
      }),
      h('span', { class: 'spacer' }),
      ...['backlog', 'done'].map((id) => h('button', {
        class: 'mini' + (shown[id] ? ' on' : ''),
        text: id === 'backlog' ? 'Backlog' : 'Done',
        title: `Show or hide the ${id === 'backlog' ? 'Backlog' : 'Done'} column`,
        onclick: () => { shown[id] = !shown[id]; render(); },
      })),
      needs ? h('button', { class: 'b-needs', text: `${needs} need${needs === 1 ? 's' : ''} you · ⌘J`, onclick: nextNeeds }) : null,
      h('button', { class: 'mini', text: '+ Project', onclick: addProject }),
      h('button', { class: 'btn primary', text: 'New task', title: 'New task (⌘N)', onclick: () => taskDialog({}) }),
    ].filter(Boolean));   // a missing item must not print as "null"
  }

  let dragging = null;

  function card(t) {
    const ps = paneState(t);
    const line = nextLine(t, ps);
    const dot = ps ? ps.state : (t.status === 'queued' ? 'queued' : 'none');
    const el = h('div', {
      class: 'b-card' + (ps && ps.state === 'needs_input' ? ' needs' : ''),
      draggable: 'true',
      'data-task': t.id,
      tabindex: '-1',
    },
      h('div', { class: 'b-title', text: t.title }),
      h('div', { class: 'b-row' },
        h('span', { class: `dot ${dot}` }),
        h('span', { class: 'b-agent', text: agentLabel(t) }),
        h('span', { class: 'b-age', text: age(t.statusAt) })),
      line ? h('div', { class: 'b-next' }, h('b', { text: `${line[0]}: ` }), document.createTextNode(line[1])) : null,
      actions(t, ps));
    el.onclick = () => select(t.id);
    el.ondblclick = () => open(t.id);
    el.ondragstart = (e) => { dragging = t; e.dataTransfer.setData('text/plain', t.id); el.classList.add('dragging'); };
    el.ondragend = () => { dragging = null; el.classList.remove('dragging'); };
    return el;
  }

  function actions(t, ps) {
    const row = h('div', { class: 'b-actions' });
    const live = ps && ps.state !== 'exited';
    if (live) {
      row.append(h('button', { class: 'mini', text: 'Open', onclick: (e) => { e.stopPropagation(); open(t.id); } }));
    } else if (t.status !== 'queued') {
      const resume = !!t.sessionId;
      row.append(h('button', {
        class: 'mini',
        text: resume ? 'Resume' : 'Start',
        title: resume ? 'Start its terminal and continue the same conversation' : 'Start a terminal for this task (S)',
        onclick: (e) => { e.stopPropagation(); start(t.id); },
      }));
    }
    row.append(h('button', { class: 'mini', text: 'Edit', onclick: (e) => { e.stopPropagation(); taskDialog(t); } }));
    return row;
  }

  /* ------------------------------------------------------------ actions */

  async function refresh() {
    snap = await H.boardGet();
    try { profiles = await H.profilesList(); } catch { profiles = []; }
    render();
  }

  function setVisible(on) {
    visible = on;
    root.hidden = !on;
    toggleBtn.classList.toggle('on', on);
    if (on) { refresh(); root.focus(); }
    else if (currentId() && panes.has(currentId())) requestAnimationFrame(() => panes.get(currentId()).fit.fit());
  }

  function toggle() { setVisible(!visible); }

  function select(id) {
    selectedId = id;
    for (const n of lanesEl.querySelectorAll('.b-card.selected')) n.classList.remove('selected');
    const n = lanesEl.querySelector(`[data-task="${id}"]`);
    if (n) { n.classList.add('selected'); n.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }

  /** Open a task: show its terminal if it has one, otherwise edit it. */
  function open(id) {
    const t = snap.tasks.find((x) => x.id === id);
    if (!t) return;
    if (t.pane && panes.has(t.pane.id)) {
      setVisible(false);
      activate(t.pane.id);
    } else {
      taskDialog(t);
    }
  }

  async function start(id) {
    try {
      const r = await H.boardStart(id);
      if (r && r.pane && !panes.has(r.pane.id)) addPane(r.pane);
      if (r && r.status === 'queued') flash(`Queued: ${r.reason}. It starts when a slot frees up.`);
    } catch (err) {
      flash(`Could not start: ${err.message || err}`);
    }
  }

  async function move(id, status) {
    try {
      const r = await H.boardMove(id, status);
      if (r && r.pane && !panes.has(r.pane.id)) addPane(r.pane);
      if (r && r.status === 'queued') flash(`Queued: ${r.reason}.`);
    } catch (err) {
      flash(`Could not move: ${err.message || err}`);
    }
  }

  async function addProject() {
    const p = await H.pickProject();
    if (!p) return;
    await refresh();
    if (typeof window.refreshProjects === 'function') window.refreshProjects();
  }

  let flashTimer = null;
  function flash(text) {
    const n = document.querySelector('#board-flash');
    n.textContent = text;
    n.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { n.hidden = true; }, 4000);
  }

  function nextNeeds() {
    const ids = [];
    for (const [id, p] of panes) if (p.meta.state === 'needs_input') ids.push(id);
    if (!ids.length) { if (visible) flash('Nothing needs you right now.'); return; }
    const cur = ids.indexOf(currentId());
    const next = ids[(cur + 1) % ids.length];
    setVisible(false);
    activate(next);
  }

  /* ------------------------------------------------------------ dialogs */

  function taskDialog(task) {
    const isNew = !task.id;
    const projects = snap.projects;
    if (!projects.length) { addProject(); return; }
    const cwd0 = task.cwd || (currentId() && panes.get(currentId()) && panes.get(currentId()).meta.cwd) || projects[0].cwd;

    const project = h('select', { class: 'field', id: 'task-project' },
      ...projects.map((p) => { const o = h('option', { value: p.cwd, text: p.name }); if (p.cwd === cwd0) o.selected = true; return o; }));
    if (!isNew) project.disabled = true;   // a task stays in its project
    const title = h('input', { class: 'field', id: 'task-title', value: task.title || '', placeholder: 'What should get done' });
    const brief = h('textarea', { class: 'field', id: 'task-brief', rows: '6', placeholder: 'Details and acceptance criteria. Sent to the agent as its opening message.' });
    brief.value = task.brief || '';
    const defaultAgent = (p) => {
      const id = (p && p.profileId) || 'claude';
      const prof = profiles.find((x) => x.id === id);
      return `Project default (${prof ? prof.label : id})`;
    };
    const agent = h('select', { class: 'field', id: 'task-agent' },
      h('option', { value: '', text: defaultAgent(projects.find((p) => p.cwd === cwd0)) }),
      ...profiles.map((p) => { const o = h('option', { value: p.id, text: p.label }); if (p.id === task.agent) o.selected = true; return o; }));
    const err = h('p', { class: 'b-err', hidden: true });

    const body = h('div', { class: 'b-form' },
      h('label', { text: 'Project' }), project,
      h('label', { text: 'Title' }), title,
      h('label', { text: 'Brief' }), brief,
      h('label', { text: 'Agent' }), agent,
      err);

    project.onchange = () => { agent.options[0].textContent = defaultAgent(projects.find((p) => p.cwd === project.value)); };
    const read = () => ({ cwd: project.value, title: title.value, brief: brief.value, agent: agent.value || null });
    const fail = (e) => { err.textContent = e.message || String(e); err.hidden = false; };

    const buttons = [h('button', { class: 'btn', text: 'Cancel', onclick: () => m.close() })];
    if (isNew) {
      buttons.push(
        h('button', { class: 'btn', text: 'Add to Backlog', onclick: async () => { try { await H.boardCreate({ ...read(), status: 'backlog' }); m.close(); } catch (e) { fail(e); } } }),
        h('button', { class: 'btn', text: 'Add to Ready', onclick: async () => { try { await H.boardCreate({ ...read(), status: 'ready' }); m.close(); } catch (e) { fail(e); } } }),
        h('button', { class: 'btn primary', text: 'Add and start', onclick: async () => {
          try {
            const t = await H.boardCreate({ ...read(), status: 'ready' });
            m.close();
            await start(t.id);
          } catch (e) { fail(e); }
        } }));
    } else {
      buttons.push(
        h('button', { class: 'btn danger', text: 'Delete', onclick: async () => {
          m.close();
          if (!(await UI().confirmDialog('Delete this task?', `“${task.title}” will be removed from the board.`))) return;
          try { await H.boardRemove(task.id); } catch (e) { flash(e.message || String(e)); }
        } }),
        h('button', { class: 'btn primary', text: 'Save', onclick: async () => {
          try { const r = read(); await H.boardUpdate(task.id, { title: r.title, brief: r.brief, agent: r.agent }); m.close(); } catch (e) { fail(e); }
        } }));
    }

    const m = UI().openModal({
      title: isNew ? 'New task' : 'Edit task',
      subtitle: isNew ? 'Each task gets its own terminal and agent when it starts.' : null,
      body,
      footer: h('div', { class: 'modal-actions' }, ...buttons),
      wide: true,
    });
    requestAnimationFrame(() => title.focus());
  }

  function limitDialog(title, subtitle, value, save) {
    const input = h('input', { class: 'field', id: 'limit-input', type: 'number', min: '1', max: '50', value: String(value) });
    const m = UI().openModal({
      title, subtitle,
      body: input,
      footer: h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', text: 'Cancel', onclick: () => m.close() }),
        h('button', { class: 'btn primary', text: 'Save', onclick: async () => { await save(input.value); m.close(); } })),
    });
    requestAnimationFrame(() => { input.focus(); input.select(); });
  }

  function editLimit(p) {
    limitDialog(`Terminals for ${p.name}`,
      'How many task terminals may run at once in this project. Idle ones count too. Extra tasks wait in Queued.',
      p.limit, (v) => H.boardSetLimit(p.cwd, v));
  }

  function editGlobalLimit() {
    limitDialog('Terminals across all projects',
      'The most task terminals that may run at once, whatever the project. Protects the machine’s memory.',
      snap.globalLimit, (v) => H.boardSetGlobalLimit(v));
  }

  function moveDialog(t) {
    const m = UI().openModal({
      title: `Move “${t.title}”`,
      body: h('div', { class: 'b-movelist' }, ...MOVABLE.map((s) => {
        const label = COLUMNS.find((c) => c.id === s).label;
        return h('button', { class: 'btn' + (s === t.status ? ' disabled' : ''), text: label, onclick: () => { m.close(); move(t.id, s); } });
      })),
      footer: h('div', { class: 'modal-actions' }, h('button', { class: 'btn', text: 'Cancel', onclick: () => m.close() })),
    });
  }

  /* ------------------------------------------------------------ keyboard */

  function grid() {
    // Columns of task ids, left to right, across all lanes.
    return columnsShown().map((c) => [...lanesEl.querySelectorAll(`.b-cell[data-status="${c.id}"] .b-card`)].map((n) => n.dataset.task));
  }

  function step(dx, dy) {
    const g = grid();
    let col = g.findIndex((ids) => ids.includes(selectedId));
    if (col < 0) { const first = g.find((ids) => ids.length); if (first) select(first[0]); return; }
    let row = g[col].indexOf(selectedId);
    if (dy) { row = Math.max(0, Math.min(g[col].length - 1, row + dy)); select(g[col][row]); return; }
    for (let c = col + dx; c >= 0 && c < g.length; c += dx) {
      if (g[c].length) { select(g[c][Math.min(row, g[c].length - 1)]); return; }
    }
  }

  root.addEventListener('keydown', (e) => {
    if (!document.querySelector('#modal-root').hidden) return;
    if (e.target.closest('input, textarea, select')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = snap.tasks.find((x) => x.id === selectedId);
    const keys = {
      ArrowDown: () => step(0, 1), j: () => step(0, 1),
      ArrowUp: () => step(0, -1), k: () => step(0, -1),
      ArrowLeft: () => step(-1, 0), h: () => step(-1, 0),
      ArrowRight: () => step(1, 0), l: () => step(1, 0),
      Enter: () => t && open(t.id),
      s: () => t && start(t.id),
      m: () => t && moveDialog(t),
      e: () => t && taskDialog(t),
      n: () => taskDialog(t ? { cwd: t.cwd } : {}),
    };
    const fn = keys[e.key];
    if (fn) { e.preventDefault(); fn(); }
  });

  /* --------------------------------------------------------------- wire */

  H.onBoardChanged((s) => {
    const grew = s.projects.length !== snap.projects.length;
    snap = s;
    if (visible) render();
    // A task can add a project; keep the sidebar's project list in step.
    if (grew && typeof window.refreshProjects === 'function') window.refreshProjects();
  });

  // Pane states change far more often than the board: repaint at most once a frame.
  let pending = false;
  H.onStatus(() => {
    if (!visible || pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; render(); });
  });

  H.onToggleBoard(toggle);
  H.onNewTask(() => { if (!visible) setVisible(true); taskDialog({}); });
  H.onNextNeeds(nextNeeds);
  toggleBtn.onclick = toggle;

  // Ages on cards drift; refresh them once a minute while the board is open.
  setInterval(() => { if (visible) render(); }, 60000);

  window.__board = { toggle, show: () => setVisible(true), hide: () => setVisible(false), refresh, get visible() { return visible; }, select, start, move, nextNeeds };

  // Open on the board when there is work on it.
  H.boardGet().then((s) => { snap = s; if (s.tasks.length) setVisible(true); });
})();
