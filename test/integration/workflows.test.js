import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, waitFor, recordEvents, scriptedProvider } from '../helpers.js';
import { layaMock } from '../fixtures/laya-mock.js';

const n = (id, type, data = {}) => ({ id, type, x: 0, y: 0, data });
const e = (from, to, fromPort = 'out') => ({ id: `${from}-${to}-${fromPort}`, from, to, fromPort });

describe('Workflow engine', () => {
  let t, script;
  before(async () => {
    t = await startApp();
    // Deterministic brain for workflows: echoes its prompt so we can assert data flow.
    script = scriptedProvider('echo', async ({ messages, meta }) => {
      const last = messages[messages.length - 1];
      const txt = typeof last.content === 'string' ? last.content : '';
      if (meta.decide) return [{ type: 'text', text: meta.decide.options.find((o) => txt.toLowerCase().includes(o.label))?.label || meta.decide.options[1].label }];
      if (txt.includes('FAIL')) throw new Error('model exploded');
      if (txt.includes('SLOW')) { await new Promise((r) => setTimeout(r, 2000)); }
      return [{ type: 'text', text: `${meta.agent.name}<${txt}>` }];
    });
    for (const a of t.app.store.all('agents')) a.provider = 'echo';
  });
  after(async () => { script.remove(); await t.close(); });
  const mk = async (name, nodes, edges, extra = {}) => (await t.post('/api/workflows', { name, nodes, edges, ...extra })).body;
  const run = async (id, input, wait = true) => (await t.post(`/api/workflows/${id}/run`, { input, wait })).body;

  test('seeded Research → Draft → Review passes data between agents', async () => {
    const wf = t.app.store.all('workflows').find((w) => w.name.startsWith('Research'));
    const r = await run(wf.id, 'Why tea?');
    assert.equal(r.status, 'completed', r.error);
    assert.match(r.output, /^## Briefing\n\nQuill<Write a 200-word briefing on "Why tea\?"/);
    assert.match(r.output, /Atlas<Research this topic/, 'draft saw research output via {{last}}');
    assert.match(r.output, /## Review\n\nSentinel<Review this briefing/);
    // each agent step created a task linked to the run
    const tasks = t.app.store.all('tasks').filter((x) => x.workflowRunId === r.id);
    assert.deepEqual(tasks.map((x) => x.agentName), ['Atlas', 'Quill', 'Sentinel']);
    assert.ok(tasks.every((x) => x.from.type === 'workflow'));
  });

  test('condition branches, skipped branches propagate, joins wait for the taken path', async () => {
    const atlas = t.agent('Atlas').id;
    const wf = await mk('Branchy', [
      n('s', 'trigger'), n('c', 'condition', { left: '{{input}}', op: 'contains', right: 'urgent' }),
      n('yes', 'transform', { template: 'URGENT: {{input}}' }), n('no', 'agent', { agentId: atlas, prompt: 'calm: {{input}}' }),
      n('after-no', 'transform', { template: 'still calm' }),
      n('join', 'output', { template: '[{{last}}]' }),
    ], [e('s', 'c'), e('c', 'yes', 'true'), e('c', 'no', 'false'), e('no', 'after-no'), e('yes', 'join'), e('after-no', 'join')]);
    let r = await run(wf.id, 'this is urgent!');
    assert.equal(r.output, '[URGENT: this is urgent!]');
    assert.equal(r.nodes.no.status, 'skipped');
    assert.equal(r.nodes['after-no'].status, 'skipped', 'skip propagated');
    r = await run(wf.id, 'all fine');
    assert.equal(r.output, '[still calm]');
    assert.equal(r.nodes.yes.status, 'skipped');
  });

  test('parallel fan-out and join combine outputs; multiple outputs become an object', async () => {
    const [a, q] = [t.agent('Atlas').id, t.agent('Quill').id];
    const wf = await mk('Fan', [n('s', 'trigger'), n('a', 'agent', { agentId: a, prompt: 'A:{{input}}' }), n('b', 'agent', { agentId: q, prompt: 'B:{{input}}' }), n('j', 'transform', { template: '{{nodes.a.output}} + {{nodes.b.output}}' }), n('o1', 'output', { label: 'combined' }), n('o2', 'output', { label: 'raw', template: '{{input}}' })],
      [e('s', 'a'), e('s', 'b'), e('a', 'j'), e('b', 'j'), e('j', 'o1'), e('s', 'o2')]);
    const r = await run(wf.id, 'x');
    assert.deepEqual(r.output, { combined: 'Atlas<A:x> + Quill<B:x>', raw: 'x' });
    const A = t.app.store.get('runs', r.id).nodes;
    assert.ok(A.b.startedAt <= A.a.finishedAt, 'a and b ran in parallel');
  });

  test('tool steps call connector tools with templated JSON args', async () => {
    const kit = (await t.post('/api/connectors', { pluginId: 'example-toolkit', name: 'Kit' })).body;
    const wf = await mk('Calc', [n('s', 'trigger'), n('calc', 'tool', { connectorId: kit.id, tool: 'calculate', args: '{"expression": "{{input.a}} * {{input.b}}"}' }), n('o', 'output')], [e('s', 'calc'), e('calc', 'o')]);
    const r = await run(wf.id, { a: 6, b: 7 });
    assert.equal(r.output, '6 * 7 = 42');
    const bad = await mk('BadArgs', [n('s', 'trigger'), n('calc', 'tool', { connectorId: kit.id, tool: 'calculate', args: '{"expression": {{input}} }' })], [e('s', 'calc')]);
    const r2 = await run(bad.id, 'not json "quoted"');
    assert.equal(r2.status, 'failed');
    assert.match(r2.error, /not valid JSON after filling in templates/);
  });

  test('a failing step fails the run with the step name and stops downstream steps', async () => {
    const wf = await mk('Boom', [n('s', 'trigger'), n('a', 'agent', { label: 'Exploder', agentId: t.agent('Atlas').id, prompt: 'FAIL now' }), n('o', 'output')], [e('s', 'a'), e('a', 'o')]);
    const r = await run(wf.id, 'x');
    assert.equal(r.status, 'failed');
    assert.match(r.error, /^Exploder: model exploded/);
    assert.equal(r.nodes.o.status, 'skipped');
  });

  test('validation blocks broken workflows before they run', async () => {
    const wf = await mk('Broken', [n('s', 'trigger'), n('a', 'agent', { label: 'Nobody', agentId: 'agt_gone' })], [e('s', 'a')]);
    const res = await t.post(`/api/workflows/${wf.id}/run`, { input: 'x' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /"Nobody": choose an agent/);
    const got = (await t.get(`/api/workflows/${wf.id}`)).body;
    assert.ok(got.problems.length);
  });

  test('runs can be cancelled mid-flight', async () => {
    const wf = await mk('Slow', [n('s', 'trigger'), n('a', 'agent', { agentId: t.agent('Atlas').id, prompt: 'SLOW' }), n('o', 'output')], [e('s', 'a'), e('a', 'o')]);
    const { runId } = await run(wf.id, 'x', false);
    await waitFor(() => t.app.store.get('runs', runId)?.nodes.a.status === 'running');
    assert.equal((await t.post(`/api/runs/${runId}/cancel`)).body.ok, true);
    await waitFor(() => t.app.store.get('runs', runId).status === 'canceled', { message: 'run canceled' });
    assert.equal(t.app.store.get('runs', runId).error, 'Cancelled');
  });

  test('run events stream node-by-node progress', async () => {
    const wf = t.app.store.all('workflows').find((w) => w.name === 'Fan');
    const rec = recordEvents(t.app);
    await run(wf.id, 'y');
    rec.stop();
    const types = rec.events.filter((x) => x.type.startsWith('run.')).map((x) => x.type);
    assert.equal(types[0], 'run.started');
    assert.equal(types[types.length - 1], 'run.finished');
    assert.ok(rec.of('run.node').some((x) => x.nodeId === 'j' && x.status === 'done' && x.output === 'Atlas<A:y> + Quill<B:y>'));
  });

  test('webhook trigger: disabled, bad token, async and wait=1', async () => {
    const wf = t.app.store.all('workflows').find((w) => w.name === 'Branchy');
    let r = await t.post(`/api/hooks/${wf.id}`, { input: 'x' });
    assert.equal(r.status, 403);
    await t.put(`/api/workflows/${wf.id}`, { trigger: { ...wf.trigger, webhook: { enabled: true, token: 'hook_abc' } } });
    assert.equal((await t.post(`/api/hooks/${wf.id}?token=nope`, { input: 'x' })).status, 401);
    r = await t.post(`/api/hooks/${wf.id}?token=hook_abc&wait=1`, { input: 'server is down, urgent' });
    assert.equal(r.status, 200);
    assert.equal(r.body.output, '[URGENT: server is down, urgent]');
    r = await t.post(`/api/hooks/${wf.id}`, { text: 'calm' }, { 'x-atrium-token': 'hook_abc' });
    assert.equal(r.status, 202);
    const done = await waitFor(() => { const x = t.app.store.get('runs', r.body.runId); return x?.status === 'completed' && x; });
    assert.equal(done.trigger, 'webhook');
    assert.equal(done.input, 'calm');
    // an arbitrary JSON body becomes the input object
    const obj = await t.post(`/api/hooks/${wf.id}?token=hook_abc&wait=1`, { event: 'push', repo: 'atrium' });
    assert.equal(obj.body.output, '[still calm]');
  });

  test('schedule trigger runs due workflows', async () => {
    const wf = t.app.store.all('workflows').find((w) => w.name === 'Fan');
    await t.put(`/api/workflows/${wf.id}`, { trigger: { ...wf.trigger, schedule: { enabled: true, everyMinutes: 60, input: 'tick' } } });
    const before = t.app.store.all('runs').filter((r) => r.workflowId === wf.id).length;
    t.app.tick();
    await waitFor(() => t.app.store.all('runs').filter((r) => r.workflowId === wf.id && r.trigger === 'schedule' && r.status === 'completed').length === 1);
    t.app.tick(); // not due again yet
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t.app.store.all('runs').filter((r) => r.workflowId === wf.id).length, before + 1);
  });
});

describe('Decide step: Laya first, escalate to an LLM when unsure', () => {
  let t, laya, script;
  before(async () => {
    laya = await layaMock();
    t = await startApp();
    script = scriptedProvider('picker', async ({ meta }) => [{ type: 'text', text: meta.decide ? 'general' : 'ok' }]);
    await t.patch(`/api/agents/${t.agent('Sentinel').id}`, { provider: 'picker' });
    await t.post('/api/connectors', { pluginId: 'laya', name: 'Laya', config: { baseUrl: laya.url } });
  });
  after(async () => { script.remove(); await t.close(); await laya.close(); });
  const triage = () => t.app.store.all('workflows').find((w) => w.name.startsWith('Support triage'));
  const decideNode = (r) => Object.values(r.nodes).find((x) => x.detail?.engine);

  test('confident Laya decision routes directly (no LLM call)', async () => {
    const calls = script.calls.length;
    const r = (await t.post(`/api/workflows/${triage().id}/run`, { input: 'I was charged twice on my invoice, please refund the payment', wait: true })).body;
    assert.equal(r.status, 'completed', r.error);
    assert.match(r.output, /^\[routed to billing\]/);
    const d = decideNode(r).detail;
    assert.equal(d.engine, 'laya');
    assert.ok(d.confidence >= 0.7);
    assert.equal(script.calls.length, calls, 'no escalation');
  });

  test('low-confidence Laya decision escalates to the LLM agent and records both', async () => {
    const r = (await t.post(`/api/workflows/${triage().id}/run`, { input: 'hello, quick question about your company', wait: true })).body;
    assert.equal(r.status, 'completed', r.error);
    const d = decideNode(r).detail;
    assert.equal(d.engine, 'llm');
    assert.equal(d.escalated, true);
    assert.equal(d.agentName, 'Sentinel');
    assert.ok(d.laya.confidence < 0.7);
    assert.match(r.output, /^\[routed to general\]/);
  });

  test('Laya unavailable: auto falls back to the LLM; laya-only fails loudly', async () => {
    const con = t.app.store.all('connectors').find((c) => c.pluginId === 'laya');
    await t.patch(`/api/connectors/${con.id}`, { config: { baseUrl: 'http://127.0.0.1:9' } });
    let r = (await t.post(`/api/workflows/${triage().id}/run`, { input: 'refund please', wait: true })).body;
    assert.equal(r.status, 'completed');
    const d = decideNode(r).detail;
    assert.equal(d.engine, 'llm');
    assert.match(d.layaError, /Can't reach laya-serve/);
    const wf = triage();
    const nodes = wf.nodes.map((x) => (x.type === 'decide' ? { ...x, data: { ...x.data, engine: 'laya' } } : x));
    await t.put(`/api/workflows/${wf.id}`, { nodes });
    r = (await t.post(`/api/workflows/${wf.id}/run`, { input: 'refund please', wait: true })).body;
    assert.equal(r.status, 'failed');
    assert.match(r.error, /Route: .*Can't reach laya-serve/);
  });

  test('without any Laya connector, auto uses the LLM and laya-only is flagged by validation', async () => {
    const con = t.app.store.all('connectors').find((c) => c.pluginId === 'laya');
    await t.del(`/api/connectors/${con.id}`);
    const wf = triage();
    const res = await t.post(`/api/workflows/${wf.id}/run`, { input: 'x' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /add a Laya connector first/);
    await t.put(`/api/workflows/${wf.id}`, { nodes: wf.nodes.map((x) => (x.type === 'decide' ? { ...x, data: { ...x.data, engine: 'auto' } } : x)) });
    const r = (await t.post(`/api/workflows/${wf.id}/run`, { input: 'anything', wait: true })).body;
    assert.equal(r.status, 'completed');
    assert.equal(decideNode(r).detail.engine, 'llm');
    assert.equal(decideNode(r).detail.escalated, false);
  });
});
