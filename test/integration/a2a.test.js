import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, waitFor, recordEvents, scriptedProvider, httpServer } from '../helpers.js';
import { A2AClient } from '../../server/a2a/client.js';

const use = (name, input, id = `u_${Math.random().toString(36).slice(2, 8)}`) => ({ type: 'tool_use', id, name, input });
const text = (t) => ({ type: 'text', text: t });
const lastText = (messages) => {
  const m = messages[messages.length - 1];
  return typeof m.content === 'string' ? m.content : m.content.map((b) => b.text || b.content || '').join('');
};

describe('Internal A2A between agents', () => {
  let t, script;
  before(async () => {
    t = await startApp();
    // A scripted brain lets us drive exact tool calls and check what each agent sees.
    script = scriptedProvider('scripted', async ({ messages, meta, tools }) => {
      const me = meta.agent.name;
      if (me === 'Nova' && tools.length && messages.some((m) => m.content === 'forever')) return [use('list_agents', {})];
      const last = messages[messages.length - 1];
      const results = Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : [];
      const input = lastText(messages);
      if (results.length) return [text(`${me} final: ${results.map((r) => `[${r.is_error ? 'ERR ' : ''}${r.content}]`).join(' ')}`)];
      if (me === 'Nova' && input.startsWith('fanout')) return [use('message_agent', { agent: 'Atlas', message: 'part A' }), use('message_agent', { agent: 'Quill', message: 'part B' })];
      if (me === 'Nova' && input.startsWith('loop')) return [use('message_agent', { agent: 'Atlas', message: 'loop back to Nova' })];
      if (me === 'Atlas' && input.startsWith('loop back')) return [use('message_agent', { agent: 'Nova', message: 'hey Nova' })];
      if (me === 'Nova' && input.startsWith('chain')) return [use('message_agent', { agent: 'Atlas', message: 'chain 1' })];
      if (me === 'Atlas' && input.startsWith('chain')) return [use('message_agent', { agent: 'Quill', message: 'chain 2' })];
      if (me === 'Quill' && input.startsWith('chain')) return [use('message_agent', { agent: 'Sentinel', message: 'chain 3' })];
      if (me === 'Sentinel' && input.startsWith('chain')) return [use('message_agent', { agent: 'Pixel', message: 'chain 4' })];
      if (me === 'Nova' && input.startsWith('ghost')) return [use('message_agent', { agent: 'Nobody', message: 'x' })];
      if (me === 'Nova' && input.startsWith('slow')) return [use('message_agent', { agent: 'Atlas', message: 'slow job' })];
      if (me === 'Atlas' && input.startsWith('slow')) { await new Promise((r) => setTimeout(r, 3000)); return [text('too late')]; }
      return [text(`${me} answers: ${input}`)];
    });
    for (const a of t.app.store.all('agents')) { a.provider = 'scripted'; }
    await t.post('/api/agents', { name: 'Pixel', role: 'Designer', provider: 'scripted' });
  });
  after(async () => { script.remove(); await t.close(); });

  test('fan-out: two colleagues work in parallel and the lead combines their answers', async () => {
    const rec = recordEvents(t.app);
    const r = await t.post('/api/agents/Nova/chat', { message: 'fanout please', wait: true });
    rec.stop();
    assert.equal(r.body.reply, 'Nova final: [Atlas answers: part A] [Quill answers: part B]');
    const reqs = rec.of('a2a.message').filter((e) => e.kind === 'request');
    assert.deepEqual(reqs.map((e) => `${e.fromName}->${e.toName}`).sort(), ['Nova->Atlas', 'Nova->Quill']);
    const parent = t.app.store.get('tasks', r.body.taskId);
    const kids = t.app.store.all('tasks').filter((x) => x.parentTaskId === parent.id);
    assert.equal(kids.length, 2);
    assert.ok(kids.every((k) => k.from.type === 'agent' && k.from.name === 'Nova'));
    // parallel: both children started before either finished
    const [k1, k2] = kids.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    assert.ok(k2.createdAt <= k1.updatedAt, 'children overlapped in time');
    // each colleague saw a clean, self-contained message and knew who sent it
    const atlasCall = script.calls.find((c) => c.meta.agent.name === 'Atlas' && lastText(c.messages) === 'part A');
    assert.match(atlasCall.system, /This message is from your colleague Nova/);
  });

  test('loop protection: an agent cannot message someone upstream in the chain', async () => {
    const r = await t.post('/api/agents/Nova/chat', { message: 'loop test', wait: true });
    assert.equal(r.body.status.state, 'completed');
    assert.match(r.body.reply, /ERR Error: Nova is already waiting on this conversation/);
  });

  test('delegation depth is capped', async () => {
    const r = await t.post('/api/agents/Nova/chat', { message: 'chain start', wait: true });
    assert.match(r.body.reply, /Delegation depth limit \(4\) reached/);
  });

  test('unknown colleague and disallowed colleague give the model a useful error', async () => {
    const r = await t.post('/api/agents/Nova/chat', { message: 'ghost', wait: true });
    assert.match(r.body.reply, /no colleague called "Nobody"\. Colleagues: Atlas, Quill, Sentinel, Pixel/);
    const nova = t.agent('Nova');
    await t.patch(`/api/agents/${nova.id}`, { a2a: { enabled: true, allow: [t.agent('Quill').id] } });
    // only allowed colleagues are listed in the tool schema + prompt
    const tools = t.app.runtime.builtinTools(t.agent('Nova'));
    assert.deepEqual(tools.find((x) => x.name === 'message_agent').inputSchema.properties.agent.enum, ['Quill']);
    const r2 = await t.post('/api/agents/Nova/chat', { message: 'fanout again', wait: true });
    assert.match(r2.body.reply, /You are not allowed to message Atlas/);
    assert.match(r2.body.reply, /Quill answers: part B/);
    await t.patch(`/api/agents/${nova.id}`, { a2a: { enabled: false, allow: 'all' } });
    assert.equal(t.app.runtime.builtinTools(t.agent('Nova')).find((x) => x.name === 'message_agent'), undefined, 'solo mode has no A2A tools');
    await t.patch(`/api/agents/${nova.id}`, { a2a: { enabled: true, allow: 'all' } });
  });

  test('max steps: an agent that keeps calling tools is made to answer', async () => {
    await t.patch(`/api/agents/${t.agent('Nova').id}`, { maxSteps: 2 });
    const before = script.calls.length;
    const r = await t.post('/api/agents/Nova/chat', { message: 'forever', contextId: 'maxsteps', wait: true });
    assert.equal(r.body.status.state, 'completed');
    const mine = script.calls.slice(before).filter((c) => c.meta.agent.name === 'Nova');
    assert.equal(mine.length, 3, '2 tool rounds + 1 forced final answer');
    assert.deepEqual(mine[2].tools, [], 'final round has no tools');
    await t.patch(`/api/agents/${t.agent('Nova').id}`, { maxSteps: 8 });
  });

  test('cancelling a task cancels its delegated children too', async () => {
    const r = await t.post('/api/agents/Nova/chat', { message: 'slow please' });
    const child = await waitFor(() => t.app.store.all('tasks').find((x) => x.parentTaskId === r.body.taskId), { message: 'child task' });
    const c = await t.post(`/api/tasks/${r.body.taskId}/cancel`);
    assert.equal(c.body.ok, true);
    await waitFor(() => t.app.store.get('tasks', r.body.taskId).status.state === 'canceled', { message: 'parent canceled' });
    await waitFor(() => t.app.store.get('tasks', child.id).status.state === 'canceled', { message: 'child canceled' });
    assert.equal(t.app.runtime.busy.get(t.agent('Atlas').id), 0);
  });

  test('provider errors surface as a failed task with a readable reason', async () => {
    await t.patch(`/api/agents/${t.agent('Quill').id}`, { provider: 'anthropic', model: 'claude-sonnet-5' });
    const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    const r = await t.post('/api/agents/Quill/chat', { message: 'hi', wait: true });
    if (saved) process.env.ANTHROPIC_API_KEY = saved;
    assert.equal(r.body.status.state, 'failed');
    assert.match(r.body.error, /No Anthropic API key yet/);
  });
});

