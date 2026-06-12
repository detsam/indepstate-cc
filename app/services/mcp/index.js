const express = require('express');

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 60000;

function createGetDealsHistoryHandler(servicesApi = {}) {
  return async function getDealsHistory(input = {}) {
    const brokerage = servicesApi.brokerage;
    if (!brokerage || typeof brokerage.getAdapter !== 'function') {
      throw new Error('Brokerage service is not available');
    }

    const args = normalizeDealsHistoryInput(input, brokerage);
    const adapter = brokerage.getAdapter(args.provider);
    if (!adapter || typeof adapter.getDealsHistory !== 'function') {
      throw new Error(`Provider "${args.provider}" does not support deals history`);
    }

    const deals = await adapter.getDealsHistory({
      from: args.from,
      to: args.to,
      filters: args.filters,
      timeoutMs: args.timeoutMs
    });
    const normalizedDeals = Array.isArray(deals) ? deals : [];

    return {
      provider: args.provider,
      from: args.from.toISOString(),
      to: args.to.toISOString(),
      count: normalizedDeals.length,
      deals: normalizedDeals
    };
  };
}

function normalizeDealsHistoryInput(input = {}, brokerage = {}) {
  const executionConfig = typeof brokerage.getExecutionConfig === 'function'
    ? brokerage.getExecutionConfig()
    : {};
  const provider = String(input.provider || executionConfig.default || '').trim().toLowerCase();
  if (!provider) throw new Error('provider is required');

  const from = parseIsoDate(input.from, 'from', true);
  const to = parseIsoDate(input.to || new Date().toISOString(), 'to', true);
  if (to.getTime() < from.getTime()) {
    throw new Error('to must be greater than or equal to from');
  }

  const timeoutMs = clampTimeout(input.timeoutMs);
  return {
    provider,
    from,
    to,
    timeoutMs,
    filters: {
      symbol: input.symbol,
      magic: input.magic,
      type: input.type,
      entry: input.entry,
      commentContains: input.commentContains
    }
  };
}

async function start({ servicesApi, host = '127.0.0.1', port = 3225, path = '/mcp', authToken = '' } = {}) {
  const normalizedPath = normalizeHttpPath(path);
  const mcp = await loadMcpSdk();
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const createToolHandler = createGetDealsHistoryHandler(servicesApi);
  app.all(normalizedPath, async (req, res) => {
    if (authToken && !hasBearerToken(req, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const server = new mcp.McpServer({
      name: 'indepstate-cc',
      version: '0.8.0'
    });
    // This MCP service is intentionally read-only. Do not add execution,
    // cancellation, command, or generic brokerage passthrough tools here.
    server.registerTool(
      'get_deals_history',
      {
        title: 'Get deals history',
        description: 'Returns closed deal history for a brokerage provider.',
        inputSchema: {
          provider: mcp.z.string().optional(),
          from: mcp.z.string(),
          to: mcp.z.string().optional(),
          symbol: mcp.z.string().optional(),
          magic: mcp.z.union([mcp.z.string(), mcp.z.number()]).optional(),
          type: mcp.z.string().optional(),
          entry: mcp.z.string().optional(),
          commentContains: mcp.z.string().optional(),
          timeoutMs: mcp.z.number().optional()
        }
      },
      async (args) => {
        const result = await createToolHandler(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      }
    );

    const transport = new mcp.StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    res.on('close', () => {
      transport.close?.();
      server.close?.();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: err?.message || String(err) });
      }
    }
  });

  const httpServer = await new Promise((resolve, reject) => {
    const srv = app.listen(Number(port), host, () => resolve(srv));
    srv.on('error', reject);
  });

  const url = `http://${host}:${Number(port)}${normalizedPath}`;
  console.log(`[mcp] listening on ${url}`);
  return {
    url,
    stop: () => new Promise((resolve, reject) => {
      httpServer.close((err) => err ? reject(err) : resolve());
    })
  };
}

async function loadMcpSdk() {
  const [{ McpServer }, { StreamableHTTPServerTransport }, { z }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    import('zod')
  ]);
  return { McpServer, StreamableHTTPServerTransport, z };
}

function parseIsoDate(value, name, required = false) {
  if (value == null || value === '') {
    if (required) throw new Error(`${name} is required`);
    return null;
  }
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${name} must be an ISO date/time string`);
  }
  return date;
}

function clampTimeout(value) {
  const n = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.trunc(n), MAX_TIMEOUT_MS);
}

function normalizeHttpPath(value) {
  const p = String(value || '/mcp').trim();
  return p.startsWith('/') ? p : `/${p}`;
}

function hasBearerToken(req, token) {
  const auth = String(req.headers.authorization || '');
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match && match[1] === token;
}

module.exports = {
  createGetDealsHistoryHandler,
  normalizeDealsHistoryInput,
  start
};
