'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, Notification, Menu, shell } = require('electron');
const { PtyManager, State } = require('./pty-manager');
const { Store } = require('./store');
const { SecretStore } = require('./secrets');
const { EnvManager } = require('./env-manager');
const { parseEnv } = require('./dotenv');
const { GeneralContext } = require('./general-context');
const { interpret } = require('./interpreter');
const profiles = require('./profiles');

// Tests must never write into the real user's config. Set before anything
// reads a path, so store and secrets both land in the throwaway directory.
if (process.env.SEAMUX_USER_DATA) app.setPath('userData', process.env.SEAMUX_USER_DATA);

let win = null;
let ptys = null;
let store = null;
let secrets = null;
let envs = null;
let general = null;
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

function buildArgs(profile, instructions, prePrompts) {
  const extra = (process.env.SEAMUX_EXTRA_ARGS || process.env.SEAMUX_CLAUDE_ARGS || '')
    .split(' ').filter(Boolean);
  return profiles.buildArgs(profile, {
    instructions: instructions || [],
    prePrompts: prePrompts || [],
    extra,
  });
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
    if (filter.cwd && info.cwd !== filter.cwd) continue;
    const session = ptys.sessions.get(info.id);
    if (!session) continue;

    const ids = session.contextOverridden ? (info.envSetIds || []) : store.envSetsFor(info.cwd);
    const { vars, warnings, names, instructions, prePrompts } = await envs.resolveMany(ids);
    const before = (info.envKeys || []).join(',');

    const profile = profileFor(info.cwd, info.profileId);
    ptys.setContext(info.id, {
      vars, args: buildArgs(profile, instructions, prePrompts),
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
          label: 'Context',
          accelerator: 'CmdOrCtrl+E',
          click: () => send('ui:toggleEnv'),
        },
        {
          label: 'Toggle Detector Debug',
          accelerator: 'CmdOrCtrl+D',
          click: () => send('ui:toggleDebug'),
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

function wireIpc() {
  ipcMain.handle('sessions:list', () => ptys.list());
  ipcMain.handle('sessions:create', async (_e, opts) => {
    const o = opts || {};
    if (o.cwd) store.addProject(o.cwd);
    // Explicit ids win over the project's bindings, so a one-off session can
    // opt into a different environment without changing the binding.
    const ids = o.envSetIds || (o.cwd ? store.envSetsFor(o.cwd) : []);
    const { vars, warnings, names, instructions, prePrompts } = await envs.resolveMany(ids);
    const profile = profileFor(o.cwd, o.profileId);
    const dropped = profiles.unsupported(profile);
    return ptys.create({
      ...o,
      command: o.command || profiles.commandFor(profile),
      args: buildArgs(profile, instructions, prePrompts),
      env: vars, envSetIds: ids, envSetNames: names, envWarnings: warnings,
      instructionCount: profile.instructions.mode === 'none' ? 0 : instructions.length,
      prePromptCount: profile.prompt.mode === 'none' ? 0 : prePrompts.length,
      profileId: profile.id, profileLabel: profile.label, rules: profile.rules,
      // Say what this agent cannot carry rather than dropping it silently.
      envWarnings: [...warnings, ...(dropped.length && (instructions.length || prePrompts.length)
        ? [`${profile.label} has no way to take ${dropped.join(' or ')} — that part of the context was not applied.`]
        : [])],
    });
  });

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
    return ptys.restart(id, {
      vars, args: buildArgs(profileFor(null, (current || {}).profileId), instructions, prePrompts),
      envSetIds: ids, envSetNames: names, envWarnings: warnings,
      instructionCount: instructions.length, prePromptCount: prePrompts.length,
    });
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
  ipcMain.handle('sessions:remove', (_e, id) => { ptys.remove(id); updateBadge(); });
  ipcMain.handle('sessions:replay', (_e, id) => ptys.replay(id));
  ipcMain.handle('sessions:screenText', (_e, id) => ptys.screenText(id));
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
      require(process.env.SEAMUX_E2E)({ win, ptys, store, app });
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => { if (ptys) ptys.dispose(); });
