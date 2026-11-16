'use strict';

// A small MCP knowledge server for tests. Every call is appended to the file
// in FAKE_MCP_LOG so a test can see exactly what Seamux sent.
//
//   node fake-mcp-server.js            stdio
//   node fake-mcp-server.js --http N   streamable HTTP on 127.0.0.1:N (prints READY)
//                                      FAKE_MCP_TOKEN set: requires that bearer token

const fs = require('fs');
const http = require('http');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const log = (entry) => {
  if (process.env.FAKE_MCP_LOG) fs.appendFileSync(process.env.FAKE_MCP_LOG, `${JSON.stringify(entry)}\n`);
};
const text = (t) => ({ content: [{ type: 'text', text: t }] });

function build() {
  const server = new McpServer({ name: 'fake-knowledge', version: '1.0.0' });
  server.registerTool('save_note', {
    description: 'Save a note',
    inputSchema: { text: z.string(), project: z.string().optional() },
  }, async (args) => { log({ tool: 'save_note', args }); return text('saved'); });

  server.registerTool('find_rules', {
    description: 'Find rules for a project',
    inputSchema: { project: z.string() },
  }, async (args) => {
    log({ tool: 'find_rules', args });
    return text([
      `Results for ${args.project}`,
      '  1. [convention] RULE: Never push to main',
      '  2. [decision] something unrelated',
      '  3. [convention] RULE: Run the tests before every commit',
      '  4. [convention] RULE: Never push to main',
    ].join('\n'));
  });

  server.registerTool('session_items', {
    description: 'Items from a session',
    inputSchema: { session_id: z.string(), json: z.boolean().optional() },
  }, async (args) => {
    log({ tool: 'session_items', args });
    if (args.json) {
      return text(JSON.stringify([
        { title: 'Release plan', url: 'https://example.com/a/plan' },
        { title: 'Notes', path: '/tmp/notes.md', created_at: '2026-01-02T03:04:05Z' },
      ]));
    }
    return text([
      `=== Session ${args.session_id} ===`,
      '  a1  [artifact]  2026-01-01T10:00',
      '    Artifact: Release plan — the plan (https://example.com/a/plan)',
      '  b2  [decision]  2026-01-01T11:00',
      '    Decided to ship on Friday, see https://example.com/not-an-artifact',
      '  c3  [artifact]  2026-01-01T12:00',
      '    Document: Runbook (/tmp/runbook.md) — steps',
    ].join('\n'));
  });

  server.registerTool('broken', { description: 'Always fails' }, async () => ({ content: [{ type: 'text', text: 'it broke' }], isError: true }));
  return server;
}

async function main() {
  const i = process.argv.indexOf('--http');
  if (i < 0) {
    await build().connect(new StdioServerTransport());
    return;
  }
  const port = Number(process.argv[i + 1]);
  const token = process.env.FAKE_MCP_TOKEN;
  const httpServer = http.createServer(async (req, res) => {
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"unauthorized"}');
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    // Stateless: a fresh server and transport per request.
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  httpServer.listen(port, '127.0.0.1', () => console.log('READY'));
}

main().catch((e) => { console.error(e); process.exit(1); });