describe('A2A server (JSON-RPC, v1.0 + v0.3)', () => {
  let t, nova;
  const rpc = async (path, method, params, headers = {}) => (await t.post(path, { jsonrpc: '2.0', id: 1, method, params }, headers)).body;
  before(async () => { t = await startApp(); nova = t.agent('Nova'); });
  after(async () => { await t.close(); });

  test('agent cards: per agent, root front desk, and SDK-style base path', async () => {
    const card = (await t.get(`/a2a/${nova.id}/.well-known/agent-card.json`)).body;
    assert.equal(card.name, 'Nova');
    assert.equal(card.url, `${t.base}/a2a/${nova.id}`);
    assert.equal(card.supportedInterfaces[0].protocolBinding, 'JSONRPC');
    assert.ok(card.skills[0].description.includes('coordinate'));
    assert.equal((await t.get('/.well-known/agent-card.json')).body.name, 'Nova');
    assert.equal((await t.get('/a2a/.well-known/agent-card.json')).body.name, 'Nova');
    await t.patch('/api/settings', { a2a: { frontDeskAgentId: t.agent('Quill').id } });
    assert.equal((await t.get('/.well-known/agent-card.json')).body.name, 'Quill');
    assert.equal((await t.get('/a2a/nobody/.well-known/agent-card.json')).status, 404);
  });

  test('v1.0 SendMessage → {task} with TASK_STATE_COMPLETED, then GetTask', async () => {
    const r = await rpc(`/a2a/${nova.id}`, 'SendMessage', { message: { role: 'ROLE_USER', messageId: 'm1', parts: [{ text: 'hello there' }] } }, { 'A2A-Version': '1.0' });
    assert.equal(r.result.task.status.state, 'TASK_STATE_COMPLETED');
    assert.match(r.result.task.artifacts[0].parts[0].text, /I'm Nova/);
    const g = await rpc(`/a2a/${nova.id}`, 'GetTask', { id: r.result.task.id });
    assert.equal(g.result.id, r.result.task.id);
    assert.equal(g.result.history.length, 2);
    // the task shows up in Atrium as an external A2A task
    const task = t.app.store.get('tasks', r.result.task.id);
    assert.equal(task.from.type, 'external');
  });

  test('v0.3 message/send → Task with kind + lowercase state; data parts accepted; context kept', async () => {
    const r = await rpc(`/a2a/${nova.id}`, 'message/send', { message: { kind: 'message', role: 'user', messageId: 'm2', contextId: 'ctx-1', parts: [{ kind: 'text', text: 'Summarise this:' }, { kind: 'data', data: { ticket: 42 } }] } });
    assert.equal(r.result.kind, 'task');
    assert.equal(r.result.status.state, 'completed');
    assert.equal(r.result.contextId, 'ctx-1');
    assert.equal(r.result.artifacts[0].parts[0].kind, 'text');
    const task = t.app.store.get('tasks', r.result.id);
    assert.match(task.input, /"ticket": 42/);
    const list = await rpc(`/a2a/${nova.id}`, 'ListTasks', {});
    assert.ok(list.result.tasks.length >= 2);
  });

  test('JSON-RPC errors: method, params, task not found, not cancelable, batch', async () => {
    assert.equal((await rpc(`/a2a/${nova.id}`, 'Nope', {})).error.code, -32601);
    assert.equal((await rpc(`/a2a/${nova.id}`, 'SendMessage', {})).error.code, -32602);
    assert.equal((await rpc(`/a2a/${nova.id}`, 'GetTask', { id: 'missing' })).error.code, -32001);
    const done = await rpc(`/a2a/${nova.id}`, 'message/send', { message: { role: 'user', messageId: 'x', parts: [{ kind: 'text', text: 'hi' }] } });
    assert.equal((await rpc(`/a2a/${nova.id}`, 'tasks/cancel', { id: done.result.id })).error.code, -32002);
    assert.equal((await t.post(`/a2a/${nova.id}`, { hello: 1 })).body.error.code, -32600);
    const batch = await t.post(`/a2a/${nova.id}`, [{ jsonrpc: '2.0', id: 'a', method: 'GetTask', params: { id: done.result.id } }, { jsonrpc: '2.0', id: 'b', method: 'Nope' }]);
    assert.equal(batch.body.length, 2);
    assert.equal(batch.body[0].result.id, done.result.id);
    assert.equal(batch.body[1].error.code, -32601);
  });

  test('bearer token is enforced when set; server can be disabled', async () => {
    await t.patch('/api/settings', { a2a: { token: 's3cret-token' } });
    const card = (await t.get(`/a2a/${nova.id}/.well-known/agent-card.json`)).body;
    assert.deepEqual(card.security, [{ bearer: [] }]);
    assert.equal((await t.post(`/a2a/${nova.id}`, { jsonrpc: '2.0', id: 1, method: 'ListTasks' })).status, 401);
    const ok = await rpc(`/a2a/${nova.id}`, 'ListTasks', {}, { authorization: 'Bearer s3cret-token' });
    assert.ok(ok.result);
    await t.patch('/api/settings', { a2a: { token: '', enabled: false } });
    assert.equal((await t.post(`/a2a/${nova.id}`, { jsonrpc: '2.0', id: 1, method: 'ListTasks' })).status, 403);
    await t.patch('/api/settings', { a2a: { enabled: true } });
  });

  test('interop: the official A2A JS SDK (v1.0) client talks to an Atrium agent', async () => {
    const { ClientFactory } = await import('@a2a-js/sdk/client');
    const client = await new ClientFactory().createFromUrl(`${t.base}/a2a/${nova.id}/`);
    const r = await client.sendMessage({ message: { messageId: 'sdk-1', role: 1, parts: [{ content: { $case: 'text', value: 'hello from the SDK' } }], contextId: '', taskId: '', metadata: {}, extensions: [], referenceTaskIds: [] } });
    const task = r.task || r.payload?.value || r;
    assert.equal(task.status.state, 3, 'TASK_STATE_COMPLETED');
    const reply = task.artifacts[0].parts[0].content.value;
    assert.match(reply, /Nova/);
    const got = await client.getTask({ id: task.id, historyLength: 10 });
    assert.equal(got.id, task.id);
  });
});

describe('A2A client (remote agents)', () => {
  test('talks to a server built with the official A2A SDK', async () => {
    const express = (await import('express')).default;
    const { DefaultRequestHandler, InMemoryTaskStore, AgentEvent } = await import('@a2a-js/sdk/server');
    const { agentCardHandler, jsonRpcHandler, UserBuilder } = await import('@a2a-js/sdk/server/express');
    const app = express();
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const url = `http://127.0.0.1:${server.address().port}/`;
    const card = {
      name: 'SDK Echo', description: 'Echo agent built with @a2a-js/sdk', version: '1.0.0',
      supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' }],
      capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
      securitySchemes: {}, securityRequirements: [], defaultInputModes: ['text'], defaultOutputModes: ['text'],
      skills: [{ id: 'echo', name: 'Echo', description: 'echoes', tags: [], examples: [], inputModes: ['text'], outputModes: ['text'], securityRequirements: [] }],
      documentationUrl: '', signatures: [],
    };
    const executor = {
      cancelTask: async () => {},
      async execute(ctx, bus) {
        const q = ctx.userMessage.parts.map((p) => p.content?.value).join(' ');
        const now = new Date().toISOString();
        bus.publish(AgentEvent.task({ id: ctx.taskId, contextId: ctx.contextId, status: { state: 1, timestamp: now }, artifacts: [], history: [ctx.userMessage], metadata: {} }));
        bus.publish(AgentEvent.artifactUpdate({ taskId: ctx.taskId, contextId: ctx.contextId, artifact: { artifactId: 'a1', name: 'r', description: '', parts: [{ content: { $case: 'text', value: `SDK echo: ${q}` }, filename: '', mediaType: 'text/plain' }], extensions: [] }, lastChunk: true, append: false }));
        bus.publish(AgentEvent.statusUpdate({ taskId: ctx.taskId, contextId: ctx.contextId, status: { state: 3, timestamp: now } }));
      },
    };
    const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
    app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: handler }));
    app.use(jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
    try {
      const c = new A2AClient({ url });
      const got = await c.resolveCard();
      assert.equal(got.name, 'SDK Echo');
      const r = await c.send('ping from Atrium');
      assert.equal(r.dialect, 'v1');
      assert.equal(r.text, 'SDK echo: ping from Atrium');
    } finally { server.closeAllConnections(); server.close(); }
  });

  test('falls back to v0.3 for older agents and polls working tasks to completion', async () => {
    let polls = 0;
    const legacy = await httpServer(async (req, res, body) => {
      if (req.url.endsWith('agent-card.json')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ name: 'Legacy', url: `http://${req.headers.host}/rpc`, skills: [] })); }
      const reply = (x) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...x })); };
      if (body.method === 'SendMessage') return reply({ error: { code: -32601, message: 'Method not found' } });
      if (body.method === 'message/send') return reply({ result: { kind: 'task', id: 'T1', contextId: 'C', status: { state: 'working' } } });
      if (body.method === 'tasks/get') { polls++; return reply({ result: { kind: 'task', id: 'T1', status: polls < 2 ? { state: 'working' } : { state: 'completed' }, artifacts: [{ parts: [{ kind: 'text', text: 'legacy done' }] }] } }); }
      reply({ error: { code: -32601, message: 'nope' } });
    });
    try {
      const c = new A2AClient({ url: legacy.url });
      const r = await c.send('hello');
      assert.equal(r.dialect, 'v0.3');
      assert.equal(r.text, 'legacy done');
      assert.equal(polls, 2);
    } finally { await legacy.close(); }
  });

  test('two Atrium offices: a remote A2A connector becomes a colleague', async () => {
    const hq = await startApp();
    const branch = await startApp();
    try {
      await branch.patch(`/api/agents/${branch.agent('Nova').id}`, { name: 'Remy', role: 'Branch manager' });
      const remoteUrl = `${branch.base}/a2a/${branch.agent('Remy').id}/.well-known/agent-card.json`;
      const con = (await hq.post('/api/connectors', { pluginId: 'a2a-remote', name: 'Branch office', config: { url: remoteUrl } })).body;
      const test1 = (await hq.post(`/api/connectors/${con.id}/test`)).body;
      assert.equal(test1.ok, true, test1.message);
      assert.match(test1.message, /Found "Remy"/);
      assert.equal(test1.tools[0].name, 'send_message');
      // Give it to Atlas; Atlas (simulated brain) uses the tool when asked
      await hq.patch(`/api/agents/${hq.agent('Atlas').id}`, { connectors: [...hq.agent('Atlas').connectors, con.id] });
      const r = await hq.post('/api/agents/Atlas/chat', { message: 'use send_message tool with hello branch office', wait: true });
      assert.equal(r.body.status.state, 'completed');
      assert.match(r.body.reply, /Result from `send_message`/);
      assert.match(r.body.reply, /Remy/);
      // the branch office saw an external A2A task from Atlas
      const ext = branch.app.store.all('tasks').find((x) => x.from.type === 'external');
      assert.ok(ext);
      assert.equal(ext.from.name, 'Atlas');
      assert.equal(ext.input, 'hello branch office');
    } finally { await hq.close(); await branch.close(); }
  });
});
