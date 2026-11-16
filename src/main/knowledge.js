'use strict';

const http = require('http');
const os = require('os');
const { EventEmitter } = require('events');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { UnauthorizedError } = require('@modelcontextprotocol/sdk/client/auth.js');

// A knowledge server is any MCP server the user installs. Seamux talks to it
// only through plain tool calls that the user maps in settings:
//
//   save              record a project rule when it is added or changed
//   importRules       a call whose result the user picks rules from
//   sessionArtifacts  what a terminal's session produced, for the Artifacts panel
//
// Nothing here knows any particular server. A mapping names a tool, gives its
// arguments as a template, and says how to read the result: JSON, or text
// lines kept by a pattern (whose first group, if any, is the value).
//
// No Electron in this file: opening the browser and storing secrets are passed
// in, so it can be tested with plain Node.

const CALL_TIMEOUT_MS = 30000;
const CONNECT_TIMEOUT_MS = 20000;

/* ---------------------------------------------------------------- templates */

/**
 * Fill {name} placeholders in every string of a template. A string that is
 * exactly one placeholder takes the value as is (so a number stays a number).
 */
function render(template, vars) {
  if (typeof template === 'string') {
    const whole = template.match(/^\{([\w.]+)\}$/);
    if (whole && whole[1] in vars) return vars[whole[1]];
    return template.replace(/\{([\w.]+)\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m));
  }
  if (Array.isArray(template)) return template.map((x) => render(x, vars));
  if (template && typeof template === 'object') {
    return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, render(v, vars)]));
  }
  return template;
}

/* ------------------------------------------------------------------ results */

function textOf(result) {
  return (result.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

function tryJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Lines kept by a pattern; the first capture group, if any, is the value. */
function pickLines(text, pattern) {
  let re = null;
  if (pattern) {
    try { re = new RegExp(pattern); } catch (e) { throw new Error(`the line pattern is not valid: ${e.message}`); }
  }
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (!re) { out.push(line); continue; }
    const m = line.match(re);
    if (m) out.push((m[1] !== undefined ? m[1] : line).trim());
  }
  return out;
}

const URL_RE = /https?:\/\/[^\s()<>"']+/;
const PATH_RE = /(?:^|[\s(])((?:~|\/)[^\s()]+\.[A-Za-z0-9]{1,6})(?=[\s)]|$)/;

/**
 * Turn a sessionArtifacts result into records the Artifacts panel can show
 * ({ content, source_file, created_at }).
 * - JSON array: objects with content/source_file, or title/url/path.
 * - Text: kept lines that name a link or a file.
 */
function parseArtifacts(text, pattern) {
  const json = tryJson(text);
  if (Array.isArray(json)) {
    return json.filter((x) => x && typeof x === 'object').map((x) => {
      if (x.content) return { content: String(x.content), source_file: x.source_file || x.url || x.path || null, created_at: x.created_at || x.createdAt || null };
      const loc = x.url || x.path || x.location || null;
      const kind = loc && !/^https?:/.test(loc) ? 'Document' : 'Artifact';
      return { content: `${kind}: ${x.title || x.name || 'Untitled'}${loc ? ` (${loc})` : ''}`, source_file: loc, created_at: x.created_at || x.createdAt || null };
    });
  }
  return pickLines(text, pattern)
    .map((line) => {
      const url = line.match(URL_RE);
      const file = line.match(PATH_RE);
      const loc = url ? url[0] : file ? file[1] : null;
      return loc ? { content: line, source_file: loc, created_at: null } : null;
    })
    .filter(Boolean);
}

/** Candidate rules from an importRules result, de-duplicated, in order. */
function parseRules(text, pattern) {
  const json = tryJson(text);
  const lines = Array.isArray(json)
    ? json.map((x) => (typeof x === 'string' ? x : x && (x.text || x.content || x.rule))).filter(Boolean).map(String)
    : pickLines(text, pattern);
  const seen = new Set();
  const out = [];
  for (const l of lines) {
    const rule = l.replace(/^(?:[-*•]|\d+[.)])\s+/, '').trim();
    if (rule && !seen.has(rule)) { seen.add(rule); out.push(rule); }
  }
  return out;
}

/* -------------------------------------------------------------------- OAuth */

/**
 * Browser sign-in for HTTP servers that need it (standard MCP OAuth). The
 * SDK drives the protocol; this class keeps the registration, the PKCE
 * verifier and the tokens in Seamux's encrypted store, and catches the
 * browser's redirect on a local port.
 */
class OAuthProvider {
  constructor({ store, openExternal, port, clientName }) {
    this.store = store;           // { read(): object, write(object) }
    this.openExternal = openExternal;
    this.port = port;
    this.clientName = clientName;
    this.waiting = null;          // { promise, server }
    // Only an explicit "Sign in" may open the browser. A background call
    // (saving a rule, say) that finds the token missing just fails with
    // "needs sign-in" instead of popping a browser window at the user.
    this.interactive = false;
    this.pendingCode = null;      // the code from the browser, once it arrives
  }

  get redirectUrl() { return `http://127.0.0.1:${this.port}/callback`; }

  get clientMetadata() {
    return {
      client_name: this.clientName,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  _get(k) { return (this.store.read() || {})[k]; }
  _set(k, v) { this.store.write({ ...(this.store.read() || {}), [k]: v }); }

  clientInformation() { return this._get('client'); }
  saveClientInformation(info) { this._set('client', info); }
  tokens() { return this._get('tokens'); }
  saveTokens(t) { this._set('tokens', t); }
  saveCodeVerifier(v) { this._set('verifier', v); }
  codeVerifier() {
    const v = this._get('verifier');
    if (!v) throw new Error('no sign-in in progress');
    return v;
  }
  invalidateCredentials(scope) {
    const cur = { ...(this.store.read() || {}) };
    if (scope === 'all' || scope === 'client') delete cur.client;
    if (scope === 'all' || scope === 'tokens') delete cur.tokens;
    if (scope === 'all' || scope === 'verifier') delete cur.verifier;
    this.store.write(cur);
  }

  /** Listen for the browser's redirect, then open the sign-in page. */
  async redirectToAuthorization(url) {
    if (!this.interactive) return;
    // Kept, not just awaited: a fast browser can deliver the code before the
    // caller starts waiting for it.
    this.pendingCode = this.waitForCode();
    this.pendingCode.catch(() => {});
    await this.openExternal(url.toString());
  }

  /** Resolves with the authorization code from the browser's redirect. */
  waitForCode(timeoutMs = 5 * 60 * 1000) {
    if (this.waiting) return this.waiting.promise;
    let server;
    const promise = new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        const u = new URL(req.url, this.redirectUrl);
        if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
        const code = u.searchParams.get('code');
        const error = u.searchParams.get('error');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(code
          ? '<p style="font-family:system-ui">Signed in. You can close this tab and return to Seamux.</p>'
          : `<p style="font-family:system-ui">Sign-in failed: ${String(error || 'no code').replace(/[<>&]/g, '')}</p>`);
        if (code) resolve(code); else reject(new Error(`sign-in failed: ${error || 'no code returned'}`));
      });
      server.on('error', reject);
      server.listen(this.port, '127.0.0.1');
      setTimeout(() => reject(new Error('sign-in timed out')), timeoutMs).unref();
    });
    const done = () => { try { server.close(); } catch { /* closed */ } this.waiting = null; };
    promise.then(done, done);
    this.waiting = { promise, server };
    return promise;
  }
}

