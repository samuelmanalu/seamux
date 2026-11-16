'use strict';

// KnowledgeClient against a fake MCP server, over stdio and over HTTP:
// templates, result parsing, mapped calls, errors, headers, agent config, and
// the OAuth redirect catcher.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { KnowledgeClient, OAuthProvider, render, parseArtifacts, parseRules, EXAMPLES } = require('../src/main/knowledge');

const FAKE = path.join(__dirname, 'fixtures', 'fake-mcp-server.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-know-'));
const LOG = path.join(dir, 'calls.log');
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);

const mappings = {
  save: { tool: 'save_note', args: { text: 'RULE: {rule}', project: '{project.path}' } },
  importRules: { tool: 'find_rules', args: { project: '{project.name}' }, linePattern: 'RULE: (.+)' },
  sessionArtifacts: { tool: 'session_items', args: { session_id: '{session.id}' }, linePattern: '^(?:Artifact|Document): ' },
};

function memSecrets(init = {}) {
  let v = init;
  return { read: () => v, write: (x) => { v = x; } };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('render fills placeholders and keeps unknown ones', () => {
  const out = render({ a: 'RULE: {rule}', b: ['{project.name}', 'x'], c: '{n}', d: '{missing}' }, { rule: 'R', 'project.name': 'P', n: 3 });
  assert.deepStrictEqual(out, { a: 'RULE: R', b: ['P', 'x'], c: 3, d: '{missing}' });
});

test('parseRules keeps matching lines, takes the group, drops duplicates and bullets', () => {
  assert.deepStrictEqual(parseRules('x\n RULE: A\nRULE: B\nRULE: A', 'RULE: (.+)'), ['A', 'B']);
  assert.deepStrictEqual(parseRules('- one\n2. two\n\n', null), ['one', 'two']);
  assert.deepStrictEqual(parseRules('["a", {"text": "b"}]', null), ['a', 'b']);
  assert.throws(() => parseRules('x', '('), /line pattern is not valid/);
});

test('parseArtifacts reads JSON or pattern-kept lines with a link or file', () => {
  const j = parseArtifacts('[{"title":"T","url":"https://x/y"},{"title":"N","path":"/tmp/n.md"}]');
  assert.deepStrictEqual(j.map((a) => a.source_file), ['https://x/y', '/tmp/n.md']);
  assert.match(j[1].content, /^Document: N \(\/tmp\/n\.md\)$/);
  const t = parseArtifacts('Artifact: A (https://x/a)\nnoise https://x/b\nDocument: D (~/d.md) — s', '^(?:Artifact|Document): ');
  assert.deepStrictEqual(t.map((a) => a.source_file), ['https://x/a', '~/d.md']);
});

test('stdio: lists tools and runs mapped calls', async () => {
  const k = new KnowledgeClient({
    getConfig: () => ({ server: { type: 'stdio', command: process.execPath, args: [FAKE], env: { FAKE_MCP_LOG: LOG } }, ...mappings }),
    secrets: memSecrets(),
  });
  try {
    assert.ok(k.configured() && k.mapped('save') && k.mapped('importRules'));
    const tools = (await k.listTools()).map((t) => t.name).sort();
    assert.deepStrictEqual(tools, ['broken', 'find_rules', 'save_note', 'session_items']);
    await k.saveRule({ rule: 'Never push', 'project.path': '/p', 'project.name': 'p' });
    assert.deepStrictEqual(calls().pop(), { tool: 'save_note', args: { text: 'RULE: Never push', project: '/p' } });
    assert.deepStrictEqual(await k.importRules({ 'project.name': 'shop' }), ['Never push to main', 'Run the tests before every commit']);
    const arts = await k.sessionArtifacts({ 'session.id': 'abc' });
    assert.deepStrictEqual(arts.map((a) => a.source_file), ['https://example.com/a/plan', '/tmp/runbook.md']);
    await assert.rejects(k.call('broken', {}), /it broke/);
    await assert.rejects(k.run('nothing', {}), /no "nothing" call/);
  } finally { await k.close(); }
});

test('not configured: clear errors, nothing mapped', async () => {
  const k = new KnowledgeClient({ getConfig: () => null, secrets: memSecrets() });
  assert.strictEqual(k.configured(), false);
  assert.strictEqual(k.mapped('save'), false);
  assert.strictEqual(k.agentConfig(), null);
  await assert.rejects(k.listTools(), /no knowledge server/);
});

test('a server that does not start gives an error, not a hang', async () => {
  const k = new KnowledgeClient({ getConfig: () => ({ server: { type: 'stdio', command: '/nonexistent/server' } }), secrets: memSecrets() });
  await assert.rejects(k.listTools());
  await k.close();
});

async function httpServer(token) {
  const port = 47900 + Math.floor(Math.random() * 50);
  const p = spawn(process.execPath, [FAKE, '--http', String(port)], { env: { ...process.env, FAKE_MCP_LOG: LOG, ...(token ? { FAKE_MCP_TOKEN: token } : {}) } });
  await new Promise((res, rej) => { p.stdout.on('data', (d) => { if (/READY/.test(d)) res(); }); p.on('exit', rej); });
  return { port, stop: () => p.kill() };
}

test('http: calls work, and secret headers are sent', async () => {
  const srv = await httpServer('tok123');
  const secrets = memSecrets({ knowledge: { headers: { Authorization: 'Bearer tok123' } } });
  const k = new KnowledgeClient({ getConfig: () => ({ server: { type: 'http', url: `http://127.0.0.1:${srv.port}/mcp` }, ...mappings }), secrets });
  try {
    assert.deepStrictEqual(await k.importRules({ 'project.name': 'x' }), ['Never push to main', 'Run the tests before every commit']);
  } finally { await k.close(); srv.stop(); }
});

test('http: a server that needs auth says so', async () => {
  const srv = await httpServer('tok123');
  const k = new KnowledgeClient({ getConfig: () => ({ server: { type: 'http', url: `http://127.0.0.1:${srv.port}/mcp` } }), secrets: memSecrets() });
  try {
    await assert.rejects(k.listTools(), (e) => e.needsSignIn === true || /401|unauthori/i.test(e.message));
  } finally { await k.close(); srv.stop(); }
});

test('agent config: stdio and http entries, off when disabled', () => {
  const stdio = new KnowledgeClient({ getConfig: () => ({ name: 'my kb', server: { type: 'stdio', command: 'uv', args: ['run', 'x'] } }), secrets: memSecrets() });
  assert.deepStrictEqual(stdio.agentConfig(), { mcpServers: { my_kb: { type: 'stdio', command: 'uv', args: ['run', 'x'], env: {} } } });
  const web = new KnowledgeClient({ getConfig: () => ({ server: { type: 'http', url: 'https://k/mcp' } }), secrets: memSecrets({ knowledge: { headers: { A: 'b' } } }) });
  assert.deepStrictEqual(web.agentConfig(), { mcpServers: { knowledge: { type: 'http', url: 'https://k/mcp', headers: { A: 'b' } } } });
  const off = new KnowledgeClient({ getConfig: () => ({ agentAccess: false, server: { type: 'stdio', command: 'x' } }), secrets: memSecrets() });
  assert.strictEqual(off.agentConfig(), null);
});

test('OAuth provider stores its state and catches the redirect', async () => {
  const store = memSecrets();
  let opened = null;
  const p = new OAuthProvider({ store, openExternal: (u) => { opened = u; }, port: 47870, clientName: 'Seamux' });
  assert.strictEqual(p.redirectUrl, 'http://127.0.0.1:47870/callback');
  assert.deepStrictEqual(p.clientMetadata.redirect_uris, ['http://127.0.0.1:47870/callback']);
  p.saveClientInformation({ client_id: 'c1' });
  p.saveTokens({ access_token: 'a' });
  p.saveCodeVerifier('v');
  assert.deepStrictEqual([p.clientInformation().client_id, p.tokens().access_token, p.codeVerifier()], ['c1', 'a', 'v']);
  await p.redirectToAuthorization(new URL('https://auth.example/authorize?x=1'));
  assert.strictEqual(opened, 'https://auth.example/authorize?x=1');
  const got = p.waitForCode();
  await new Promise((res) => http.get('http://127.0.0.1:47870/callback?code=CODE42', (r) => { r.resume(); r.on('end', res); }));
  assert.strictEqual(await got, 'CODE42');
  p.invalidateCredentials('tokens');
  assert.strictEqual(p.tokens(), undefined);
  assert.strictEqual(p.clientInformation().client_id, 'c1');
});

test('the Jejak example is plain mapping data', () => {
  const j = EXAMPLES.jejak;
  assert.strictEqual(j.server.type, 'stdio');
  assert.deepStrictEqual(Object.keys(j).sort(), ['agentAccess', 'importRules', 'name', 'save', 'server', 'sessionArtifacts']);
});

(async () => {
  for (const [name, fn] of tests) {
    await fn();
    console.log(`PASS  ${name}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`KNOWLEDGE: ALL ${tests.length} PASSED`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
