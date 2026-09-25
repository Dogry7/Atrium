import { McpClient, mcpResultToText } from '../../mcp/client.js';
import { safeJson } from '../../util.js';

/** MCP connector: plug any Model Context Protocol server into your agents. */
export default {
  id: 'mcp',
  name: 'MCP server',
  description: 'Connect any Model Context Protocol server (GitHub, Slack, Notion, filesystem, Laya…) and give its tools to agents.',
  icon: 'plug',
  category: 'connector',
  configFields: [
    { key: 'transport', label: 'Transport', type: 'select', options: [{ value: 'stdio', label: 'Local command (stdio)' }, { value: 'http', label: 'Streamable HTTP' }, { value: 'sse', label: 'Legacy HTTP + SSE' }], default: 'stdio' },
    { key: 'command', label: 'Command', type: 'text', help: 'e.g. npx', showIf: { transport: 'stdio' } },
    { key: 'args', label: 'Arguments', type: 'text', help: 'Space separated, e.g. -y @modelcontextprotocol/server-everything. Use quotes for spaces.', showIf: { transport: 'stdio' } },
    { key: 'env', label: 'Environment (JSON)', type: 'json', help: 'e.g. {"GITHUB_TOKEN": "…"}', showIf: { transport: 'stdio' } },
    { key: 'url', label: 'Server URL', type: 'text', help: 'e.g. https://mcp.example.com/mcp', showIf: { transport: ['http', 'sse'] } },
    { key: 'headers', label: 'Headers (JSON)', type: 'json', help: 'e.g. {"Authorization": "Bearer …"}', showIf: { transport: ['http', 'sse'] } },
    { key: 'toolFilter', label: 'Only these tools', type: 'text', help: 'Optional comma-separated allowlist of tool names.' },
  ],

  async create(config, ctx) {
    const transport = config.transport || (config.url ? 'http' : 'stdio');
    const client = new McpClient({
      transport,
      command: config.command,
      args: Array.isArray(config.args) ? config.args : splitArgs(config.args || ''),
      env: obj(config.env),
      url: config.url,
      headers: obj(config.headers),
      cwd: ctx?.rootDir,
    });
    await client.connect();
    const filter = String(config.toolFilter || '').split(',').map((s) => s.trim()).filter(Boolean);
    let cache = null;
    client.on('tools_changed', () => { cache = null; ctx?.onToolsChanged?.(); });
    client.on('exit', () => ctx?.onStatus?.('error', 'MCP server process exited'));

    return {
      info: () => ({ server: client.serverInfo, protocolVersion: client.protocolVersion }),
      async listTools() {
        if (!cache) {
          const tools = await client.listTools();
          cache = tools
            .filter((t) => !filter.length || filter.includes(t.name))
            .map((t) => ({ name: t.name, description: t.description || t.title || '', inputSchema: t.inputSchema || { type: 'object', properties: {} } }));
        }
        return cache;
      },
      async callTool(name, args, { signal } = {}) {
        const r = await client.callTool(name, args, { signal });
        const text = mcpResultToText(r);
        if (r?.isError) throw new Error(text);
        return text;
      },
      async test() {
        const tools = await this.listTools();
        const s = client.serverInfo;
        return { ok: true, message: `Connected to ${s?.title || s?.name || 'MCP server'} ${s?.version || ''} · ${tools.length} tool${tools.length === 1 ? '' : 's'}`.trim() };
      },
      async close() { await client.close(); },
    };
  },
};

function obj(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  return safeJson(v, {}) || {};
}

export function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