/* ------------------------------------------------------------------- client */

class KnowledgeClient extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => object|null} o.getConfig     current settings (see README)
   * @param {{read(): object, write(object): void}} o.secrets  headers + OAuth state, encrypted by the caller
   * @param {(url: string) => any} [o.openExternal]
   * @param {number} [o.callbackPort]
   */
  constructor({ getConfig, secrets, openExternal = () => {}, callbackPort = 47811 }) {
    super();
    this.getConfig = getConfig;
    this.secrets = secrets;
    this.openExternal = openExternal;
    this.callbackPort = callbackPort;
    this.client = null;
    this.transport = null;
    this.key = null;
    this.connecting = null;
  }

  config() { return this.getConfig() || null; }

  configured() {
    const c = this.config();
    return !!(c && c.server && ((c.server.type === 'stdio' && c.server.command) || (c.server.type === 'http' && c.server.url)));
  }

  /** Which mapped calls are set up. */
  mapped(name) {
    const c = this.config();
    return !!(this.configured() && c[name] && c[name].tool);
  }

  _secretBag() {
    const all = this.secrets.read() || {};
    return all.knowledge || {};
  }

  _oauthStore() {
    return {
      read: () => this._secretBag().oauth || {},
      write: (v) => {
        const all = this.secrets.read() || {};
        this.secrets.write({ ...all, knowledge: { ...(all.knowledge || {}), oauth: v } });
      },
    };
  }

  _transport(server) {
    if (server.type === 'stdio') {
      // Spawned without a shell, so expand ~ here.
      const home = (x) => (typeof x === 'string' ? x.replace(/^~(?=\/|$)/, os.homedir()) : x);
      return new StdioClientTransport({
        command: home(server.command),
        args: (server.args || []).map(home),
        cwd: server.cwd || undefined,
        // Keep PATH, so a server started by name (uv, npx, python3) is found.
        env: { ...getDefaultEnvironment(), PATH: process.env.PATH || '', ...(server.env || {}) },
        stderr: 'pipe',
      });
    }
    const headers = { ...(this._secretBag().headers || {}) };
    this.oauth = server.oauth
      ? new OAuthProvider({ store: this._oauthStore(), openExternal: this.openExternal, port: this.callbackPort, clientName: 'Seamux' })
      : null;
    return new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: Object.keys(headers).length ? { headers } : undefined,
      authProvider: this.oauth || undefined,
    });
  }

  async connect() {
    const c = this.config();
    if (!this.configured()) throw new Error('no knowledge server is set up');
    const key = JSON.stringify(c.server);
    if (this.client && this.key === key) return this.client;
    if (this.connecting) return this.connecting;
    await this.close();
    this.connecting = (async () => {
      const transport = this._transport(c.server);
      const client = new Client({ name: 'seamux', version: '0.1.0' });
      const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('the knowledge server did not answer in time')), CONNECT_TIMEOUT_MS).unref());
      try {
        await Promise.race([client.connect(transport), timer]);
      } catch (err) {
        try { await transport.close(); } catch { /* closed */ }
        if (err instanceof UnauthorizedError || /unauthori[sz]ed|401/i.test(String(err && err.message))) {
          const e = new Error('the knowledge server needs you to sign in');
          e.needsSignIn = true;
          throw e;
        }
        throw err;
      }
      transport.onclose = () => { if (this.transport === transport) { this.client = null; this.transport = null; } };
      this.client = client;
      this.transport = transport;
      this.key = key;
      return client;
    })();
    try { return await this.connecting; } finally { this.connecting = null; }
  }

  /**
   * Sign in to an HTTP server with OAuth: open the browser, wait for the
   * redirect, then connect with the new token.
   */
  async signIn() {
    const c = this.config();
    if (!c || !c.server || c.server.type !== 'http' || !c.server.oauth) throw new Error('this server is not set up for browser sign-in');
    await this.close();
    const transport = this._transport(c.server);
    const client = new Client({ name: 'seamux', version: '0.1.0' });
    this.oauth.interactive = true;
    try {
      try {
        await client.connect(transport);
        // Already signed in.
        this.client = client; this.transport = transport; this.key = JSON.stringify(c.server);
        return { signedIn: true, already: true };
      } catch (err) {
        if (!(err instanceof UnauthorizedError) || !this.oauth.pendingCode) throw err;
      }
      const code = await this.oauth.pendingCode;
      await transport.finishAuth(code);
    } finally {
      this.oauth.interactive = false;
      this.oauth.pendingCode = null;
    }
    try { await transport.close(); } catch { /* closed */ }
    await this.connect();
    return { signedIn: true };
  }

  signOut() {
    const all = this.secrets.read() || {};
    this.secrets.write({ ...all, knowledge: { ...(all.knowledge || {}), oauth: {} } });
    return this.close();
  }

  async close() {
    const t = this.transport;
    this.client = null;
    this.transport = null;
    this.key = null;
    if (t) { try { await t.close(); } catch { /* closed */ } }
  }

  async listTools() {
    const client = await this.connect();
    const r = await client.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
    return (r.tools || []).map((t) => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || null }));
  }

  /** Call one tool; returns its text. A tool-reported error becomes a thrown error. */
  async call(tool, args) {
    const client = await this.connect();
    const r = await client.callTool({ name: tool, arguments: args || {} }, undefined, { timeout: CALL_TIMEOUT_MS });
    const text = textOf(r);
    if (r.isError) throw new Error(text || `${tool} failed`);
    return text;
  }

  /** Run a mapped call with its template filled in. */
  async run(name, vars) {
    const c = this.config();
    const m = c && c[name];
    if (!m || !m.tool) throw new Error(`no "${name}" call is set up`);
    return this.call(m.tool, render(m.args || {}, vars));
  }

  async saveRule(vars) { return this.run('save', vars); }

  async importRules(vars) {
    const text = await this.run('importRules', vars);
    return parseRules(text, this.config().importRules.linePattern);
  }

  async sessionArtifacts(vars) {
    const text = await this.run('sessionArtifacts', vars);
    return parseArtifacts(text, this.config().sessionArtifacts.linePattern);
  }

  /**
   * The server as an agent's MCP config entry (Claude Code's --mcp-config
   * format), so agents can search and save knowledge themselves.
   */
  agentConfig() {
    const c = this.config();
    if (!this.configured() || c.agentAccess === false) return null;
    const name = (c.name || 'knowledge').replace(/[^\w-]/g, '_');
    const s = c.server;
    const entry = s.type === 'stdio'
      ? { type: 'stdio', command: s.command, args: s.args || [], env: s.env || {} }
      : { type: 'http', url: s.url, ...(Object.keys(this._secretBag().headers || {}).length ? { headers: this._secretBag().headers } : {}) };
    return { mcpServers: { [name]: entry } };
  }
}

/**
 * A ready-made example for Jejak, shown in settings. It is only data: the
 * same fields any other server would fill in.
 */
const EXAMPLES = {
  jejak: {
    name: 'jejak',
    server: { type: 'stdio', command: 'uv', args: ['run', '--quiet', '--script', '~/.claude/hooks/jejak-mcp.py'] },
    save: {
      tool: 'jejak_save',
      args: { type: 'convention', content: 'RULE: {rule}', directory: '{project.path}' },
    },
    importRules: {
      tool: 'jejak_ask',
      args: { question: 'project rules RULE: for {project.name}', directory: '{project.path}' },
      linePattern: 'RULE: (.+)',
    },
    sessionArtifacts: {
      tool: 'jejak_session',
      args: { session_id: '{session.id}' },
      linePattern: '^(?:Artifact|Document): ',
    },
    agentAccess: true,
  },
};

module.exports = {
  KnowledgeClient, OAuthProvider, render, parseArtifacts, parseRules, pickLines, EXAMPLES,
};
