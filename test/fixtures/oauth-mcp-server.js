'use strict';

// An MCP server behind real OAuth, for testing browser sign-in end to end.
// Uses the SDK's own demo authorization server, which approves every
// sign-in at once and redirects straight back with a code.
//
//   node oauth-mcp-server.js <mcpPort> <authPort>     prints READY

const express = require('express');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { setupAuthServer } = require('@modelcontextprotocol/sdk/examples/server/demoInMemoryOAuthProvider.js');
const { mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } = require('@modelcontextprotocol/sdk/server/auth/router.js');
const { requireBearerAuth } = require('@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js');
const { build } = require('./fake-mcp-server');

const [mcpPort, authPort] = process.argv.slice(2).map(Number);
const mcpServerUrl = new URL(`http://127.0.0.1:${mcpPort}/mcp`);
const authServerUrl = new URL(`http://127.0.0.1:${authPort}`);

const oauthMetadata = setupAuthServer({ authServerUrl, mcpServerUrl, strictResource: false });

const app = express();
app.use(express.json());
app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: mcpServerUrl, scopesSupported: ['mcp:tools'], resourceName: 'Test' }));

const verifier = {
  async verifyAccessToken(token) {
    const r = await fetch(oauthMetadata.introspection_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    if (!r.ok) throw new Error('invalid token');
    const d = await r.json();
    return { token, clientId: d.client_id, scopes: d.scope ? d.scope.split(' ') : [], expiresAt: d.exp };
  },
};
const auth = requireBearerAuth({ verifier, requiredScopes: [], resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl) });

app.post('/mcp', auth, async (req, res) => {
  const server = build();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(mcpPort, '127.0.0.1', () => setTimeout(() => console.log('READY'), 300));
