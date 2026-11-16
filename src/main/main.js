'use strict';

const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, dialog, Notification, Menu, shell } = require('electron');
const { PtyManager, State } = require('./pty-manager');
const { Store } = require('./store');
const { SecretStore } = require('./secrets');
const { EnvManager } = require('./env-manager');
const { parseEnv } = require('./dotenv');
const { GeneralContext } = require('./general-context');
const { interpret } = require('./interpreter');
const profiles = require('./profiles');
const { KnowledgeClient, EXAMPLES: KNOWLEDGE_EXAMPLES } = require('./knowledge');
const { Board, openingPrompt, rulesText } = require('./board');
const { extractNextStep } = require('./next-step');
const worktrees = require('./worktree');
const { TaskRunner } = require('./task-runner');

// Tests must never write into the real user's config. Set before anything
// reads a path, so store and secrets both land in the throwaway directory.
if (process.env.SEAMUX_USER_DATA) app.setPath('userData', process.env.SEAMUX_USER_DATA);

// A packaged app launched from the Dock gets launchd's bare PATH and cannot
// find `claude`. Put the login shell's PATH in front, before anything spawns.
// Not for `npm start`: that already inherits the terminal's PATH, which may
// deliberately differ (an activated venv, say).
if (app.isPackaged && process.platform !== 'win32') {
  const { loginShellPath, mergePath } = require('./shell-path');
  const shellPath = loginShellPath();
  if (shellPath) process.env.PATH = mergePath(shellPath, process.env.PATH);
}

let win = null;
let ptys = null;
let store = null;
let secrets = null;
let envs = null;
let general = null;
let board = null;
let runner = null;
let knowledge = null;
let activeSessionId = null;

/**
 * Directories to open a session in at launch:
 *   electron . -- ~/proj-a ~/proj-b
 *   SEAMUX_OPEN=~/proj-a:~/proj-b electron .
 * Lets you start straight into your usual projects instead of clicking through
 * the picker for each one.
 */
function startupDirs() {
  const fs = require('fs');
  const fromArgv = process.argv.slice(process.argv.indexOf('--') + 1);
  const fromEnv = (process.env.SEAMUX_OPEN || '').split(':').filter(Boolean);
  const raw = (process.argv.includes('--') ? fromArgv : []).concat(fromEnv);
  const seen = new Set();
  return raw
    .map((d) => path.resolve(d.replace(/^~/, app.getPath('home'))))
    .filter((d) => {
      if (seen.has(d)) return false;
      seen.add(d);
      try { return fs.statSync(d).isDirectory(); } catch { return false; }
    });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 900,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Packaged builds take the icon from build/icon.icns, but a dev run shows the
  // stock Electron icon unless the dock is told otherwise.
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(path.join(__dirname, '..', '..', 'assets', 'icon.png')); } catch { /* non-fatal */ }
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
 * The payoff of the whole app: when a session starts waiting on you and you
 * aren't looking at it, say so. We deliberately do NOT notify for a session
 * that is already on screen and focused -- you can see it.
 */
function maybeNotify(s) {
  if (s.state !== State.NEEDS_INPUT) return;
  const looking = win && win.isFocused() && activeSessionId === s.id;
  if (looking) return;

  new Notification({
    title: `${s.title} needs you`,
    body: s.reason,
    silent: false,
  })
    .on('click', () => {
      if (win) { win.show(); win.focus(); }
      send('ui:focusSession', { id: s.id });
    })
    .show();
}

function updateBadge() {
  if (process.platform !== 'darwin' || !ptys) return;
  const waiting = ptys.list().filter((s) => s.state === State.NEEDS_INPUT).length;
  app.dock.setBadge(waiting ? String(waiting) : '');
}

function wirePtys() {
  ptys = new PtyManager(path.join(app.getPath('userData'), 'context'));

  ptys.on('data', (p) => send('session:data', p));
  ptys.on('exit', (p) => send('session:exit', p));
  ptys.on('restarted', (p) => send('session:restarted', p));
  ptys.on('status', (s) => {
    send('session:status', s);
    maybeNotify(s);
    updateBadge();
  });
}

/**
 * Session instructions ride in on --append-system-prompt. Only added for the
 * real claude binary: tests (and anyone pointing SEAMUX_CLAUDE_BIN at a shell)
 * would choke on a flag their program does not know.
 *
 * Note this puts the text in the process argument list, which is visible to
 * other processes of this user. Instructions are prose, not credentials --
 * credentials belong in variables, which are not exposed that way.
 */
/**
 * How a session is launched is entirely the profile's business: which binary,
 * which flag carries standing instructions, whether an opening prompt is a
 * positional argument or a flag. See profiles.js.
 */
function profileFor(cwd, explicitId) {
  const id = explicitId || (cwd ? store.profileFor(cwd) : null) || 'claude';
  return profiles.get(id, store.customProfiles());
}

