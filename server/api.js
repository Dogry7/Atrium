import { readBody, sendJson } from './http.js';
import { describeProviders, getProvider } from './providers/index.js';
import { agentDefaults, assignPlots, AVATAR_COLORS } from './runtime/agents.js';
import { validateWorkflow, NODE_TYPES } from './workflows/engine.js';
import { HttpError, id as newId, now, mask, uuid, pick } from './util.js';

export const PLANETS = ['terra', 'mars', 'luna'];
export const TIMES = ['live', 'dawn', 'day', 'dusk', 'night'];
export const QUALITIES = ['auto', 'high', 'low'];
const AGENT_FIELDS = ['name', 'role', 'instructions', 'provider', 'model', 'temperature', 'maxTokens', 'maxSteps', 'connectors', 'a2a', 'memory', 'avatar'];

export function mountApi(router, app) {
  const { store, bus, runtime, plugins, engine } = app;

  // ------------------------------------------------------------------ settings
  const publicSettings = () => {
    const s = structuredClone(app.settings());
    for (const p of Object.values(s.providers || {})) if (p.apiKey) p.apiKey = mask(p.apiKey);
    if (s.a2a?.token) s.a2a.token = mask(s.a2a.token);
    return s;
  };

  router.get('/api/health', (req, res) => sendJson(res, 200, { ok: true, version: app.version, uptime: process.uptime(), agents: store.all('agents').length }));

  router.get('/api/state', (req, res) => {
    const s = app.settings();
    sendJson(res, 200, {
      version: app.version,
      settings: publicSettings(),
      providers: describeProviders(s),
      agents: store.all('agents').map((a) => ({ ...a, busy: runtime.busy.get(a.id) || 0 })),
      workflows: store.all('workflows'),
      connectors: plugins.list().map((c) => plugins.publicConnector(c)),
      pluginTypes: plugins.describeTypes(),
      pluginErrors: plugins.loadErrors,
      nodeTypes: NODE_TYPES,
      tasks: store.all('tasks').slice(-150).map((t) => runtime.taskSummary(t)),
      runs: store.all('runs').slice(-60).map((r) => engine.runSummary(r)),
      events: bus.recent(300),
      seq: bus.seq,
      colors: AVATAR_COLORS,
    });
  });

  router.get('/api/settings', (req, res) => sendJson(res, 200, publicSettings()));
  router.patch('/api/settings', async (req, res) => {
    const body = await readBody(req);
    const w = body?.world || {};
    if (w.planet !== undefined && !PLANETS.includes(w.planet)) throw new HttpError(400, `Unknown planet "${w.planet}". Choose one of: ${PLANETS.join(', ')}`);
    if (w.time !== undefined && !TIMES.includes(w.time)) throw new HttpError(400, `time must be one of: ${TIMES.join(', ')}`);
    if (w.quality !== undefined && !QUALITIES.includes(w.quality)) throw new HttpError(400, `quality must be one of: ${QUALITIES.join(', ')}`);
    if (body?.theme !== undefined && !['dark', 'light', 'system'].includes(body.theme)) throw new HttpError(400, 'theme must be dark, light or system');
    const s = app.settings();
    const merge = (target, src) => {
      for (const [k, v] of Object.entries(src || {})) {
        if (v && typeof v === 'object' && !Array.isArray(v)) { target[k] = target[k] || {}; merge(target[k], v); }
        else if (typeof v === 'string' && v.includes('••••')) continue; // masked value: unchanged
        else target[k] = v;
      }
    };
    merge(s, pick(body, ['userName', 'theme', 'defaultProvider', 'defaultModel', 'providers', 'a2a', 'world']));
    store.setDoc('settings', s);
    bus.emitEvent('settings.updated', {});
    sendJson(res, 200, { settings: publicSettings(), providers: describeProviders(s) });
  });

  // ------------------------------------------------------------------ providers
  router.get('/api/providers', (req, res) => sendJson(res, 200, describeProviders(app.settings())));
  router.get('/api/providers/:id/models', async (req, res, { params }) => {
    const p = getProvider(params.id);
    if (!p) throw new HttpError(404, 'Unknown provider');
    try { sendJson(res, 200, { models: await p.listModels(app.settings()) }); }
    catch (e) { sendJson(res, 200, { models: p.suggestedModels || [], error: e.message }); }
  });
  router.post('/api/providers/:id/test', async (req, res, { params }) => {
    const p = getProvider(params.id);
    if (!p) throw new HttpError(404, 'Unknown provider');
    try {
      const models = await p.listModels(app.settings());
      sendJson(res, 200, { ok: true, message: `Connected · ${models.length} models available`, models });
    } catch (e) { sendJson(res, 200, { ok: false, message: e.message }); }
  });

  // ------------------------------------------------------------------ agents
  const validateAgent = (input, selfId) => {
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name) throw new HttpError(400, 'Give your agent a name.');
      if (name.length > 40) throw new HttpError(400, 'Names can be at most 40 characters.');
      if (store.all('agents').some((a) => a.id !== selfId && a.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, `There's already an agent called "${name}".`);
      input.name = name;
    }
    if (input.provider !== undefined && !getProvider(input.provider)) throw new HttpError(400, `Unknown provider "${input.provider}"`);
    if (input.connectors) {
      input.connectors = [...new Set(input.connectors)].filter((cid) => plugins.get(cid));
    }
    if (input.temperature === '' ) input.temperature = null;
    if (input.maxSteps != null) input.maxSteps = Math.max(1, Math.min(30, Number(input.maxSteps) || 8));
    if (input.maxTokens != null) input.maxTokens = Math.max(64, Math.min(64000, Number(input.maxTokens) || 2048));
    return input;
  };

  router.get('/api/agents', (req, res) => sendJson(res, 200, store.all('agents')));
  router.post('/api/agents', async (req, res) => {
    const body = validateAgent(pick(await readBody(req), AGENT_FIELDS));
    if (!body.name) throw new HttpError(400, 'Give your agent a name.');
    const s = app.settings();
    if (!body.provider) { body.provider = s.defaultProvider || 'simulated'; body.model = body.model || s.defaultModel || ''; }
    const agent = agentDefaults(body, store.all('agents'));
    store.insert('agents', agent);
    bus.emitEvent('agent.created', { agent });
    sendJson(res, 201, agent);
  });
  router.get('/api/agents/:id', (req, res, { params }) => {
    const a = runtime.agent(params.id);
    if (!a) throw noAgent(params.id);
    sendJson(res, 200, { ...a, busy: runtime.busy.get(a.id) || 0, card: `/a2a/${a.id}/.well-known/agent-card.json` });
  });
  router.patch('/api/agents/:id', async (req, res, { params }) => {
    const a = store.get('agents', params.id);
    if (!a) throw new HttpError(404, 'Agent not found');
    const patch = validateAgent(pick(await readBody(req), AGENT_FIELDS), a.id);
    if (patch.avatar) patch.avatar = { ...a.avatar, ...patch.avatar };
    Object.assign(a, patch, { updatedAt: now() });
    store.save('agents');
    bus.emitEvent('agent.updated', { agent: a });
    sendJson(res, 200, a);
  });
  router.delete('/api/agents/:id', (req, res, { params }) => {
    const a = store.get('agents', params.id);
    if (!a) throw new HttpError(404, 'Agent not found');
    for (const [tid, t] of runtime.active) if (t.agentId === a.id) runtime.cancel(tid);
    store.remove('agents', a.id);
    for (const t of store.all('threads').filter((t) => t.agentId === a.id)) store.remove('threads', t.id);
    for (const m of store.all('memories').filter((m) => m.agentId === a.id)) store.remove('memories', m.id);
    for (const o of store.all('agents')) if (Array.isArray(o.a2a?.allow)) { o.a2a.allow = o.a2a.allow.filter((x) => x !== a.id); store.save('agents'); }
    bus.emitEvent('agent.deleted', { id: a.id, name: a.name });
    sendJson(res, 200, { ok: true });
  });

  const noAgent = (name) => new HttpError(404, `No agent called "${name}". Agents: ${store.all('agents').map((a) => a.name).join(', ') || 'none yet'}`);
  router.post('/api/agents/:id/chat', async (req, res, { params }) => {
    const a = runtime.agent(params.id);
    if (!a) throw noAgent(params.id);
    const body = await readBody(req);
    const message = String(body.message ?? body.text ?? '').trim();
    if (!message) throw new HttpError(400, 'Message is empty');
    const contextId = body.contextId || 'chat';
    const taskId = uuid();
    const s = app.settings();
    const p = runtime.run({ agentId: a.id, input: message, contextId, taskId, from: { type: 'user', name: s.userName || 'You' } });
    if (body.wait) {
      const task = await p;
      return sendJson(res, 200, { taskId, status: task.status, reply: task.artifacts[0]?.text || null, error: task.status.state === 'completed' ? null : task.status.message });
    }
    p.catch(() => {});
    sendJson(res, 202, { taskId, contextId });
  });
  router.get('/api/agents/:id/thread', (req, res, { params, query }) => {
    const a = runtime.agent(params.id);
    if (!a) throw new HttpError(404, 'Agent not found');
    const contextId = query.get('contextId') || 'chat';
    // Present as simple bubbles, derived from tasks for this context (includes failures & tool steps).
    const tasks = store.all('tasks').filter((t) => t.agentId === a.id && t.contextId === contextId).slice(-60);
    sendJson(res, 200, {
      contextId,
      turns: tasks.map((t) => ({ taskId: t.id, from: t.from, input: t.input, reply: t.artifacts?.[0]?.text || null, status: t.status, steps: t.steps, createdAt: t.createdAt })),
    });
  });
  router.delete('/api/agents/:id/thread', (req, res, { params, query }) => {
    const a = runtime.agent(params.id);
    if (!a) throw new HttpError(404, 'Agent not found');
    const contextId = query.get('contextId') || 'chat';
    runtime.clearThread(a.id, contextId);
    // hide old turns from the chat view by moving them to an archived context
    for (const t of store.all('tasks')) if (t.agentId === a.id && t.contextId === contextId) t.contextId = `${contextId}:archived:${Date.now()}`;
    store.save('tasks');
    bus.emitEvent('agent.thread_cleared', { agentId: a.id, contextId });
    sendJson(res, 200, { ok: true });
  });
  router.get('/api/agents/:id/memories', (req, res, { params }) => sendJson(res, 200, store.all('memories').filter((m) => m.agentId === params.id)));
  router.delete('/api/agents/:id/memories/:mid', (req, res, { params }) => sendJson(res, 200, { ok: store.remove('memories', params.mid) }));

  // ------------------------------------------------------------------ tasks
  router.get('/api/tasks', (req, res, { query }) => {
    let list = store.all('tasks');
    if (query.get('agentId')) list = list.filter((t) => t.agentId === query.get('agentId'));
    sendJson(res, 200, list.slice(-(Number(query.get('limit')) || 100)).map((t) => runtime.taskSummary(t)));
  });
  router.get('/api/tasks/:id', (req, res, { params }) => {
    const t = store.get('tasks', params.id);
    if (!t) throw new HttpError(404, 'Task not found');
    sendJson(res, 200, { ...t, children: store.all('tasks').filter((c) => c.parentTaskId === t.id).map((c) => runtime.taskSummary(c)) });
  });
  router.post('/api/tasks/:id/cancel', (req, res, { params }) => sendJson(res, 200, { ok: runtime.cancel(params.id) }));

  // ------------------------------------------------------------------ connectors & plugins
  router.get('/api/plugins', (req, res) => sendJson(res, 200, { types: plugins.describeTypes(), errors: plugins.loadErrors }));
  router.post('/api/plugins/reload', async (req, res) => {
    plugins.types.clear(); plugins.loadErrors = [];
    await plugins.loadTypes();
    bus.emitEvent('plugins.reloaded', {});
    sendJson(res, 200, { types: plugins.describeTypes(), errors: plugins.loadErrors });
  });
  router.get('/api/connectors', (req, res) => sendJson(res, 200, plugins.list().map((c) => plugins.publicConnector(c))));
  router.post('/api/connectors', async (req, res) => {
    const body = await readBody(req);
    if (!body.pluginId) throw new HttpError(400, 'pluginId is required');
    const c = plugins.create(body);
    sendJson(res, 201, plugins.publicConnector(c));
  });
  router.patch('/api/connectors/:id', async (req, res, { params }) => {
    const c = await plugins.update(params.id, await readBody(req));
    if (!c) throw new HttpError(404, 'Connector not found');
    sendJson(res, 200, plugins.publicConnector(c));
  });
  router.delete('/api/connectors/:id', async (req, res, { params }) => sendJson(res, 200, { ok: await plugins.remove(params.id) }));
  router.post('/api/connectors/:id/test', async (req, res, { params }) => {
    if (!plugins.get(params.id)) throw new HttpError(404, 'Connector not found');
    try {
      const r = await plugins.test(params.id);
      sendJson(res, 200, { ok: r.ok !== false, message: r.message, tools: r.tools, connector: plugins.publicConnector(plugins.get(params.id)) });
    } catch (e) {
      sendJson(res, 200, { ok: false, message: e.message.replace(/^Connector ".*?" failed to start: /, ''), connector: plugins.publicConnector(plugins.get(params.id)) });
    }
  });
  router.post('/api/connectors/:id/tools/:tool', async (req, res, { params }) => {
    if (!plugins.get(params.id)) throw new HttpError(404, 'Connector not found');
    const body = await readBody(req);
    const started = Date.now();
    try {
      const result = await plugins.callTool(params.id, params.tool, body.args || {}, {});
      sendJson(res, 200, { ok: true, result, ms: Date.now() - started });
    } catch (e) { sendJson(res, 200, { ok: false, error: e.message, ms: Date.now() - started }); }
  });

  // ------------------------------------------------------------------ workflows
  const wfCtx = () => ({ agents: store.all('agents'), connectors: store.all('connectors') });
  router.get('/api/workflows', (req, res) => sendJson(res, 200, store.all('workflows')));
  router.post('/api/workflows', async (req, res) => {
    const body = await readBody(req);
    const name = String(body.name || '').trim() || 'Untitled workflow';
    const start = { id: newId('n'), type: 'trigger', x: 80, y: 220, data: { label: 'Start', sampleInput: '' } };
    const wf = {
      id: newId('wf'), name, description: body.description || '',
      nodes: body.nodes || [start], edges: body.edges || [],
      trigger: { webhook: { enabled: false, token: newId('hook') }, schedule: { enabled: false, everyMinutes: 60 }, ...(body.trigger || {}) },
      createdAt: now(), updatedAt: now(),
    };
    store.insert('workflows', wf);
    bus.emitEvent('workflow.created', { workflow: wf });
    sendJson(res, 201, wf);
  });
  router.get('/api/workflows/:id', (req, res, { params }) => {
    const wf = store.get('workflows', params.id);
    if (!wf) throw new HttpError(404, 'Workflow not found');
    sendJson(res, 200, { ...wf, problems: validateWorkflow(wf, wfCtx()) });
  });
  router.put('/api/workflows/:id', async (req, res, { params }) => {
    const wf = store.get('workflows', params.id);
    if (!wf) throw new HttpError(404, 'Workflow not found');
    const body = await readBody(req);
    Object.assign(wf, pick(body, ['name', 'description', 'nodes', 'edges', 'trigger']), { updatedAt: now() });
    if (!String(wf.name || '').trim()) wf.name = 'Untitled workflow';
    store.save('workflows');
    bus.emitEvent('workflow.updated', { workflow: wf });
    sendJson(res, 200, { ...wf, problems: validateWorkflow(wf, wfCtx()) });
  });
  router.delete('/api/workflows/:id', (req, res, { params }) => {
    const ok = store.remove('workflows', params.id);
    if (ok) bus.emitEvent('workflow.deleted', { id: params.id });
    sendJson(res, 200, { ok });
  });
  router.post('/api/workflows/:id/run', async (req, res, { params }) => {
    const body = await readBody(req);
    const { run, done } = engine.start(params.id, { input: body.input ?? '', trigger: body.trigger || 'manual' });
    if (body.wait) { const r = await done; return sendJson(res, 200, { ...engine.runSummary(r), output: r.output }); }
    done.catch(() => {});
    sendJson(res, 202, { runId: run.id });
  });
  router.get('/api/runs', (req, res, { query }) => {
    let list = store.all('runs');
    if (query.get('workflowId')) list = list.filter((r) => r.workflowId === query.get('workflowId'));
    sendJson(res, 200, list.slice(-50).reverse().map((r) => engine.runSummary(r)));
  });
  router.get('/api/runs/:id', (req, res, { params }) => {
    const r = store.get('runs', params.id);
    if (!r) throw new HttpError(404, 'Run not found');
    sendJson(res, 200, r);
  });
  router.post('/api/runs/:id/cancel', (req, res, { params }) => sendJson(res, 200, { ok: engine.cancel(params.id) }));

  // Incoming webhooks → workflow runs
  router.post('/api/hooks/:workflowId', async (req, res, { params, query }) => {
    const wf = store.get('workflows', params.workflowId);
    if (!wf) throw new HttpError(404, 'Workflow not found');
    const hook = wf.trigger?.webhook || {};
    if (!hook.enabled) throw new HttpError(403, 'Webhook trigger is disabled for this workflow');
    const token = req.headers['x-atrium-token'] || query.get('token') || (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!hook.token || token !== hook.token) throw new HttpError(401, 'Invalid webhook token');
    const body = await readBody(req);
    const input = body.input !== undefined ? body.input : body.text !== undefined && Object.keys(body).length === 1 ? body.text : body;
    const { run, done } = engine.start(wf.id, { input, trigger: 'webhook' });
    if (query.get('wait') === '1' || query.get('wait') === 'true') {
      const r = await done;
      return sendJson(res, r.status === 'completed' ? 200 : 500, { runId: r.id, status: r.status, output: r.output, error: r.error });
    }
    done.catch(() => {});
    sendJson(res, 202, { runId: run.id, status: 'running' });
  });

  // ------------------------------------------------------------------ export / import / reset
  router.get('/api/export', (req, res) => {
    const conns = plugins.list().map((c) => plugins.publicConnector(c)).map((c) => pick(c, ['id', 'pluginId', 'name', 'config', 'enabled', 'createdAt']));
    sendJson(res, 200, { atrium: app.version, exportedAt: now(), agents: store.all('agents'), workflows: store.all('workflows'), connectors: conns, memories: store.all('memories') }, { 'content-disposition': 'attachment; filename="atrium-export.json"' });
  });
  router.post('/api/import', async (req, res) => {
    const body = await readBody(req, 20 * 1024 * 1024);
    const counts = {};
    for (const key of ['agents', 'workflows', 'connectors', 'memories']) {
      counts[key] = 0;
      for (const doc of body[key] || []) {
        if (!doc?.id) continue;
        if (store.get(key, doc.id)) {
          if (key === 'connectors') await plugins.update(doc.id, doc);
          else store.update(key, doc.id, doc);
        } else {
          if (key === 'connectors') for (const [k, v] of Object.entries(doc.config || {})) if (typeof v === 'string' && v.includes('••••')) doc.config[k] = '';
          store.insert(key, doc);
        }
        counts[key]++;
      }
    }
    assignPlots(store); // imported agents may clash with existing plots
    bus.emitEvent('state.imported', { counts });
    sendJson(res, 200, { ok: true, counts });
  });
}
