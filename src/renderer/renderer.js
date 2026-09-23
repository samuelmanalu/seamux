'use strict';

/* global Terminal, FitAddon, WebLinksAddon */

const H = window.seamux;

/** id -> { meta, term, fit, el } */
const panes = new Map();
let order = [];          // session ids, sidebar order
let activeId = null;
let debugOn = false;
let debugTimer = null;

const $ = (sel) => document.querySelector(sel);
const el = {
  sessionList: $('#session-list'),
  projectList: $('#project-list'),
  terminals: $('#terminals'),
  empty: $('#empty'),
  alert: $('#alert'),
  crumbTitle: $('#crumb-title'),
  crumbPath: $('#crumb-path'),
  crumbState: $('#crumb-state'),
  sessionContext: $('#session-context'),
  ctxbar: $('#ctxbar'),
  ctxbarText: $('#ctxbar-text'),
  debug: $('#debug'),
  debugScreen: $('#debug-screen'),
  debugVerdict: $('#debug-verdict'),
};

const THEME = {
  background: '#14161a', foreground: '#dfe3ea', cursor: '#7aa2f7',
  selectionBackground: '#2c3a55',
  black: '#1a1d23', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
  blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#c0caf5',
  brightBlack: '#5a616e', brightRed: '#ff8a9e', brightGreen: '#b3e07d',
  brightYellow: '#f0c078', brightBlue: '#8fb4ff', brightMagenta: '#ccaaff',
  brightCyan: '#9ddfff', brightWhite: '#e6ebff',
};

const LABEL = {
  running: 'working…',
  needs_input: 'needs you',
  idle: 'idle',
  starting: 'starting…',
  exited: 'exited',
};

/* ---------------------------------------------------------------- sessions */

async function newSession() {
  const project = await H.pickProject();
  if (!project) return;
  const meta = await H.createSession({ cwd: project.cwd, title: project.name });
  addPane(meta);
  activate(meta.id);
  await refreshProjects();
}

async function openProject(cwd, name) {
  const meta = await H.createSession({ cwd, title: name });
  addPane(meta);
  activate(meta.id);
}