function buildArgs(profile, instructions, prePrompts, session = {}) {
  const extra = (process.env.SEAMUX_EXTRA_ARGS || process.env.SEAMUX_CLAUDE_ARGS || '')
    .split(' ').filter(Boolean);
  // Forcing Claude Code's own session id lets the knowledge server be asked
  // later about exactly this pane's session (the Artifacts panel), and lets a
  // board task resume the same conversation after a restart.
  // Only the claude profile understands --session-id / --resume.
  // The knowledge server, so the agent can search and save knowledge itself.
  // --mcp-config takes several values, so it must be followed by another
  // option, never by the positional opening prompt: --session-id / --resume
  // always come right after it (both are set whenever this is).
  if (session.mcpConfig && session.id && profile.id === 'claude') extra.push('--mcp-config', session.mcpConfig);
  if (session.id && profile.id === 'claude') extra.push(session.resume ? '--resume' : '--session-id', session.id);
  return profiles.buildArgs(profile, {
    instructions: instructions || [],
    prePrompts: prePrompts || [],
    extra,
  });
}

/** A fresh Claude session id for a pane about to be (re)spawned, or null for
 * other profiles. Never reused across a respawn -- a restart
 * is a new conversation, so it gets a new id too.
 *
 * Gated on the RESOLVED command being literally 'claude', not just the
 * profile id: SEAMUX_CLAUDE_BIN swaps in /bin/bash for tests (and could point
 * a real user at a custom binary of unknown flag support), and an
 * unrecognized --session-id makes bash exit(2) immediately -- confirmed by
 * hand: `bash --session-id x` -> "invalid option", never spawns.
 */
function newAgentSessionId(profile) {
  return (profile.id === 'claude' && profiles.commandFor(profile) === 'claude')
    ? crypto.randomUUID() : null;
}

/**
 * Re-resolve context for running sessions and flag any that now differ.
 *
 * Context can change from several places that are nowhere near a session:
 * binding a set to a project, editing a value, adding a source, deleting a set.
 * Without this, a running session silently keeps its spawn-time environment and
 * nothing in the UI says so -- which is exactly how a session ended up not
 * knowing about credentials that had been added to its project.
 *
 * A session that the user pointed at specific context by hand is left alone;
 * otherwise it follows its project's bindings.
 */
async function reconcileSessions(filter = {}) {
  for (const info of ptys.list()) {
    const project = info.projectCwd || info.cwd;
    if (filter.cwd && project !== filter.cwd) continue;
    const session = ptys.sessions.get(info.id);
    if (!session) continue;

    const ids = session.contextOverridden ? (info.envSetIds || []) : store.envSetsFor(project);
    const { vars, warnings, names, instructions, prePrompts } = await envs.resolveMany(ids);
    const before = (info.envKeys || []).join(',');

    const profile = profileFor(project, info.profileId);
    const rules = projectRules(project, profile);
    ptys.setContext(info.id, {
      vars, args: buildArgs(profile, [...rules.instructions, ...instructions], [...rules.prompts, ...prePrompts]),
      envSetIds: ids, envSetNames: names, envWarnings: warnings,
      instructionCount: profile.instructions.mode === 'none' ? 0 : instructions.length,
      prePromptCount: profile.prompt.mode === 'none' ? 0 : prePrompts.length,
    });

    const after = Object.keys(vars).sort();
    if (after.join(',') !== before) injectContextNotice(info.id, after, names, instructions);
  }
}

/**
 * Tell a running session that its context changed.
 *
 * Environment variables cannot be altered in a live process, so without this a
 * session simply never learns about credentials added after it started -- which
 * is what happened. The notice carries variable NAMES and the path to load them
 * from; the values themselves stay in the 0600 context file and never enter the
 * conversation.
 */
function injectContextNotice(id, keys, setNames, instructions) {
  const parts = [];
  if (keys.length) {
    parts.push(`[Seamux] Context updated${setNames.length ? ` (${setNames.join(', ')})` : ''}: `
      + `${keys.length} value${keys.length === 1 ? '' : 's'} available — ${keys.join(', ')}. `
      + 'They are NOT in your environment yet; load them first with: '
      + 'set -a; . "$SEAMUX_CONTEXT_FILE"; set +a');
  } else {
    parts.push('[Seamux] Context was removed from this session. '
      + '$SEAMUX_CONTEXT_FILE is now empty; ignore any values you loaded from it earlier.');
  }
  if (instructions && instructions.length) {
    parts.push(`Also note for the rest of this session: ${instructions.join(' ')}`);
  }
  ptys.queueInjection(id, parts.join(' '));
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Session',
      submenu: [
        {
          label: 'New Session…',
          accelerator: 'CmdOrCtrl+T',
          click: () => send('ui:newSession'),
        },
        {
          label: 'New Task…',
          accelerator: 'CmdOrCtrl+N',
          click: () => send('ui:newTask'),
        },
        {
          label: 'Promote Selection to Project Rule…',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => send('ui:promoteRule'),
        },
        {
          label: 'Project Rules…',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => send('ui:projectRules'),
        },
        {
          label: 'Task Details',
          accelerator: 'CmdOrCtrl+I',
          click: () => send('ui:taskDrawer'),
        },
        {
          label: 'Next Task That Needs You',
          accelerator: 'CmdOrCtrl+J',
          click: () => send('ui:nextNeeds'),
        },
        { type: 'separator' },
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
          label: `Go to Session ${n}`,
          accelerator: `CmdOrCtrl+${n}`,
          click: () => send('ui:focusSession', { index: n - 1 }),
        })),
      ],
    },
    {
      label: 'Edit',
      submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Board',
          accelerator: 'CmdOrCtrl+B',
          click: () => send('ui:toggleBoard'),
        },
        {
          label: 'Context',
          accelerator: 'CmdOrCtrl+E',
          click: () => send('ui:toggleEnv'),
        },
        {
          label: 'Toggle Detector Debug',
          accelerator: 'CmdOrCtrl+D',
          click: () => send('ui:toggleDebug'),
        },
        {
          label: 'Knowledge Server…',
          click: () => send('ui:knowledge'),
        },
        {
          label: 'Artifacts',
          accelerator: 'CmdOrCtrl+Shift+A',
          click: () => send('ui:toggleArtifacts'),
        },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Start a terminal. Plain sessions and board tasks both come through here.
 *
 * For a task: `taskId` ties the pane to its card, `taskPrompts` are added to
 * the opening prompt, and `resumeSessionId` continues an earlier conversation
 * instead of starting a new one. A resumed conversation already has its
 * opening prompt, so none is sent again.
 */
