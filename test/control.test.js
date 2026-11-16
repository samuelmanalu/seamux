'use strict';

// The control socket and the seamux command, with a fake handler: requests
// and replies, errors, permissions, and the command's own parsing and output.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { ControlServer, request } = require('../src/main/control');

const CLI = path.join(__dirname, '..', 'src', 'cli', 'seamux-cli.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smx-'));
const sock = path.join(dir, 's.sock');
const seen = [];

const server = new ControlServer({
  socketPath: sock,
  handle: async (req) => {
    seen.push(req);
    if (req.cmd === 'task.add') {
      if (req.title === 'bad') throw new Error('refused');
      return { task: { id: 't_1', title: req.title, status: 'backlog' } };
    }
    if (req.cmd === 'task.list') return { tasks: [{ id: 't_1', column: 'Backlog', title: 'One', blockedBy: [] }, { id: 't_2', column: 'Ready', title: 'Two', blockedBy: ['t_1'] }] };
    throw new Error('unknown request');
  },
});

const cli = (args, env = {}) => new Promise((resolve) => {
  execFile(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, SEAMUX_SOCKET: sock, SEAMUX_PROJECT: '/proj', ...env } },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
});

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the socket is owner-only', () => {
  assert.strictEqual(fs.statSync(sock).mode & 0o777, 0o600);
});

test('request and reply', async () => {
  const r = await request(sock, { cmd: 'task.list', project: '/p' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tasks.length, 2);
});

test('a refused request comes back as an error, and bad JSON too', async () => {
  assert.deepStrictEqual(await request(sock, { cmd: 'nope' }), { ok: false, error: 'unknown request' });
  const net = require('net');
  const reply = await new Promise((res) => {
    const c = net.createConnection(sock, () => c.write('{not json\n'));
    c.on('data', (d) => { res(JSON.parse(String(d))); c.end(); });
  });
  assert.strictEqual(reply.ok, false);
});

test('seamux task add sends title, brief, dependencies and project', async () => {
  const r = await cli(['task', 'add', 'Write', 'the', 'guide', '--brief', 'Cover rollback.', '--after', 't_a', '--after', 't_b']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.stdout, 't_1  added to Backlog: Write the guide\n');
  assert.deepStrictEqual(seen.pop(), { cmd: 'task.add', project: '/proj', title: 'Write the guide', brief: 'Cover rollback.', after: ['t_a', 't_b'], agent: null });
});

test('seamux task list prints one line per task', async () => {
  const r = await cli(['task', 'list']);
  assert.strictEqual(r.stdout, 't_1  [Backlog]  One\nt_2  [Ready]  Two  (waits for t_1)\n');
});

test('errors go to stderr with a non-zero exit', async () => {
  let r = await cli(['task', 'add', 'bad']);
  assert.ok(r.code !== 0 && /seamux: refused/.test(r.stderr), r.stderr);
  r = await cli(['task', 'add']);
  assert.ok(/give the task a title/.test(r.stderr));
  r = await cli(['task', 'list'], { SEAMUX_SOCKET: '' });
  assert.ok(/inside a Seamux terminal/.test(r.stderr));
  r = await cli(['task', 'list'], { SEAMUX_SOCKET: path.join(dir, 'missing.sock') });
  assert.ok(/Seamux is not running/.test(r.stderr), r.stderr);
});

test('help', async () => {
  const r = await cli(['--help']);
  assert.ok(/seamux task add/.test(r.stdout) && r.code === 0);
});

(async () => {
  await server.start();
  for (const [name, fn] of tests) {
    await fn();
    console.log(`PASS  ${name}`);
  }
  server.stop();
  assert.ok(!fs.existsSync(sock), 'stop removes the socket file');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`CONTROL: ALL ${tests.length} PASSED`);
})().catch((e) => { console.error(e); server.stop(); process.exit(1); });
