'use strict';

const fs = require('fs');
const net = require('net');

// A local socket the `seamux` command talks to, so an agent in a terminal
// (the project's planner, mainly) can put tasks on the board. One JSON
// request per line, one JSON reply per line. The socket file is owner-only,
// so only this user's processes can use it.

const MAX_LINE = 256 * 1024;

class ControlServer {
  /**
   * @param {object} o
   * @param {string} o.socketPath
   * @param {(req: object) => Promise<object>|object} o.handle  returns the reply's payload; throws to refuse
   */
  constructor({ socketPath, handle }) {
    this.socketPath = socketPath;
    this.handle = handle;
    this.server = null;
  }

  async start() {
    try { fs.unlinkSync(this.socketPath); } catch { /* none left over */ }
    this.server = net.createServer((sock) => this._serve(sock));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, resolve);
    });
    fs.chmodSync(this.socketPath, 0o600);
    return this.socketPath;
  }

  _serve(sock) {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', async (chunk) => {
      buf += chunk;
      if (buf.length > MAX_LINE) { sock.end(`${JSON.stringify({ ok: false, error: 'request too large' })}\n`); return; }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let reply;
        try {
          const req = JSON.parse(line);
          reply = { ok: true, ...(await this.handle(req)) };
        } catch (err) {
          reply = { ok: false, error: err && err.message ? err.message : String(err) };
        }
        if (!sock.destroyed) sock.write(`${JSON.stringify(reply)}\n`);
      }
    });
    sock.on('error', () => {});
  }

  stop() {
    if (this.server) { try { this.server.close(); } catch { /* closed */ } }
    try { fs.unlinkSync(this.socketPath); } catch { /* gone */ }
  }
}

/** Send one request and wait for its reply. Used by the seamux command and tests. */
function request(socketPath, req, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('Seamux did not answer')); }, timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify(req)}\n`));
    sock.on('data', (c) => {
      buf += c;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(timer);
      sock.end();
      try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? new Error('Seamux is not running') : e); });
  });
}

module.exports = { ControlServer, request };
