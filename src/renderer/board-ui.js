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

  // Running and Needs you are both a task with a live terminal ('active');
  // which one a card sits in follows what its terminal is doing right now.
  const COLUMNS = [
    { id: 'backlog', label: 'Backlog', optional: true },
    { id: 'ready', label: 'Ready' },
    { id: 'queued', label: 'Queued' },
    { id: 'running', label: 'Running', status: 'active' },
    { id: 'needs', label: 'Needs you', status: 'active' },
    { id: 'waiting', label: 'Waiting on others' },
    { id: 'review', label: 'Review' },
    { id: 'done', label: 'Done', optional: true },
  ];
  // Where a card can be sent by hand, with the label the move dialog shows.
  const MOVES = [
    ['backlog', 'Backlog'], ['ready', 'Ready'], ['active', 'Running'],
    ['waiting', 'Waiting on others'], ['review', 'Review'], ['done', 'Done'],
  ];
  const statusOfColumn = (colId) => (COLUMNS.find((c) => c.id === colId) || {}).status || colId;

  let snap = { projects: [], tasks: [], globalLimit: 8, liveTotal: 0 };
  let visible = false;
  let selectedId = null;
  let profiles = [];
  const shown = { backlog: false, done: false };

  /* ------------------------------------------------------------ helpers */

  // Errors from the main process arrive as "Error invoking remote method
  // 'x': Error: <message>"; show only the message.
  /** Resize a terminal on the next frame, if it still exists by then. */
  function refit(id) {
    if (!id) return;
    requestAnimationFrame(() => { const p = panes.get(id); if (p) p.fit.fit(); });
  }

  /** A length of time, short: "<1m", "12m", "1h 20m", "2d 3h". */
  function dur(ms) {
    const m = Math.floor((ms || 0) / 60000);
    if (m < 1) return '<1m';
    if (m < 60) return `${m}m`;
    const hrs = Math.floor(m / 60);
    if (hrs < 24) return `${hrs}h${m % 60 ? ` ${m % 60}m` : ''}`;
    return `${Math.floor(hrs / 24)}d${hrs % 24 ? ` ${hrs % 24}h` : ''}`;
  }

  const TIME_LABELS = [['agent', 'Agent working'], ['you', 'You on it'], ['needsYou', 'Blocked on you'], ['waiting', 'Waiting on others']];

  /** One line per time bucket that has any time in it. */
  function timeLines(t) {
    const tm = t.time || {};
    return TIME_LABELS.filter(([k]) => tm[k] >= 60000).map(([k, label]) => [k, label, dur(tm[k])]);
  }

  function errText(e) {
    return String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  }

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
    if (task.blockedBy && task.blockedBy.length && !ps && task.status !== 'done') {
      return ['Waits for', task.blockedBy.map((b) => b.title).join(', ')];
    }
    if (task.status === 'queued') return ['Waiting', 'a free slot'];
    if (task.status === 'waiting') return ['Waiting', `${task.waitingFor || 'someone else'} · ${age(task.statusAt)}`];
    if (ps) {
      if (ps.state === 'needs_input') return ['Asks', ps.reason || 'your input'];
      if (ps.state === 'exited') return ['Ended', task.nextStep || 'the terminal closed'];
      if (ps.state === 'running') return ['Working', task.nextStep || ps.reason || ''];
      if (ps.state === 'idle') return ['Next', task.nextStep || 'the agent is at its prompt, your move'];
    }
    if (task.nextStep && task.status !== 'done') return ['Last', task.nextStep];
    if (task.sessionId && (task.status === 'ready' || task.status === 'backlog')) return ['Resume', 'continues its conversation'];
    if (task.brief) return ['Brief', task.brief.split('\n')[0]];
    return null;
  }

  function columnsShown() { return COLUMNS.filter((c) => !c.optional || shown[c.id]); }

  /** The column a task shows in. */
  function columnOf(task) {
    if (task.status !== 'active') return task.status;
    const ps = paneState(task);
    return ps && (ps.state === 'running' || ps.state === 'starting') ? 'running' : 'needs';
  }

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
      const count = snap.tasks.filter((t) => columnOf(t) === c.id).length;
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
        h('div', { class: 'b-lanebtns' },
          h('button', { class: 'mini', text: '+ Task', onclick: () => taskDialog({ cwd: p.cwd }) }),
          h('button', { class: 'mini', text: 'Plan', title: 'Open this project’s planner beside the board (P)', onclick: () => openPlanner(p.cwd) }),
          h('button', {
            class: 'mini' + (p.ruleCount ? ' on' : ''),
            text: p.ruleCount ? `Rules ${p.ruleCount}` : 'Rules',
            title: 'Rules every terminal in this project follows',
            onclick: () => rulesDialog(p.cwd),
          }))));

      for (const c of cols) {
        const cell = h('div', { class: 'b-cell', 'data-cwd': p.cwd, 'data-status': c.id });
        const target = statusOfColumn(c.id);
        cell.ondragover = (e) => {
          if (dragging && dragging.cwd === p.cwd && target !== 'queued') { e.preventDefault(); cell.classList.add('drop'); }
        };
        cell.ondragleave = () => cell.classList.remove('drop');
        cell.ondrop = (e) => {
          e.preventDefault();
          cell.classList.remove('drop');
          if (dragging && dragging.cwd === p.cwd && dragging.status !== target) move(dragging.id, target);
        };
        for (const t of tasks.filter((x) => columnOf(x) === c.id)) cell.append(card(t));
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
      plannerId && panes.has(plannerId) ? h('button', { class: 'mini on', text: `${panes.get(plannerId).meta.title} · Hide`, title: 'Hide the planner (it keeps running)', onclick: closePlanner }) : null,
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
    const dot = ps ? ps.state : (t.status === 'queued' || t.status === 'waiting' ? 'queued' : 'none');
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
        t.diffStat && t.diffStat.files ? h('span', { class: 'b-stat', title: `${t.diffStat.files} file${t.diffStat.files === 1 ? '' : 's'} changed` },
          h('span', { class: 'add', text: `+${t.diffStat.added}` }), document.createTextNode(' '), h('span', { class: 'del', text: `−${t.diffStat.removed}` })) : null,
        timeChip(t),
        h('span', { class: 'b-age', text: age(t.statusAt) })),
      line ? h('div', { class: 'b-next' }, h('b', { text: `${line[0]}: ` }), document.createTextNode(line[1])) : null,
      actions(t, ps));
    el.onclick = () => select(t.id);
    el.ondblclick = () => open(t.id);
    el.ondragstart = (e) => { dragging = t; e.dataTransfer.setData('text/plain', t.id); el.classList.add('dragging'); };
    el.ondragend = () => { dragging = null; el.classList.remove('dragging'); };
    return el;
  }

  /** Time worked on a task (agent and you), with the full split on hover. */
  function timeChip(t) {
    const lines = timeLines(t);
    if (!lines.length) return null;
    const tm = t.time || {};
    const worked = (tm.agent || 0) + (tm.you || 0);
    const blocked = tm.needsYou || 0;
    return h('span', {
      class: 'b-time' + (blocked >= 15 * 60000 && blocked > worked / 2 ? ' warn' : ''),
      title: lines.map(([, label, d]) => `${label}: ${d}`).join('\n'),
      text: `⏱ ${dur(worked)}`,
    });
  }

  function actions(t, ps) {
    const row = h('div', { class: 'b-actions' });
    const live = ps && ps.state !== 'exited';
    if (live) {
      row.append(h('button', { class: 'mini', text: 'Open', onclick: (e) => { e.stopPropagation(); open(t.id); } }));
    } else if (t.status !== 'queued') {
      const resume = !!t.sessionId;
      const blocked = t.blockedBy && t.blockedBy.length;
      row.append(h('button', {
        class: 'mini' + (blocked ? ' disabled' : ''),
        text: resume ? 'Resume' : 'Start',
        title: blocked ? `Waits for ${t.blockedBy.map((b) => b.title).join(', ')}`
          : resume ? 'Start its terminal and continue the same conversation' : 'Start a terminal for this task (S)',
        onclick: (e) => { e.stopPropagation(); if (!blocked) start(t.id); },
      }));
    }
    if (t.worktree && !t.worktree.removed) {
      row.append(h('button', { class: 'mini', text: 'Diff', title: 'What this task changed (D)', onclick: (e) => { e.stopPropagation(); diffDialog(t.id); } }));
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
    if (on && window.__focus && window.__focus.current) { window.__focus.blocked(); return; }
    if (!on && peekId) closePeek();
    if (!on && plannerId) { plannerId = null; document.querySelector('#main').classList.remove('planner-open'); }
    visible = on;
    root.hidden = !on;
    toggleBtn.classList.toggle('on', on);
    if (on) { refresh(); root.focus(); }
    else refit(currentId());
    report();
  }

  /** Tell the main process what is on screen, for "your time". */
  function report() { H.reportView({ boardVisible: visible, peekPaneId: peekId }); }

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
      flash(`Could not start: ${errText(err)}`);
    }
  }

  async function move(id, status) {
    if (status === 'waiting') { waitDialog(snap.tasks.find((t) => t.id === id)); return; }
    try {
      const r = await H.boardMove(id, status);
      if (r && r.pane && !panes.has(r.pane.id)) addPane(r.pane);
      if (r && r.status === 'queued') flash(`Queued: ${r.reason}.`);
    } catch (err) {
      flash(`Could not move: ${errText(err)}`);
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
    if (window.__focus && window.__focus.current) { window.__focus.blocked(); return; }
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
    const isolation = h('select', { class: 'field', id: 'task-isolation' },
      ...[['auto', 'Automatic: own worktree when the project runs more than one terminal'],
        ['worktree', 'Its own git worktree and branch'],
        ['main', 'The project’s own folder']].map(([v, l]) => { const o = h('option', { value: v, text: l }); if ((task.isolation || 'auto') === v) o.selected = true; return o; }));
    const fixed = !!(task.sessionId || task.worktree);
    if (fixed) isolation.disabled = true;
    const links = h('textarea', { class: 'field', id: 'task-links', rows: '2', placeholder: 'MRs, tickets, docs: one link per line' });
    links.value = (task.links || []).join('\n');
    // Other tasks of the chosen project this one waits for.
    const deps = h('div', { class: 'b-deps', id: 'task-deps' });
    const chosenDeps = new Set(task.dependsOn || []);
    const renderDeps = () => {
      const others = snap.tasks.filter((x) => x.cwd === project.value && x.id !== task.id);
      deps.replaceChildren(...(others.length ? others.map((x) => {
        const cb = h('input', { type: 'checkbox', 'data-dep': x.id });
        cb.checked = chosenDeps.has(x.id);
        cb.onchange = () => { if (cb.checked) chosenDeps.add(x.id); else chosenDeps.delete(x.id); };
        return h('label', { class: 'kn-check' }, cb, document.createTextNode(` ${x.title}`), h('span', { class: 'dim small', text: ` · ${x.status}` }));
      }) : [h('span', { class: 'dim small', text: 'No other tasks in this project.' })]));
    };
    renderDeps();
    const where = task.worktree
      ? h('div', { class: 'b-where' },
        h('span', { class: 'mono', text: task.worktree.branch }),
        task.worktree.removed ? h('span', { class: 'dim small', text: ' · worktree removed, branch kept' }) : null)
      : null;

    const body = h('div', { class: 'b-form' },
      h('label', { text: 'Project' }), project,
      h('label', { text: 'Title' }), title,
      h('label', { text: 'Brief' }), brief,
      h('label', { text: 'Agent' }), agent,
      h('label', { text: 'Runs in' }), h('div', { class: 'b-stack' }, isolation,
        fixed ? h('span', { class: 'dim small', text: 'Fixed once a task has started: its conversation and changes live there.' }) : null, where),
      h('label', { text: 'Links' }), links,
      h('label', { text: 'Depends on' }), deps,
      err);

    project.onchange = () => {
      agent.options[0].textContent = defaultAgent(projects.find((p) => p.cwd === project.value));
      chosenDeps.clear();
      renderDeps();
    };
    const read = () => ({ cwd: project.value, title: title.value, brief: brief.value, agent: agent.value || null, links: links.value, dependsOn: [...chosenDeps], ...(fixed ? {} : { isolation: isolation.value }) });
    const fail = (e) => { err.textContent = errText(e); err.hidden = false; };

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
          try { await H.boardRemove(task.id); } catch (e) { flash(errText(e)); }
        } }),
        task.worktree && !task.worktree.removed ? h('button', { class: 'btn', text: 'Remove worktree', title: 'Delete the worktree folder. Its branch, with every commit, is kept.', onclick: async () => {
          try { await H.boardRemoveWorktree(task.id); m.close(); flash(`Worktree removed. Branch ${task.worktree.branch} is kept.`); } catch (e) { fail(e); }
        } }) : null,
        h('button', { class: 'btn primary', text: 'Save', onclick: async () => {
          try {
            const r = read();
            await H.boardUpdate(task.id, { title: r.title, brief: r.brief, agent: r.agent, links: r.links, dependsOn: r.dependsOn, ...(r.isolation ? { isolation: r.isolation } : {}) });
            m.close();
          } catch (e) { fail(e); }
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
    const err = h('p', { class: 'b-err', hidden: true });
    const go = async () => {
      try { await save(input.value); m.close(); } catch (e) { err.textContent = errText(e); err.hidden = false; }
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') go(); };
    const m = UI().openModal({
      title, subtitle,
      body: h('div', { class: 'b-stack' }, input, err),
      footer: h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', text: 'Cancel', onclick: () => m.close() }),
        h('button', { class: 'btn primary', text: 'Save', onclick: go })),
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

  function waitDialog(t) {
    if (!t) return;
    const input = h('input', { class: 'field', id: 'wait-input', value: t.waitingFor || '', placeholder: 'e.g. code review on 2 MRs, the 1-hour deploy watch, an answer from finance' });
    const save = async () => { await H.boardWait(t.id, input.value); m.close(); };
    input.onkeydown = (e) => { if (e.key === 'Enter') save(); };
    const m = UI().openModal({
      title: 'What is it waiting for?',
      subtitle: 'The card shows this and how long it has waited. Its terminal keeps running.',
      body: input,
      footer: h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', text: 'Cancel', onclick: () => m.close() }),
        h('button', { class: 'btn primary', text: 'Move to Waiting', onclick: save })),
    });
    requestAnimationFrame(() => input.focus());
  }

  function moveDialog(t) {
    const m = UI().openModal({
      title: `Move “${t.title}”`,
      body: h('div', { class: 'b-movelist' }, ...MOVES.map(([s, label]) =>
        h('button', { class: 'btn' + (s === t.status ? ' disabled' : ''), text: label, onclick: () => { m.close(); move(t.id, s); } }))),
      footer: h('div', { class: 'modal-actions' }, h('button', { class: 'btn', text: 'Cancel', onclick: () => m.close() })),
    });
  }

  /* -------------------------------------------------------------- rules */

  function projectOf(cwd) { return snap.projects.find((p) => p.cwd === cwd) || { cwd, name: cwd.split('/').pop() }; }

  /** List, add, edit and remove a project's rules. */
  async function rulesDialog(cwd, prefill = '') {
    if (!cwd) { flash('Open a terminal or pick a project first.'); return; }
    const name = projectOf(cwd).name;
    const list = h('div', { class: 'r-list' });
    const note = h('p', { class: 'dim small r-note' });
    const err = h('p', { class: 'b-err', hidden: true });
    const add = h('textarea', { class: 'field', id: 'rule-new', rows: '3', placeholder: 'A rule every terminal in this project must follow' });
    add.value = prefill;
    const fail = (e) => { err.textContent = errText(e); err.hidden = false; };
    const told = (n) => flash(n ? `Saved. ${n} running terminal${n === 1 ? '' : 's'} will be told at their next prompt.` : 'Saved. New terminals get it at launch.');

    async function load() {
      const { rules, running } = await H.rulesList(cwd);
      note.textContent = `Every new terminal in ${name} gets these at launch. ${running} running terminal${running === 1 ? '' : 's'} will be told about changes at their next prompt.`;
      list.replaceChildren(...(rules.length ? rules.map((r, i) => {
        const text = h('div', { class: 'r-text', text: `${i + 1}. ${r.text}` });
        const row = h('div', { class: 'r-row' }, text,
          h('button', { class: 'mini', text: 'Edit', onclick: () => {
            const input = h('input', { class: 'field', value: r.text });
            const saveEdit = async () => { try { told((await H.rulesUpdate(cwd, r.id, input.value)).told); await load(); } catch (e) { fail(e); } };
            input.onkeydown = (e) => { if (e.key === 'Enter') saveEdit(); };
            row.replaceChildren(input, h('button', { class: 'mini', text: 'Save', onclick: saveEdit }));
            input.focus();
          } }),
          h('button', { class: 'mini danger', text: 'Remove', onclick: async () => { try { told((await H.rulesRemove(cwd, r.id)).told); await load(); } catch (e) { fail(e); } } }));
        return row;
      }) : [h('p', { class: 'dim small', text: 'No rules yet.' })]));
    }

    const kn = window.__knowledge && window.__knowledge.state;
    const importBtn = kn && kn.mapped && kn.mapped.importRules
      ? h('button', { class: 'btn', text: 'Import from knowledge server…', onclick: async () => {
        m.close();   // the picker takes the dialog's place; reopened below
        const chosen = await window.__knowledge.pickImportedRules(cwd, name);
        // The picker replaced this dialog; reopen it with the result.
        if (chosen && chosen.length) {
          let added = 0;
          for (const text of chosen) { try { await H.rulesAdd(cwd, text); added++; } catch { /* duplicate */ } }
          flash(`Imported ${added} rule${added === 1 ? '' : 's'}.`);
        }
        rulesDialog(cwd);
      } })
      : null;

    const m = UI().openModal({
      title: `Rules for ${name}`,
      subtitle: 'Written once here, followed by every terminal in the project. Claude receives them in its system prompt, so they survive long sessions.',
      body: h('div', { class: 'r-body' }, list, note, h('label', { class: 'dim small', text: 'Add a rule' }), add, err),
      footer: h('div', { class: 'modal-actions' },
        importBtn,
        h('button', { class: 'btn', text: 'Close', onclick: () => m.close() }),
        h('button', { class: 'btn primary', text: 'Add rule', onclick: async () => {
          try { const r = await H.rulesAdd(cwd, add.value); add.value = ''; err.hidden = true; told(r.told); await load(); } catch (e) { fail(e); }
        } })),
      wide: true,
    });
    await load();
    requestAnimationFrame(() => add.focus());
  }

  /** Selected text in the terminal on screen becomes a project rule. */
  function promoteRule() {
    const id = currentId();
    const pane = id && panes.get(id);
    const selection = pane ? pane.term.getSelection().trim() : '';
    const cwd = pane ? (pane.meta.projectCwd || pane.meta.cwd) : (snap.tasks.find((t) => t.id === selectedId) || {}).cwd;
    if (!cwd) { flash('Open a terminal first, then select the text of the rule.'); return; }
    rulesDialog(cwd, selection);
  }

  /** The topbar chip: which rules the terminal on screen received. */
  function updateChip(meta) {
    const chip = document.querySelector('#session-rules');
    if (!chip) return;
    if (!meta) { chip.hidden = true; renderDrawer(); return; }
    queueMicrotask(renderDrawer);
    chip.hidden = false;
    const cwd = meta.projectCwd || meta.cwd;
    const project = snap.projects.find((p) => p.cwd === cwd);
    const current = project ? project.rulesVersion : meta.rulesVersion;
    const total = project ? project.ruleCount : meta.projectRuleCount;
    chip.className = '';
    chip.onclick = () => rulesDialog(cwd);
    if (!total) {
      chip.textContent = 'No rules';
      chip.title = 'This project has no rules. Click to add some.';
      chip.className = 'none';
    } else if (meta.rulesVia === 'none') {
      chip.textContent = 'Rules not delivered';
      chip.title = meta.profileId === 'shell'
        ? 'A plain shell takes no instructions.'
        : 'This agent has no way to take standing instructions, and a resumed conversation gets no opening message. Restart the terminal to deliver them.';
      chip.className = 'warn';
    } else if (current && meta.rulesVersion !== current) {
      chip.textContent = 'Rules out of date';
      chip.title = 'The project’s rules changed after this terminal started and it could not be told. Restart it to apply them.';
      chip.className = 'warn';
    } else {
      chip.textContent = `Rules ${meta.projectRuleCount} ✓`;
      chip.title = { system: 'In the system prompt', opening: 'In the opening message', notice: 'Typed in as a notice after a change' }[meta.rulesVia] || '';
      chip.className = 'ok';
    }
  }

  /* --------------------------------------------------------------- peek */

  let peekTimer = null;
  let peekId = null;

  /** Look at a task's terminal without leaving the board, and answer quick prompts. */
  function peek(taskId) {
    const t = snap.tasks.find((x) => x.id === taskId);
    const el = document.querySelector('#board-peek');
    if (!t || !t.pane || t.pane.exited || !panes.has(t.pane.id)) { flash('This task has no running terminal to look at.'); return; }
    peekId = t.pane.id;
    const screen = h('pre', { class: 'p-screen' });
    const reply = h('input', { class: 'field', id: 'peek-reply', placeholder: 'Type a reply and press Enter' });
    const send = (data) => { H.write(peekId, data); refreshPeek(); };
    reply.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); send(`${reply.value}\r`); reply.value = ''; }
      if (e.key === 'Escape') { e.preventDefault(); closePeek(); }
    };
    el.replaceChildren(
      h('div', { class: 'p-head' },
        h('strong', { text: t.title }),
        h('span', { class: 'spacer' }),
        h('button', { class: 'mini', text: 'Open terminal', onclick: () => { closePeek(); open(t.id); } }),
        h('button', { class: 'mini', text: '×', title: 'Close (Esc)', onclick: closePeek })),
      screen,
      h('div', { class: 'p-keys' },
        ...['1', '2', '3'].map((k) => h('button', { class: 'mini', text: k, title: `Press ${k}`, onclick: () => send(k) })),
        h('button', { class: 'mini', text: 'Enter', onclick: () => send('\r') }),
        h('button', { class: 'mini', text: 'Esc', title: 'Send Esc to the agent', onclick: () => send('\x1b') })),
      reply);
    el.hidden = false;
    async function refreshPeek() {
      if (!peekId) return;
      const text = await H.screenText(peekId);
      screen.textContent = text.replace(/\s+$/, '').split('\n').slice(-28).join('\n');
    }
    clearInterval(peekTimer);
    refreshPeek();
    peekTimer = setInterval(refreshPeek, 700);
    report();
    requestAnimationFrame(() => reply.focus());
  }

  function closePeek() {
    clearInterval(peekTimer);
    peekId = null;
    const el = document.querySelector('#board-peek');
    el.hidden = true;
    el.replaceChildren();
    root.focus();
    report();
  }

  /* --------------------------------------------------------------- diff */

  /** What a task changed since it started: committed, uncommitted and new files. */
  async function diffDialog(taskId) {
    const t = snap.tasks.find((x) => x.id === taskId);
    if (!t) return;
    const r = await H.boardDiff(taskId);
    if (!r.ok) { flash(r.error); return; }
    const files = [];
    const pre = h('div', { class: 'd-text' });
    const lines = r.text.split('\n');
    const LIMIT = 20000;
    for (const line of lines.slice(0, LIMIT)) {
      let cls = '';
      if (line.startsWith('diff --git')) {
        const name = line.replace(/^diff --git a\/(.+?) b\/.*$/, '$1');
        const anchor = h('div', { class: 'd-line file', text: name });
        files.push([name, anchor]);
        pre.append(anchor);
        continue;
      }
      if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) cls = 'meta';
      else if (line.startsWith('@@')) cls = 'hunk';
      else if (line.startsWith('+')) cls = 'add';
      else if (line.startsWith('-')) cls = 'del';
      pre.append(h('div', { class: `d-line ${cls}`, text: line || ' ' }));
    }
    const st = r.stat || {};
    const m = UI().openModal({
      title: t.title,
      subtitle: `${r.branch} · since ${String(r.base).slice(0, 8)} · ${st.files || 0} file${st.files === 1 ? '' : 's'}, +${st.added || 0} −${st.removed || 0}${r.truncated || lines.length > LIMIT ? ' · shortened' : ''}`,
      body: h('div', { class: 'd-body' },
        h('div', { class: 'd-files' }, ...(files.length ? files.map(([name, anchor]) => h('button', { class: 'd-file', text: name, title: name, onclick: () => anchor.scrollIntoView({ block: 'start' }) }))
          : [h('p', { class: 'dim small', text: 'No changes yet.' })])),
        pre),
      footer: h('div', { class: 'modal-actions' },
        h('span', { class: 'dim small d-path', text: r.path }),
        h('button', { class: 'btn primary', text: 'Close', onclick: () => m.close() })),
      wide: true,
    });
    m.card.classList.add('diffview');   // not .diff: the General tab uses that
  }

  /* ---------------------------------------------------------- task panel */

  // Beside the terminal in the focus view: everything about the task whose
  // terminal is on screen.
  let drawerOpen = false;
  const drawerEl = document.querySelector('#taskdrawer');
  const taskBtn = document.querySelector('#session-task');

  function currentTask() {
    const id = currentId();
    const pane = id && panes.get(id);
    return pane && pane.meta.taskId ? snap.tasks.find((t) => t.id === pane.meta.taskId) || null : null;
  }

  function renderDrawer() {
    const t = currentTask();
    taskBtn.hidden = !t;
    const show = drawerOpen && !!t;
    drawerEl.hidden = !show;
    document.querySelector('#main').classList.toggle('drawer-open', show);
    if (!show) return;
    const ps = paneState(t);
    const line = nextLine(t, ps);
    const sec = (label, ...kids) => h('div', { class: 'td-sec' }, h('div', { class: 'td-label', text: label }), ...kids);
    const col = COLUMNS.find((c) => c.id === columnOf(t));
    drawerEl.replaceChildren(...[
      h('div', { class: 'td-head' }, h('strong', { text: t.title }), h('button', { class: 'mini', text: '×', title: 'Close (⌘I)', onclick: toggleDrawer })),
      sec('Status', h('div', { text: `${col ? col.label : t.status} · ${projectOf(t.cwd).name}` })),
      t.brief ? sec('Brief', h('div', { class: 'td-text', text: t.brief })) : null,
      line ? sec(line[0], h('div', { class: 'td-text', text: line[1] })) : null,
      t.worktree ? sec('Git',
        h('div', { class: 'mono td-text', text: t.worktree.branch }),
        t.diffStat ? h('div', { class: 'b-stat' }, h('span', { class: 'add', text: `+${t.diffStat.added}` }), document.createTextNode(' '), h('span', { class: 'del', text: `−${t.diffStat.removed}` }), document.createTextNode(` in ${t.diffStat.files} file${t.diffStat.files === 1 ? '' : 's'}`)) : null,
        t.worktree.removed ? null : h('button', { class: 'mini', text: 'View diff', onclick: () => diffDialog(t.id) }))
        : sec('Git', h('div', { class: 'dim small', text: 'Runs in the project’s own folder.' })),
      sec('Time', ...(timeLines(t).length ? timeLines(t).map(([k, label, d]) => h('div', { class: 'td-time', 'data-bucket': k }, h('span', { text: label }), h('b', { text: d })))
        : [h('div', { class: 'dim small', text: 'Nothing counted yet.' })]),
        t.focus && t.focus.sessions ? h('div', { class: 'dim small', text: `Focus: ${t.focus.sessions} session${t.focus.sessions === 1 ? '' : 's'}, ${dur(t.focus.ms)}${t.focus.completed !== t.focus.sessions ? ` (${t.focus.completed} completed)` : ''}` }) : null),
      t.links && t.links.length ? sec('Links', ...t.links.map((u) => (/^(https?:|mailto:)/i.test(u)
        ? h('a', { class: 'td-link', href: u, target: '_blank', rel: 'noopener', text: u })
        : h('div', { class: 'td-text mono', text: u })))) : null,
      sec('Rules', h('div', { class: 'td-text', text: document.querySelector('#session-rules').textContent || '' })),
      h('div', { class: 'td-actions' },
        window.__focus && window.__focus.current ? null : h('button', { class: 'mini', text: 'Focus…', title: 'Focus on this task (⌘⇧F)', onclick: () => window.__focus.dialog(t.id) }),
        h('button', { class: 'mini', text: 'Move…', onclick: () => moveDialog(t) }),
        h('button', { class: 'mini', text: 'Edit', onclick: () => taskDialog(t) }),
        window.__focus && window.__focus.current ? null : h('button', { class: 'mini', text: 'Board', onclick: () => setVisible(true) })),
    ].filter(Boolean));   // a section left out must not print as "null"
  }

  function toggleDrawer() {
    drawerOpen = !drawerOpen;
    renderDrawer();
    const id = currentId();
    refit(id);
  }

  /* ------------------------------------------------------------ planner */

  // The project's planner sits to the right of the board; cards it creates
  // appear in Backlog as it goes.
  let plannerId = null;

  async function openPlanner(cwd) {
    if (!cwd) { flash('Pick a project first.'); return; }
    const meta = await H.boardOpenPlanner(cwd);
    if (!panes.has(meta.id)) addPane(meta);
    plannerId = meta.id;
    if (!visible) setVisible(true);
    document.querySelector('#main').classList.add('planner-open');
    activate(meta.id, { keepBoard: true });
    render();
    requestAnimationFrame(() => { const p = panes.get(meta.id); if (p) { p.fit.fit(); p.term.focus(); } });
  }

  function closePlanner() {
    plannerId = null;
    document.querySelector('#main').classList.remove('planner-open');
    const id = currentId();
    refit(id);
    if (visible) render();
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
      ' ': () => t && peek(t.id),
      s: () => t && start(t.id),
      d: () => t && t.worktree && diffDialog(t.id),
      m: () => t && moveDialog(t),
      e: () => t && taskDialog(t),
      n: () => taskDialog(t ? { cwd: t.cwd } : {}),
      p: () => openPlanner(t ? t.cwd : (snap.projects[0] || {}).cwd),
      f: () => window.__focus.dialog(t && t.id),
    };
    const fn = keys[e.key];
    if (fn) { e.preventDefault(); fn(); }
  });

  /* --------------------------------------------------------------- wire */

  H.onBoardChanged((s) => {
    const grew = s.projects.length !== snap.projects.length;
    snap = s;
    if (visible) render();
    const id = currentId();
    if (id && panes.has(id)) updateChip(panes.get(id).meta);
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
  H.onPromoteRule(promoteRule);
  H.onTaskDrawer(toggleDrawer);
  taskBtn.onclick = toggleDrawer;
  H.onProjectRules(() => {
    const id = currentId();
    const pane = id && panes.get(id);
    const t = snap.tasks.find((x) => x.id === selectedId);
    rulesDialog(pane && !visible ? (pane.meta.projectCwd || pane.meta.cwd) : (t ? t.cwd : (snap.projects[0] || {}).cwd));
  });
  toggleBtn.onclick = toggle;

  // Ages and times on cards drift; fetch them again once a minute while the
  // board or the task panel is open.
  setInterval(() => { if (visible) refresh(); else if (drawerOpen) H.boardGet().then((s) => { snap = s; renderDrawer(); }); }, 60000);

  /** A pane went away; if it was the planner, the board takes the whole width again. */
  function paneClosed(id) { if (id && id === plannerId) closePlanner(); }

  window.__board = { paneClosed, openPlanner, closePlanner, get plannerId() { return plannerId; }, updateChip, diffDialog, toggleDrawer, get drawerOpen() { return drawerOpen; }, rulesDialog, peek, closePeek, columnOf: (id) => { const t = snap.tasks.find((x) => x.id === id); return t ? columnOf(t) : null; }, toggle, show: () => setVisible(true), hide: () => setVisible(false), refresh, get visible() { return visible; }, select, start, move, nextNeeds, taskOf: (id) => snap.tasks.find((x) => x.id === id) || null, selectedTask: () => snap.tasks.find((x) => x.id === selectedId) || null, currentTask, renderDrawer };

  // Open on the board when there is work on it.
  H.boardGet().then((s) => { snap = s; if (s.tasks.length) setVisible(true); });
})();
