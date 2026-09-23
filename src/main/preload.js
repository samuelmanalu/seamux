'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Explicit, minimal surface. The renderer never gets Node.
contextBridge.exposeInMainWorld('seamux', {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  createSession: (opts) => ipcRenderer.invoke('sessions:create', opts),
  killSession: (id) => ipcRenderer.invoke('sessions:kill', id),
  removeSession: (id) => ipcRenderer.invoke('sessions:remove', id),
  replay: (id) => ipcRenderer.invoke('sessions:replay', id),
  setSessionContext: (id, envSetIds) => ipcRenderer.invoke('sessions:setContext', { id, envSetIds }),
  restartSession: (id, envSetIds) => ipcRenderer.invoke('sessions:restart', { id, envSetIds }),
  markRead: (id) => ipcRenderer.invoke('sessions:markRead', id),
  screenText: (id) => ipcRenderer.invoke('sessions:screenText', id),

  write: (id, data) => ipcRenderer.send('sessions:write', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('sessions:resize', { id, cols, rows }),

  listProjects: () => ipcRenderer.invoke('projects:list'),
  bindEnvSets: (cwd, ids) => ipcRenderer.invoke('projects:bind', { cwd, ids }),

  envStatus: () => ipcRenderer.invoke('env:status'),
  envList: () => ipcRenderer.invoke('env:list'),
  envDescribe: (id) => ipcRenderer.invoke('env:describe', id),
  envCreate: (name) => ipcRenderer.invoke('env:create', name),
  envRename: (id, name) => ipcRenderer.invoke('env:rename', { id, name }),
  envRemove: (id) => ipcRenderer.invoke('env:remove', id),
  envAddSource: (id, source) => ipcRenderer.invoke('env:addSource', { id, source }),
  envUpdateSource: (setId, sourceId, patch) => ipcRenderer.invoke('env:updateSource', { setId, sourceId, patch }),
  envRemoveSource: (setId, sourceId) => ipcRenderer.invoke('env:removeSource', { setId, sourceId }),
  envSetVar: (setId, key, value) => ipcRenderer.invoke('env:setVar', { setId, key, value }),
  envRemoveVar: (setId, key) => ipcRenderer.invoke('env:removeVar', { setId, key }),
  envReveal: (setId, key) => ipcRenderer.invoke('env:reveal', { setId, key }),
  envImportText: (id, text) => ipcRenderer.invoke('env:importText', { id, text }),
  envPickFile: (id, mode) => ipcRenderer.invoke('env:pickFile', { id, mode }),
  envPreview: (text) => ipcRenderer.invoke('env:preview', text),
  envInterpret: (text) => ipcRenderer.invoke('env:interpret', text),
  envPreviewCommand: (command, cwd) => ipcRenderer.invoke('env:previewCommand', { command, cwd }),
  envChooseFile: () => ipcRenderer.invoke('env:chooseFile'),
  envCreateFrom: (opts) => ipcRenderer.invoke('env:createFrom', opts),

  profilesList: () => ipcRenderer.invoke('profiles:list'),
  setProjectProfile: (cwd, profileId) => ipcRenderer.invoke('profiles:setForProject', { cwd, profileId }),
  saveCustomProfile: (def) => ipcRenderer.invoke('profiles:saveCustom', def),
  removeCustomProfile: (id) => ipcRenderer.invoke('profiles:removeCustom', id),
  generalSetProfile: (profileId) => ipcRenderer.invoke('general:setProfile', profileId),

  generalRead: () => ipcRenderer.invoke('general:read'),
  generalPreview: (text) => ipcRenderer.invoke('general:preview', text),
  generalWrite: (text, mtime) => ipcRenderer.invoke('general:write', { text, mtime }),
  generalBackups: () => ipcRenderer.invoke('general:backups'),
  generalRestore: (name) => ipcRenderer.invoke('general:restore', name),
  pickProject: () => ipcRenderer.invoke('projects:pick'),
  removeProject: (cwd) => ipcRenderer.invoke('projects:remove', cwd),

  onData: (fn) => ipcRenderer.on('session:data', (_e, p) => fn(p)),
  onStatus: (fn) => ipcRenderer.on('session:status', (_e, p) => fn(p)),
  onExit: (fn) => ipcRenderer.on('session:exit', (_e, p) => fn(p)),
  onRestarted: (fn) => ipcRenderer.on('session:restarted', (_e, p) => fn(p)),
  onFocusSession: (fn) => ipcRenderer.on('ui:focusSession', (_e, p) => fn(p)),
  onToggleDebug: (fn) => ipcRenderer.on('ui:toggleDebug', () => fn()),
  onToggleEnv: (fn) => ipcRenderer.on('ui:toggleEnv', () => fn()),
  onNewSession: (fn) => ipcRenderer.on('ui:newSession', () => fn()),
  onOpenProject: (fn) => ipcRenderer.on('ui:openProject', (_e, p) => fn(p)),
});