async function createSession(o) {
  if (o.cwd) store.addProject(o.cwd);
  // Explicit ids win over the project's bindings, so a one-off session can
  // opt into a different environment without changing the binding.
  const ids = o.envSetIds || (o.cwd ? store.envSetsFor(o.cwd) : []);
  const { vars, warnings, names, instructions, prePrompts } = await envs.resolveMany(ids);
  const profile = profileFor(o.cwd, o.profileId);
  const dropped = profiles.unsupported(profile);
  const resume = !!o.resumeSessionId;
  const sessionId = resume ? o.resumeSessionId : newAgentSessionId(profile);
  const rules = projectRules(o.cwd, profile, { resume });
  const prompts = resume ? [] : [...rules.prompts, ...prePrompts, ...(o.taskPrompts || [])];
  const mcpConfig = profile.id === 'claude' && profiles.commandFor(profile) === 'claude' ? knowledgeMcpFile() : null;
  const { resumeSessionId, taskPrompts, runCwd, ...rest } = o;
  return ptys.create({
    ...rest,
    cwd: runCwd || o.cwd,
    projectCwd: o.cwd,
    projectRuleCount: rules.count, rulesVia: rules.via, rulesVersion: rules.version,
    command: o.command || profiles.commandFor(profile),
    args: buildArgs(profile, [...rules.instructions, ...instructions], prompts, { id: sessionId, resume, mcpConfig }),
    agentSessionId: sessionId,
    env: vars, envSetIds: ids, envSetNames: names, envWarnings: warnings,
    instructionCount: profile.instructions.mode === 'none' ? 0 : instructions.length,
    prePromptCount: profile.prompt.mode === 'none' ? 0 : prompts.length,
    profileId: profile.id, profileLabel: profile.label, rules: profile.rules,
    // Say what this agent cannot carry rather than dropping it silently.
    envWarnings: [...warnings, ...(dropped.length && (instructions.length || prompts.length)
      ? [`${profile.label} has no way to take ${dropped.join(' or ')} — that part of the context was not applied.`]
      : [])],
  });
}

/**
 * Write the knowledge server's agent config where Claude Code can read it
 * (--mcp-config). Owner-only, because it can carry the server's headers.
 * Returns null when there is no server or agent access is off.
 */
function knowledgeMcpFile() {
  const cfg = knowledge && knowledge.agentConfig();
  const file = path.join(app.getPath('userData'), 'knowledge-mcp.json');
  const fs = require('fs');
  if (!cfg) { try { fs.unlinkSync(file); } catch { /* none */ } return null; }
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return file;
}

/** Record a rule on the knowledge server, if a "save" call is set up. Never blocks the UI. */
function saveRuleToKnowledge(cwd, text) {
  if (!knowledge || !knowledge.mapped('save')) return;
  knowledge.saveRule({ rule: text, 'project.path': cwd, 'project.name': projectName(cwd) })
    .then(() => send('knowledge:status', { ok: true, message: 'Rule saved to the knowledge server.' }))
    .catch((err) => send('knowledge:status', { ok: false, message: `Could not save the rule to the knowledge server: ${err.message}` }));
}

