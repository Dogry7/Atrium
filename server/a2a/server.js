import { readBody, sendJson } from '../http.js';
import { V1_METHODS, V03_METHODS, ERR, messageText, makeMessage, taskToWire, normalizeState } from './protocol.js';
import { uuid } from '../util.js';

/** Exposes every Atrium agent as an A2A server (JSON-RPC binding, v1.0 + v0.3). */
export function mountA2A(router, { runtime, store, settings }) {
  const baseUrl = (req) => {
    const s = settings();
    if (s.a2a?.publicUrl) return s.a2a.publicUrl.replace(/\/+$/, '');
    const proto = req.headers['x-forwarded-proto'] || 'http';
    return `${proto}://${req.headers.host}`;
  };

  const card = (agent, req) => {
    const base = baseUrl(req);
    const url = `${base}/a2a/${agent.id}`;
    const s = settings();
    const skills = [{
      id: 'chat', name: agent.role || 'General assistance',
      description: agent.instructions?.trim() ? agent.instructions.trim().slice(0, 400) : `${agent.name} is ${agent.role || 'an AI agent'} in Atrium.`,
      tags: [agent.role, 'atrium'].filter(Boolean).map((t) => String(t).toLowerCase()),
      examples: [`Hi ${agent.name}, can you help me with …?`],
      inputModes: ['text/plain'], outputModes: ['text/plain'],
    }];
    const c = {
      protocolVersion: '1.0',
      name: agent.name,
      description: `${agent.name}: ${agent.role || 'AI agent'} (Atrium)`,
      version: '1.0.0',
      url,
      preferredTransport: 'JSONRPC',
      supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }, { url, protocolBinding: 'JSONRPC', protocolVersion: '0.3' }],
      additionalInterfaces: [{ url, transport: 'JSONRPC' }],
      provider: { organization: 'Atrium (local)', url: base },
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: true },
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/plain'],
      skills,
    };
    if (s.a2a?.token) {
      c.securitySchemes = { bearer: { type: 'http', scheme: 'bearer' } };
      c.security = [{ bearer: [] }];
    }
    return c;
  };

  const frontDesk = () => {
    const s = settings();
    return runtime.agent(s.a2a?.frontDeskAgentId) || runtime.agents()[0];
  };

  const guard = (req, res) => {
    const s = settings();
    if (s.a2a?.enabled === false) { sendJson(res, 403, { error: 'A2A server is disabled in Settings' }); return false; }
    if (s.a2a?.token && req.headers.authorization !== `Bearer ${s.a2a.token}`) {
      sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: missing or invalid bearer token' } });
      return false;
    }
    return true;
  };

  const cardHandler = (pick) => (req, res, { params }) => {
    if (settings().a2a?.enabled === false) return sendJson(res, 404, { error: 'A2A disabled' });
    const agent = pick(params);
    if (!agent) return sendJson(res, 404, { error: 'No agents yet' });
    sendJson(res, 200, card(agent, req), { 'access-control-allow-origin': '*' });
  };

  router.get('/.well-known/agent-card.json', cardHandler(() => frontDesk()));
  router.get('/.well-known/agent.json', cardHandler(() => frontDesk()));
  router.get('/a2a/.well-known/agent-card.json', cardHandler(() => frontDesk()));
  router.get('/a2a/:agentId/.well-known/agent-card.json', cardHandler((p) => runtime.agent(p.agentId)));
  router.get('/a2a/:agentId/.well-known/agent.json', cardHandler((p) => runtime.agent(p.agentId)));
  router.get('/a2a/:agentId/card', cardHandler((p) => runtime.agent(p.agentId)));
  router.get('/a2a', (req, res) => sendJson(res, 200, { agents: runtime.agents().map((a) => ({ id: a.id, name: a.name, card: `${baseUrl(req)}/a2a/${a.id}/.well-known/agent-card.json` })) }));

  const rpc = (pickAgent) => async (req, res, { params }) => {
    if (!guard(req, res)) return;
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: ERR.PARSE, message: 'Parse error' } }); }
    const agent = pickAgent(params);
    const reply = async (msg) => {
      if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: ERR.INVALID_REQUEST, message: 'Invalid JSON-RPC request' } };
      if (!agent) return { jsonrpc: '2.0', id: msg.id, error: { code: ERR.INVALID_PARAMS, message: 'Unknown agent' } };
      const dialect = V1_METHODS[msg.method] ? 'v1' : V03_METHODS[msg.method] ? 'v0.3' : null;
      const op = V1_METHODS[msg.method] || V03_METHODS[msg.method];
      if (!op) return { jsonrpc: '2.0', id: msg.id, error: { code: ERR.METHOD_NOT_FOUND, message: `Method not found: ${msg.method}` } };
      try {
        const result = await handle(op, dialect, msg.params || {}, agent, req);
        return { jsonrpc: '2.0', id: msg.id, result };
      } catch (e) {
        return { jsonrpc: '2.0', id: msg.id, error: { code: e.code || ERR.INTERNAL, message: e.message } };
      }
    };
    const out = Array.isArray(body) ? await Promise.all(body.map(reply)) : await reply(body);
    sendJson(res, 200, out, { 'access-control-allow-origin': '*' });
  };

  router.post('/a2a/:agentId', rpc((p) => runtime.agent(p.agentId)));
  router.post('/a2a', rpc(() => frontDesk()));

  async function handle(op, dialect, params, agent, req) {
    if (op === 'send') {
      const m = params.message;
      if (!m || !Array.isArray(m.parts)) throw Object.assign(new Error('params.message with parts is required'), { code: ERR.INVALID_PARAMS });
      const text = messageText(m);
      if (!text.trim()) throw Object.assign(new Error('Message has no text or data parts'), { code: ERR.INVALID_PARAMS });
      const contextId = m.contextId || uuid();
      const caller = m.metadata?.agentName || (req.headers['user-agent']?.includes('Atrium') ? 'Atrium peer' : 'external agent');
      const nonBlocking = params.configuration?.returnImmediately === true || params.configuration?.blocking === false;
      const taskId = uuid();
      const p = runtime.run({ agentId: agent.id, input: text, from: { type: 'external', id: 'a2a', name: caller }, contextId: `a2a-ext:${contextId}`, taskId });
      let task;
      if (nonBlocking) { await new Promise((r) => setImmediate(r)); task = store.get('tasks', taskId); }
      else task = await p;
      const wire = taskToWire({ ...task, contextId }, dialect, { historyLength: params.configuration?.historyLength });
      return dialect === 'v1' ? { task: wire } : wire;
    }
    if (op === 'get') {
      const id = params.id || params.name?.replace(/^tasks\//, '');
      const t = store.get('tasks', id);
      if (!t || (t.from?.type !== 'external')) throw Object.assign(new Error('Task not found'), { code: ERR.TASK_NOT_FOUND });
      const wire = taskToWire({ ...t, contextId: t.contextId.replace(/^a2a-ext:/, '') }, dialect, { historyLength: params.historyLength });
      return dialect === 'v1' ? wire : wire;
    }
    if (op === 'list') {
      const tasks = store.all('tasks').filter((t) => t.agentId === agent.id && t.from?.type === 'external').slice(-(params.pageSize || 50)).reverse();
      return { tasks: tasks.map((t) => taskToWire({ ...t, contextId: t.contextId.replace(/^a2a-ext:/, '') }, dialect, { historyLength: 0 })), nextPageToken: '', pageSize: tasks.length, totalSize: tasks.length };
    }
    if (op === 'cancel') {
      const id = params.id || params.name?.replace(/^tasks\//, '');
      const t = store.get('tasks', id);
      if (!t || t.from?.type !== 'external') throw Object.assign(new Error('Task not found'), { code: ERR.TASK_NOT_FOUND });
      if (normalizeState(t.status.state) !== 'working') throw Object.assign(new Error(`Task is ${normalizeState(t.status.state)} and cannot be canceled`), { code: ERR.TASK_NOT_CANCELABLE });
      runtime.cancel(t.id);
      await new Promise((r) => setTimeout(r, 50));
      return taskToWire({ ...store.get('tasks', id), contextId: t.contextId.replace(/^a2a-ext:/, '') }, dialect);
    }
    if (op === 'card') return card(agent, req);
    throw Object.assign(new Error('Unsupported'), { code: ERR.UNSUPPORTED });
  }

  return { card };
}

export { makeMessage };
