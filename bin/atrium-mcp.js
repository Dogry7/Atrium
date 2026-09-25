#!/usr/bin/env node
/**
 * Atrium as an MCP server (stdio). Lets Claude Desktop / Cowork / Claude Code drive your agents.
 * Config: { "command": "node", "args": ["/path/to/atrium/bin/atrium-mcp.js"], "env": { "ATRIUM_URL": "http://127.0.0.1:4317" } }
 */
import readline from 'node:readline';

const BASE = (process.env.ATRIUM_URL || 'http://127.0.0.1:4317').replace(/\/+$/, '');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');

async function api(method, path, body) {
  let res;
  try { res = await fetch(BASE + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new Error(`Atrium is not running at ${BASE}. Start it with "npm start" in the Atrium folder.`); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

const TOOLS = [
  { name: 'list_agents', description: 'List the agents in Atrium with their roles and models.', inputSchema: { type: 'object', properties: {} } },
  { name: 'chat_with_agent', description: 'Send a message to an Atrium agent and get its reply. Agents may delegate to colleagues (A2A) before answering.', inputSchema: { type: 'object', properties: { agent: { type: 'string', description: 'Agent name or id' }, message: { type: 'string' } }, required: ['agent', 'message'] } },
  { name: 'list_workflows', description: 'List Atrium workflows.', inputSchema: { type: 'object', properties: {} } },
  { name: 'run_workflow', description: 'Run an Atrium workflow and return its output.', inputSchema: { type: 'object', properties: { workflow: { type: 'string', description: 'Workflow name or id' }, input: { type: 'string' } }, required: ['workflow'] } },
  { name: 'create_agent', description: 'Create a new agent in the Atrium colony.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string' }, instructions: { type: 'string' } }, required: ['name', 'role'] } },
];

async function callTool(name, a = {}) {
  switch (name) {
    case 'list_agents': return (await api('GET', '/api/agents')).map((x) => `- ${x.name}: ${x.role} (${x.provider}${x.model ? ' ' + x.model : ''})`).join('\n') || 'No agents.';
    case 'chat_with_agent': {
      const r = await api('POST', `/api/agents/${encodeURIComponent(a.agent)}/chat`, { message: a.message, wait: true });
      if (r.error) throw new Error(r.error);
      return r.reply;
    }
    case 'list_workflows': return (await api('GET', '/api/workflows')).map((w) => `- ${w.name} (${w.nodes.length} steps)${w.description ? `: ${w.description}` : ''}`).join('\n') || 'No workflows.';
    case 'run_workflow': {
      const list = await api('GET', '/api/workflows');
      const q = String(a.workflow).toLowerCase();
      const w = list.find((x) => x.id === a.workflow) || list.find((x) => x.name.toLowerCase() === q) || list.find((x) => x.name.toLowerCase().includes(q));
      if (!w) throw new Error(`No workflow matching "${a.workflow}"`);
      const r = await api('POST', `/api/workflows/${w.id}/run`, { input: a.input || '', wait: true, trigger: 'mcp' });
      if (r.status !== 'completed') throw new Error(`Run ${r.status}: ${r.error || ''}`);
      return typeof r.output === 'string' ? r.output : JSON.stringify(r.output, null, 2);
    }
    case 'create_agent': { const x = await api('POST', '/api/agents', { name: a.name, role: a.role, instructions: a.instructions || '' }); return `Created ${x.name} (${x.id}).`; }
    default: throw new Error(`Unknown tool ${name}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id == null) return; // notifications
  try {
    let result;
    if (m.method === 'initialize') result = { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'atrium', title: 'Atrium agents', version: '1.0.0' }, instructions: 'Use these tools to talk to the user\'s Atrium agents and run their workflows.' };
    else if (m.method === 'ping') result = {};
    else if (m.method === 'tools/list') result = { tools: TOOLS };
    else if (m.method === 'tools/call') {
      try { result = { content: [{ type: 'text', text: await callTool(m.params?.name, m.params?.arguments) }] }; }
      catch (e) { result = { content: [{ type: 'text', text: e.message }], isError: true }; }
    } else return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
    send({ jsonrpc: '2.0', id: m.id, result });
  } catch (e) { send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: e.message } }); }
});