function addPane(meta) {
  const host = document.createElement('div');
  host.className = 'term-pane';
  el.terminals.appendChild(host);

  const term = new Terminal({
    theme: THEME,
    fontFamily: 'SFMono-Regular, Menlo, ui-monospace, monospace',
    fontSize: 12.5,
    lineHeight: 1.25,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    macOptionIsMeta: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.open(host);

  term.onData((d) => H.write(meta.id, d));
  term.onResize(({ cols, rows }) => H.resize(meta.id, cols, rows));

  panes.set(meta.id, { meta, term, fit, el: host });
  order.push(meta.id);
  renderSessions();
  return panes.get(meta.id);
}

function activate(id) {
  const pane = panes.get(id);
  if (!pane) return;

  activeId = id;
  for (const [pid, p] of panes) p.el.classList.toggle('active', pid === id);
  el.empty.hidden = true;

  requestAnimationFrame(() => {
    pane.fit.fit();
    pane.term.focus();
  });

  pane.meta.unread = false;
  H.markRead(id);
  renderSessions();
  renderCrumb();
  if (debugOn) refreshDebug();
}

async function closeSession(id) {
  await H.removeSession(id);
  const pane = panes.get(id);
  if (pane) { pane.term.dispose(); pane.el.remove(); }
  panes.delete(id);
  order = order.filter((x) => x !== id);

  if (activeId === id) {
    activeId = null;
    if (order.length) activate(order[order.length - 1]);
    else { el.empty.hidden = false; renderCrumb(); }
  }
  renderSessions();
}

/* ---------------------------------------------------------------- rendering */

function renderSessions() {
  el.sessionList.replaceChildren();

  order.forEach((id, i) => {
    const { meta } = panes.get(id);
    const li = document.createElement('li');
    li.className = 'row';
    li.classList.toggle('active', id === activeId);
    li.classList.toggle('needs', meta.state === 'needs_input');

    const dot = document.createElement('span');
    dot.className = `dot ${meta.state}`;

    const text = document.createElement('div');
    text.className = 'row-text';
    const title = document.createElement('div');
    title.className = 'row-title';
    title.textContent = meta.title;
    const sub = document.createElement('div');
    sub.className = 'row-sub';
    sub.textContent = LABEL[meta.state] || meta.state;
    text.append(title, sub);

    for (const name of meta.envSetNames || []) {
      const chip = document.createElement('span');
      chip.className = 'env-chip';
      chip.textContent = name;
      chip.title = 'Context applied to this session';
      title.append(chip);
    }
    if (meta.contextPending) {
      const chip = document.createElement('span');
      chip.className = 'env-chip pending';
      chip.textContent = 'restart to apply';
      title.append(chip);
    }

    const close = document.createElement('button');
    close.className = 'row-close';
    close.textContent = '×';
    close.title = 'Close session';
    close.onclick = (e) => { e.stopPropagation(); closeSession(id); };

    if (i < 9) {
      const key = document.createElement('span');
      key.className = 'row-key';
      key.textContent = `⌘${i + 1}`;
      li.append(dot, text, key, close);
    } else {
      li.append(dot, text, close);
    }

    li.onclick = () => activate(id);
    el.sessionList.appendChild(li);
  });

  renderAlert();
}

function renderAlert() {
  const waiting = order
    .map((id) => panes.get(id).meta)
    .filter((m) => m.state === 'needs_input' && m.id !== activeId);

  if (!waiting.length) { el.alert.hidden = true; return; }
  el.alert.hidden = false;
  el.alert.textContent = waiting.length === 1
    ? `${waiting[0].title} needs you`
    : `${waiting.length} sessions need you`;
  el.alert.onclick = () => activate(waiting[0].id);
}

function renderCrumb() {
  const pane = activeId && panes.get(activeId);
  if (!pane) {
    el.crumbTitle.textContent = 'No session';
    el.crumbPath.textContent = '';
    el.crumbState.textContent = '';
    return;
  }
  const m = pane.meta;
  el.crumbTitle.textContent = m.title;
  el.crumbPath.title = m.profileLabel ? `Agent: ${m.profileLabel}` : '';
  el.crumbPath.textContent = m.cwd;
  const warnBit = (m.envWarnings && m.envWarnings.length) ? `  ·  ⚠ ${m.envWarnings.length} context warning(s)` : '';
  el.crumbState.textContent = `${LABEL[m.state] || m.state} — ${m.reason || ''}${warnBit}`;
  el.crumbState.title = (m.envWarnings || []).join('\n');

  const names = m.envSetNames || [];
  el.sessionContext.textContent = names.length
    ? `Context: ${names.join(', ')} · ${(m.envKeys || []).length}`
    : 'Context: none';
  el.sessionContext.classList.toggle('none', !names.length);
  el.sessionContext.title = names.length
    ? (m.envKeys || []).join(', ')
    : 'Click to give this session context';

  el.ctxbar.hidden = !m.contextPending;
  if (m.contextPending) {
    el.ctxbarText.textContent =
      'Context changed. The session has been told and can load the new values from its context file. '
      + 'Restart only if something needs them as real environment variables.';
  }
}

let envSetNamesById = {};
let profileLabels = {};

/** The project of the session currently on screen, if any. */
function activeProjectCwd() {
  const pane = activeId && panes.get(activeId);
  return pane ? pane.meta.cwd : null;
}

function envNamesFor(project) {
  return (project.envSetIds || []).map((id) => envSetNamesById[id]).filter(Boolean);
}

async function refreshProjects() {
  const projects = await H.listProjects();
  try {
    envSetNamesById = Object.fromEntries((await H.envList()).filter(Boolean).map((s) => [s.id, s.name]));
  } catch { envSetNamesById = {}; }
  try {
    profileLabels = Object.fromEntries((await H.profilesList()).map((p) => [p.id, p.label]));
  } catch { profileLabels = {}; }
  el.projectList.replaceChildren();

  for (const p of projects) {
    const li = document.createElement('li');
    li.className = 'row';

    const dot = document.createElement('span');
    dot.className = 'dot';

    const text = document.createElement('div');
    text.className = 'row-text';
    const title = document.createElement('div');
    title.className = 'row-title';
    title.textContent = p.name;
    const sub = document.createElement('div');
    sub.className = 'row-sub';
    sub.textContent = p.cwd;
    text.append(title, sub);

    for (const name of envNamesFor(p)) {
      const chip = document.createElement('span');
      chip.className = 'env-chip';
      chip.textContent = name;
      chip.title = 'Environment applied to sessions in this project';
      title.append(chip);
    }

    const agent = document.createElement('button');
    agent.className = 'mini';
    agent.textContent = profileLabels[p.profileId || 'claude'] || (p.profileId || 'Claude Code');
    agent.title = 'Change the agent for this project';
    agent.onclick = async (e) => {
      e.stopPropagation();
      const id = await window.__envUI.chooseProfile(p.profileId || 'claude');
      if (!id) return;
      await H.setProjectProfile(p.cwd, id);
      refreshProjects();
    };

    const close = document.createElement('button');
    close.className = 'row-close';
    close.textContent = '×';
    close.title = 'Forget project';
    close.onclick = async (e) => {
      e.stopPropagation();
      await H.removeProject(p.cwd);
      refreshProjects();
    };

    li.append(dot, text, agent, close);
    li.title = `Start a session in ${p.cwd}`;
    li.onclick = () => openProject(p.cwd, p.name);
    el.projectList.appendChild(li);
  }
}

/* ------------------------------------------------------------------- debug */

async function refreshDebug() {
  if (!debugOn || !activeId) return;
  const pane = panes.get(activeId);
  el.debugScreen.textContent = await H.screenText(activeId);
  el.debugVerdict.textContent =
    `state=${pane.meta.state}  rule=${pane.meta.rule || '—'}  reason=${pane.meta.reason || '—'}`;
}

function toggleDebug() {
  debugOn = !debugOn;
  el.debug.hidden = !debugOn;
  clearInterval(debugTimer);
  if (debugOn) {
    refreshDebug();
    debugTimer = setInterval(refreshDebug, 500);
  }
  if (activeId) requestAnimationFrame(() => panes.get(activeId).fit.fit());
}

/* -------------------------------------------------------------------- wire */

H.onData(({ id, chunk }) => {
  const pane = panes.get(id);
  if (pane) pane.term.write(chunk);
});

H.onStatus((s) => {
  const pane = panes.get(s.id);
  if (!pane) return;
  Object.assign(pane.meta, s);
  if (s.state === 'needs_input' && s.id !== activeId) pane.meta.unread = true;
  renderSessions();
  if (s.id === activeId) renderCrumb();
});

H.onRestarted(({ id }) => {
  const pane = panes.get(id);
  if (pane) pane.term.reset();
});

H.onExit(({ id }) => {
  const pane = panes.get(id);
  if (pane) pane.term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n');
});

H.onNewSession(newSession);
H.onOpenProject(async ({ cwd, name }) => { await openProject(cwd, name); refreshProjects(); });
H.onToggleDebug(toggleDebug);
H.onFocusSession(({ id, index }) => {
  const target = id || order[index];
  if (target && panes.has(target)) activate(target);
});

el.sessionContext.onclick = async () => {
  if (!activeId) return;
  const pane = panes.get(activeId);
  const ids = await window.__envUI.chooseContext(pane.meta.envSetIds || []);
  if (ids === null) return;
  const info = await H.setSessionContext(activeId, ids);
  if (info) { Object.assign(pane.meta, info); renderSessions(); renderCrumb(); }
};

$('#ctxbar-restart').onclick = async () => {
  if (!activeId) return;
  const pane = panes.get(activeId);
  const info = await H.restartSession(activeId, pane.meta.envSetIds || []);
  if (info) {
    pane.term.reset();
    Object.assign(pane.meta, info);
    renderSessions(); renderCrumb();
  }
};

$('#ctxbar-later').onclick = () => { el.ctxbar.hidden = true; };

$('#new-session').onclick = newSession;
$('#empty-new').onclick = newSession;

window.addEventListener('resize', () => {
  if (activeId && panes.has(activeId)) panes.get(activeId).fit.fit();
});

(async function boot() {
  await refreshProjects();
  // Re-attach to any sessions the main process already had (dev reloads).
  for (const meta of await H.listSessions()) {
    const pane = addPane(meta);
    pane.term.write(await H.replay(meta.id));
  }
  if (order.length) activate(order[0]);
})();