function wireKnowledge() {
  knowledge = new KnowledgeClient({
    getConfig: () => store.data.knowledge || null,
    secrets: {
      read: () => secrets.data,
      write: (v) => { secrets.data = v; secrets.save(); },
    },
    openExternal: (url) => shell.openExternal(url),
  });

  // Header values never leave the main process; the renderer sees names only.
  const describe = () => {
    const k = secrets.data.knowledge || {};
    return {
      config: store.data.knowledge || null,
      examples: KNOWLEDGE_EXAMPLES,
      headerNames: Object.keys(k.headers || {}),
      signedIn: !!(k.oauth && k.oauth.tokens),
      configured: knowledge.configured(),
      mapped: { save: knowledge.mapped('save'), importRules: knowledge.mapped('importRules'), sessionArtifacts: knowledge.mapped('sessionArtifacts') },
    };
  };
  ipcMain.handle('knowledge:get', () => describe());
  ipcMain.handle('knowledge:set', async (_e, { config, headers }) => {
    store.data.knowledge = config && config.server && config.server.type !== 'none' ? config : null;
    store.save();
    if (headers) {   // { NAME: value } replaces all headers; null keeps them
      secrets.data = { ...secrets.data, knowledge: { ...(secrets.data.knowledge || {}), headers } };
      secrets.save();
    }
    await knowledge.close();
    send('knowledge:changed', describe());
    return describe();
  });
  // Test the settings on screen without saving them: a throwaway client with
  // the draft config, and the draft headers over the saved ones.
  ipcMain.handle('knowledge:test', async (_e, draft) => {
    const probe = draft ? new KnowledgeClient({
      getConfig: () => draft.config,
      secrets: {
        read: () => (draft.headers
          ? { ...secrets.data, knowledge: { ...(secrets.data.knowledge || {}), headers: draft.headers } }
          : secrets.data),
        write: () => {},
      },
    }) : knowledge;
    try { return { ok: true, tools: await probe.listTools() }; }
    catch (err) { return { ok: false, error: err.message, needsSignIn: !!err.needsSignIn }; }
    finally { if (probe !== knowledge) await probe.close(); }
  });
  ipcMain.handle('knowledge:signIn', async () => {
    try { await knowledge.signIn(); send('knowledge:changed', describe()); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('knowledge:signOut', async () => { await knowledge.signOut(); send('knowledge:changed', describe()); return describe(); });
  ipcMain.handle('knowledge:importRules', async (_e, cwd) => {
    try { return { ok: true, rules: await knowledge.importRules({ 'project.path': cwd, 'project.name': projectName(cwd) }) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
}

function projectName(cwd) {
  const p = store.projects().find((x) => x.cwd === cwd);
  return (p && p.name) || path.basename(cwd || '') || cwd;
}

/**
 * How a project's rules reach a new terminal. They belong in the system
 * prompt, where they hold for the whole session and survive compaction. An
 * agent with no such option gets them in its opening message instead, which
 * a resumed conversation does not receive again.
 */
function projectRules(cwd, profile, { resume = false } = {}) {
  const list = cwd ? board.rulesFor(cwd) : [];
  const version = cwd ? board.rulesVersion(cwd) : null;
  const text = rulesText(list, cwd ? projectName(cwd) : '');
  const none = { instructions: [], prompts: [], count: list.length, version };
  if (!text) return { ...none, via: 'none' };
  if (profile.instructions.mode === 'flag') return { ...none, instructions: [text], via: 'system' };
  if (profile.prompt.mode !== 'none' && !resume) return { ...none, prompts: [text], via: 'opening' };
  return { ...none, via: 'none' };
}

/**
 * Tell every running terminal of a project that its rules changed. Typed in
 * at the session's next prompt, with the full current list, so a session
 * never has to piece the rules together from several notices. Plain shells
 * are skipped: the text would run as a command.
 */
function announceRules(cwd, change) {
  const list = board.rulesFor(cwd);
  const version = board.rulesVersion(cwd);
  const current = list.length
    ? `Current project rules: ${list.map((r, i) => `${i + 1}. ${r.text}`).join(' ')}`
    : 'This project has no rules now.';
  let told = 0;
  for (const info of ptys.list()) {
    if (info.exited || (info.projectCwd || info.cwd) !== cwd || info.profileId === 'shell') continue;
    if (!ptys.queueInjection(info.id, `[Seamux] Project rules changed: ${change}. ${current} Follow them for the rest of this session.`)) continue;
    const via = info.rulesVia === 'none' ? 'notice' : info.rulesVia;
    send('session:status', ptys.setRulesInfo(info.id, { count: list.length, version, via }));
    told++;
  }
  runner.emit('changed');
  return told;
}

/**
 * Where a task's terminal runs. Decided once, at its first start, and kept
 * after that: its conversation (claude --resume looks in the folder it began
 * in) and its changes live there.
 *   worktree  its own git worktree; refused if the project is not in git
 *   main      the project's own folder
 *   auto      a worktree when the project allows more than one terminal at
 *             once and is in git; otherwise the project's folder
 */
async function taskRunCwd(task) {
  const fs = require('fs');
  if (task.worktree && fs.existsSync(task.worktree.path)) return task.worktree.runCwd;
  if (task.worktree) {
    // Removed earlier: check its kept branch out again, at the same path, so
    // a resumed conversation finds its folder.
    const w = await worktrees.create({
      projectCwd: task.cwd, task, baseDir: path.join(app.getPath('userData'), 'worktrees'),
      name: path.basename(task.worktree.path),
    });
    board.setWorktree(task.id, { ...w, base: task.worktree.base });
    return w.runCwd;
  }
  if (task.sessionId && !task.worktree) return task.cwd;   // began in the project folder
  let want = task.isolation === 'worktree';
  if (task.isolation === 'auto') want = board.limitFor(task.cwd) > 1 && !!(await worktrees.repoRoot(task.cwd));
  if (!want) return task.cwd;
  const w = await worktrees.create({ projectCwd: task.cwd, task, baseDir: path.join(app.getPath('userData'), 'worktrees') });
  board.setWorktree(task.id, w);
  return w.runCwd;
}

/** Refresh a task's +/- line counts from its worktree. Quiet on failure. */
async function refreshDiffStat(taskId) {
  const t = board.get(taskId);
  if (!t || !t.worktree || !require('fs').existsSync(t.worktree.path)) return null;
  try {
    const st = await worktrees.stat(t.worktree.path, t.worktree.base);
    board.setDiffStat(taskId, st);
    runner.emit('changed');
    return st;
  } catch { return null; }
}

/** Spawn the one terminal a board task owns. Used by the TaskRunner. */
async function spawnTask(task) {
  const runCwd = await taskRunCwd(task);
  task = board.get(task.id);
  const profile = profileFor(task.cwd, task.agent);
  // Only the real claude binary can resume; anything else starts fresh.
  const canResume = profile.id === 'claude' && profiles.commandFor(profile) === 'claude';
  const resume = canResume && task.sessionId ? task.sessionId : null;
  const meta = await createSession({
    cwd: task.cwd,
    runCwd,
    title: task.title,
    profileId: profile.id,
    taskId: task.id,
    resumeSessionId: resume,
    taskPrompts: resume ? [] : [openingPrompt(task)],
  });
  if (!resume) board.setSessionId(task.id, meta.agentSessionId || null);
  send('session:created', meta);
  return meta;
}

/** Everything the board view needs, in one payload. */
function boardSnapshot() {
  const panes = ptys.list();
  const known = new Map(store.projects().map((p) => [p.cwd, p]));
  // A task keeps its lane even if its project was removed from the sidebar.
  for (const t of board.list()) {
    if (!known.has(t.cwd)) known.set(t.cwd, { cwd: t.cwd, name: path.basename(t.cwd) || t.cwd, envSetIds: [] });
  }
  const projects = [...known.values()].map((p) => {
    const live = panes.filter((s) => s.taskId && !s.exited && (s.projectCwd || s.cwd) === p.cwd).length;
    return { ...p, limit: board.limitFor(p.cwd), live, ruleCount: board.rulesFor(p.cwd).length, rulesVersion: board.rulesVersion(p.cwd) };
  });
  const tasks = board.list().map((t) => {
    const pane = panes.find((s) => s.taskId === t.id);
    return {
      ...t,
      pane: pane ? {
        id: pane.id, state: pane.state, reason: pane.reason, exited: !!pane.exited,
        projectRuleCount: pane.projectRuleCount, rulesVia: pane.rulesVia, rulesVersion: pane.rulesVersion,
      } : null,
    };
  });
  return {
    projects,
    tasks,
    globalLimit: board.globalLimit(),
    liveTotal: panes.filter((s) => s.taskId && !s.exited).length,
  };
}

function wireBoard() {
  board = new Board(path.join(app.getPath('userData'), 'board.json'));
  // No terminal survives an app restart: tasks left running go back to Ready
  // and resume their conversation when started again.
  board.recoverAfterRestart();
  runner = new TaskRunner({ board, ptys, spawn: spawnTask });
  runner.on('changed', () => send('board:changed', boardSnapshot()));
  ptys.on('exit', (p) => {
    const info = ptys.list().find((s) => s.id === p.id);
    if (info && info.taskId) runner.terminalEnded().catch(() => {});
  });

  // The agent's latest message becomes the card's next step when it stops.
  const lastState = new Map();
  ptys.on('status', (s) => {
    const prev = lastState.get(s.id);
    lastState.set(s.id, s.state);
    if (!s.taskId || !board.get(s.taskId)) return;
    const stopped = (prev === State.RUNNING || prev === State.STARTING)
      && (s.state === State.IDLE || s.state === State.NEEDS_INPUT);
    if (!stopped) return;
    const text = extractNextStep(ptys.screenText(s.id), s.profileId);
    if (text) { board.setNextStep(s.taskId, text); runner.emit('changed'); }
    refreshDiffStat(s.taskId);
  });

  ipcMain.handle('board:diff', async (_e, id) => {
    const t = board.get(id);
    if (!t || !t.worktree) return { ok: false, error: 'this task runs in the project’s own folder, so it has no diff of its own' };
    if (!require('fs').existsSync(t.worktree.path)) return { ok: false, error: 'this task’s worktree was removed' };
    try {
      const d = await worktrees.diff(t.worktree.path, t.worktree.base);
      const stat = await refreshDiffStat(id);
      return { ok: true, ...d, stat, branch: t.worktree.branch, base: t.worktree.base, path: t.worktree.path };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('board:removeWorktree', async (_e, id) => {
    const t = board.get(id);
    if (!t || !t.worktree) throw new Error('this task has no worktree');
    const pane = runner.paneOf(id);
    if (pane && !pane.exited) throw new Error('close the task’s terminal first');
    const r = await worktrees.remove(t.worktree);
    // Keep the record: the branch still holds the work.
    board.setWorktree(id, { ...t.worktree, removed: true });
    runner.emit('changed');
    return r;
  });

  ipcMain.handle('board:get', () => boardSnapshot());
  ipcMain.handle('board:wait', (_e, { id, waitingFor }) => {
    const t = board.setWaiting(id, waitingFor);
    runner.emit('changed');
    return t;
  });

  ipcMain.handle('rules:list', (_e, cwd) => ({
    rules: board.rulesFor(cwd),
    version: board.rulesVersion(cwd),
    running: ptys.list().filter((s) => !s.exited && (s.projectCwd || s.cwd) === cwd && s.profileId !== 'shell').length,
  }));
  ipcMain.handle('rules:add', (_e, { cwd, text }) => {
    const r = board.addRule(cwd, text);
    store.addProject(cwd);
    saveRuleToKnowledge(cwd, r.text);
    return { rule: r, told: announceRules(cwd, `added "${r.text}"`) };
  });
  ipcMain.handle('rules:update', (_e, { cwd, id, text }) => {
    const r = board.updateRule(cwd, id, text);
    saveRuleToKnowledge(cwd, r.text);
    return { rule: r, told: announceRules(cwd, `changed a rule to "${r.text}"`) };
  });
  ipcMain.handle('rules:remove', (_e, { cwd, id }) => {
    const gone = board.rulesFor(cwd).find((r) => r.id === id);
    board.removeRule(cwd, id);
    return { told: announceRules(cwd, `removed "${gone ? gone.text : id}"`) };
  });
  ipcMain.handle('board:create', async (_e, o) => {
    const t = board.create(o || {});
    store.addProject(t.cwd);
    runner.emit('changed');
    if (o && o.start) await runner.start(t.id);
    return board.get(t.id);
  });
  ipcMain.handle('board:update', (_e, { id, patch }) => {
    const t = board.update(id, patch);
    runner.emit('changed');
    return t;
  });
  ipcMain.handle('board:move', (_e, { id, status }) => runner.move(id, status));
  ipcMain.handle('board:start', (_e, id) => runner.start(id));
  ipcMain.handle('board:remove', (_e, id) => { runner.remove(id); return true; });
  ipcMain.handle('board:setLimit', async (_e, { cwd, limit }) => {
    const v = board.setLimit(cwd, limit);
    runner.emit('changed');
    await runner.pump();
    return v;
  });
  ipcMain.handle('board:setGlobalLimit', async (_e, limit) => {
    const v = board.setGlobalLimit(limit);
    runner.emit('changed');
    await runner.pump();
    return v;
  });
}

function wireIpc() {
  ipcMain.handle('sessions:list', () => ptys.list());
  ipcMain.handle('sessions:create', (_e, opts) => createSession(opts || {}));

  // Context is owned by the session. Changing it rewrites the live context file
  // at once; the process's own env keeps its spawn-time values until a restart.
  ipcMain.handle('sessions:setContext', async (_e, { id, envSetIds }) => {
    const { vars, warnings, names, instructions, prePrompts } = await envs.resolveMany(envSetIds || []);
    const session = ptys.sessions.get(id);
    if (session) session.contextOverridden = true;   // stop following the project
    return ptys.setContext(id, {
      vars, args: buildArgs(profileFor(null, (ptys.list().find((x) => x.id === id) || {}).profileId), instructions, prePrompts),
      envSetIds: envSetIds || [], envSetNames: names, envWarnings: warnings,
      instructionCount: instructions.length, prePromptCount: prePrompts.length,
    });
  });

  ipcMain.handle('sessions:restart', async (_e, { id, envSetIds }) => {
    const current = ptys.list().find((s) => s.id === id);
    const ids = envSetIds || (current ? current.envSetIds : []) || [];
    const { vars, warnings, names, instructions, prePrompts } = await envs.resolveMany(ids);
    const profile = profileFor(null, (current || {}).profileId);
    const agentSessionId = newAgentSessionId(profile);
    // A task's restarted terminal is a fresh conversation, so it gets the
    // task's opening message again.
    const task = current && current.taskId ? board.get(current.taskId) : null;
    const projectCwd = current ? (current.projectCwd || current.cwd) : null;
    const rules = projectRules(projectCwd, profile);
    const prompts = [...rules.prompts, ...prePrompts, ...(task ? [openingPrompt(task)] : [])];
    const info = ptys.restart(id, {
      vars, args: buildArgs(profile, [...rules.instructions, ...instructions], prompts, { id: agentSessionId }),
      agentSessionId,
      envSetIds: ids, envSetNames: names, envWarnings: warnings,
      instructionCount: instructions.length, prePromptCount: prompts.length,
    });
    ptys.setRulesInfo(id, { count: rules.count, via: rules.via, version: rules.version });
    // A restart is a new conversation; a task resumes the new one from now on.
    if (task) board.setSessionId(task.id, agentSessionId);
    if (current && current.taskId) runner.emit('changed');
    return ptys.list().find((s) => s.id === id) || info;
  });

  // ---- general context (the global CLAUDE.md every session reads) ----
  // The global-rules file belongs to the agent: CLAUDE.md, GEMINI.md, AGENTS.md…
  ipcMain.handle('general:setProfile', (_e, profileId) => {
    const prof = profiles.get(profileId, store.customProfiles());
    if (!process.env.SEAMUX_GENERAL_CONTEXT) {
      general = new GeneralContext(prof.globalRules ? profiles.expand(prof.globalRules) : null);
    }
    return { profile: prof.id, label: prof.label, supported: !!prof.globalRules, ...general.read() };
  });

  ipcMain.handle('profiles:list', () => profiles.list(store.customProfiles()).map((p) => ({
    id: p.id, label: p.label, command: p.command, verified: p.verified,
    custom: !!p.custom, unverifiedNote: p.unverifiedNote || null,
    globalRules: p.globalRules, unsupported: profiles.unsupported(p),
  })));
  ipcMain.handle('profiles:setForProject', (_e, { cwd, profileId }) => {
    store.setProfile(cwd, profileId);
    return store.projects();
  });
  ipcMain.handle('profiles:saveCustom', (_e, def) => store.saveCustomProfile(def));
  ipcMain.handle('profiles:removeCustom', (_e, id) => { store.removeCustomProfile(id); return store.customProfiles(); });

  ipcMain.handle('general:read', () => general.read());
  ipcMain.handle('general:preview', (_e, text) => general.preview(text));
  ipcMain.handle('general:write', (_e, { text, mtime }) => general.write(text, mtime));
  ipcMain.handle('general:backups', () => general.backups());
  ipcMain.handle('general:restore', (_e, name) => general.restore(name));
  ipcMain.handle('sessions:kill', (_e, id) => ptys.kill(id));
  ipcMain.handle('sessions:remove', async (_e, id) => {
    const info = ptys.list().find((s) => s.id === id);
    ptys.remove(id);
    updateBadge();
    if (info && info.taskId) await runner.paneClosed(info.taskId);
  });
  ipcMain.handle('sessions:replay', (_e, id) => ptys.replay(id));
  ipcMain.handle('sessions:screenText', (_e, id) => ptys.screenText(id));
  // What a terminal's session produced, from the knowledge server's
  // "sessionArtifacts" call. Never rejects: a missing or broken server shows
  // as a message in the panel.
  ipcMain.handle('artifacts:forSession', async (_e, id) => {
    const info = ptys.list().find((s) => s.id === id);
    if (!knowledge.mapped('sessionArtifacts')) return { ok: false, unavailable: true, artifacts: [] };
    if (!info || !info.agentSessionId) return { ok: true, artifacts: [] };
    try { return { ok: true, artifacts: await knowledge.sessionArtifacts({ 'session.id': info.agentSessionId }) }; }
    catch (err) { return { ok: false, artifacts: [], error: err.message }; }
  });
  ipcMain.handle('sessions:markRead', (_e, id) => {
    activeSessionId = id;
    ptys.markRead(id);
    updateBadge();
  });

  ipcMain.on('sessions:write', (_e, { id, data }) => ptys.write(id, data));
  ipcMain.on('sessions:resize', (_e, { id, cols, rows }) => ptys.resize(id, cols, rows));

  ipcMain.handle('projects:list', () => store.projects());
  ipcMain.handle('projects:bind', async (_e, { cwd, ids }) => {
    store.bindEnvSets(cwd, ids);
    await reconcileSessions({ cwd });
    return store.projects();
  });

  // ---- environments ----
  ipcMain.handle('env:status', () => ({
    available: secrets.available(),
    encrypted: secrets.encrypted,
    file: secrets.file,
    loadError: secrets.loadError || null,
  }));
  ipcMain.handle('env:list', () => envs.describeAll());
  ipcMain.handle('env:describe', (_e, id) => envs.describe(id));
  ipcMain.handle('env:create', (_e, name) => envs.create(name));
  ipcMain.handle('env:rename', (_e, { id, name }) => envs.rename(id, name));
  ipcMain.handle('env:remove', async (_e, id) => {
    envs.remove(id); store.forgetEnvSet(id);
    await reconcileSessions();
    return envs.describeAll();
  });
  ipcMain.handle('env:addSource', async (_e, { id, source }) => {
    const r = envs.addSource(id, source); await reconcileSessions(); return r;
  });
  ipcMain.handle('env:updateSource', async (_e, { setId, sourceId, patch }) => {
    const r = envs.updateSource(setId, sourceId, patch); await reconcileSessions(); return r;
  });
  ipcMain.handle('env:removeSource', async (_e, { setId, sourceId }) => {
    const r = envs.removeSource(setId, sourceId); await reconcileSessions(); return r;
  });
  ipcMain.handle('env:setVar', async (_e, { setId, key, value }) => {
    const r = envs.setVar(setId, key, value); await reconcileSessions(); return r;
  });
  ipcMain.handle('env:removeVar', async (_e, { setId, key }) => {
    const r = envs.removeVar(setId, key); await reconcileSessions(); return r;
  });
  ipcMain.handle('env:reveal', (_e, { setId, key }) => envs.reveal(setId, key));

  // Pasted blob -> an inline source. Parsed in main so the renderer never has
  // to hold or re-send the raw text.
  ipcMain.handle('env:importText', async (_e, { id, text }) => {
    const vars = parseEnv(text);
    if (!Object.keys(vars).length) throw new Error('no KEY=value pairs found in that text');
    envs.addSource(id, { type: 'inline', vars });
    await reconcileSessions();
    return envs.describe(id);
  });

  // Parse without storing, so the wizard can show what it found as you type.
  // Only masked values come back.
  ipcMain.handle('env:preview', (_e, text) => {
    const { maskValue } = require('./dotenv');
    const vars = parseEnv(text);
    const keys = Object.keys(vars);
    return {
      count: keys.length,
      keys,
      masked: Object.fromEntries(keys.map((k) => [k, maskValue(vars[k])])),
    };
  });

  // The wizard builds a whole set in one call: nothing is written until the
  // user finishes, so cancelling half way leaves no orphan behind.
  ipcMain.handle('env:createFrom', async (_e, opts) => {
    const o = opts || {};
    const set = envs.create(o.name || 'secrets');
    try {
      if (o.text && o.text.trim()) {
        const vars = parseEnv(o.text);
        if (Object.keys(vars).length) envs.addSource(set.id, { type: 'inline', vars });
      }
      if (o.file) {
        if (o.fileMode === 'snapshot') {
          envs.addSource(set.id, {
            type: 'file', path: o.file, mode: 'snapshot',
            vars: parseEnv(require('fs').readFileSync(o.file, 'utf8')),
          });
        } else {
          envs.addSource(set.id, { type: 'file', path: o.file, mode: 'live' });
        }
      }
      if (o.command && o.command.trim()) {
        envs.addSource(set.id, { type: 'command', command: o.command.trim(), cwd: o.cwd || undefined });
      }
      if (o.variables && Object.keys(o.variables).length) {
        envs.addSource(set.id, { type: 'inline', vars: o.variables });
      }
      if (o.instructions && o.instructions.trim()) {
        envs.addSource(set.id, { type: 'instructions', text: o.instructions.trim() });
      }
      if (o.preprompt && o.preprompt.trim()) {
        envs.addSource(set.id, { type: 'preprompt', text: o.preprompt.trim() });
      }
      for (const cwd of o.projects || []) {
        store.bindEnvSets(cwd, [...new Set([...store.envSetsFor(cwd), set.id])]);
      }
      await reconcileSessions();
      return envs.describe(set.id);
    } catch (err) {
      envs.remove(set.id);   // never leave a half-built set behind
      throw err;
    }
  });

  // Just choose a file; the wizard decides what to do with the path.
  ipcMain.handle('env:chooseFile', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose a file with your secrets',
      properties: ['openFile'],
      defaultPath: app.getPath('home'),
    });
    if (r.canceled || !r.filePaths.length) return null;
    const file = r.filePaths[0];
    let preview = { count: 0, keys: [] };
    try {
      const { maskValue } = require('./dotenv');
      const vars = parseEnv(require('fs').readFileSync(file, 'utf8'));
      preview = {
        count: Object.keys(vars).length,
        keys: Object.keys(vars),
        masked: Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, maskValue(v)])),
      };
    } catch (err) { preview.error = String(err && err.message || err); }
    return { file, preview };
  });

  ipcMain.handle('env:previewCommand', async (_e, { command, cwd }) => {
    const { maskValue } = require('./dotenv');
    try {
      const set = envs.create('__preview__');
      envs.addSource(set.id, { type: 'command', command, cwd: cwd || undefined });
      const r = await envs.resolveSet(set.id);
      envs.remove(set.id);
      const keys = Object.keys(r.vars);
      return {
        count: keys.length, keys,
        masked: Object.fromEntries(keys.map((k) => [k, maskValue(r.vars[k])])),
        error: r.warnings[0] || null,
      };
    } catch (err) {
      return { count: 0, keys: [], masked: {}, error: String(err && err.message || err) };
    }
  });

  /**
   * Hand an arbitrary paste to a small model and get back a proposal.
   * Values are redacted to placeholders before anything is sent; see
   * interpreter.js. Returns a proposal for the user to confirm -- nothing is
   * stored by this call.
   */
  ipcMain.handle('env:interpret', async (_e, text) => {
    if (!String(text || '').trim()) throw new Error('nothing to interpret');
    return interpret(text, { cwd: app.getPath('home') });
  });

  ipcMain.handle('env:pickFile', async (_e, { id, mode }) => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose an env file',
      properties: ['openFile'],
      filters: [{ name: 'Env files', extensions: ['env', 'sh', 'txt', 'properties', ''] }],
      defaultPath: app.getPath('home'),
    });
    if (r.canceled || !r.filePaths.length) return null;
    const file = r.filePaths[0];
    if (mode === 'snapshot') {
      const fs2 = require('fs');
      envs.addSource(id, { type: 'file', path: file, mode: 'snapshot', vars: parseEnv(fs2.readFileSync(file, 'utf8')) });
    } else {
      envs.addSource(id, { type: 'file', path: file, mode: 'live' });
    }
    return envs.describe(id);
  });
  ipcMain.handle('projects:remove', (_e, cwd) => { store.removeProject(cwd); return store.projects(); });
  ipcMain.handle('projects:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose a project directory',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: store.data.lastCwd || app.getPath('home'),
    });
    if (r.canceled || !r.filePaths.length) return null;
    const cwd = r.filePaths[0];
    store.data.lastCwd = cwd;
    store.addProject(cwd);
    return { cwd, name: path.basename(cwd) };
  });
}

app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'seamux.json'));
  secrets = new SecretStore(path.join(app.getPath('userData'), 'seamux-secrets.json'));
  envs = new EnvManager(secrets);
  general = new GeneralContext(process.env.SEAMUX_GENERAL_CONTEXT || undefined);
  wirePtys();
  wireBoard();
  wireKnowledge();
  wireIpc();
  buildMenu();
  createWindow();

  win.webContents.once('did-finish-load', () => {
    for (const cwd of startupDirs()) {
      store.addProject(cwd);
      send('ui:openProject', { cwd, name: path.basename(cwd) });
    }
  });

  // Test seam: an end-to-end suite drives the real window through this.
  if (process.env.SEAMUX_E2E) {
    win.webContents.once('did-finish-load', () => {
      require(process.env.SEAMUX_E2E)({ win, ptys, store, app, board, runner });
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (ptys) ptys.dispose();
  if (knowledge) knowledge.close();
});
