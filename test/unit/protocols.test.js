import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { messageText, taskToWire, normalizeState, toV1State, resultText, resultTask, isTerminal, makeMessage } from '../../server/a2a/protocol.js';
import simulated, { subjectOf, bestOption } from '../../server/providers/simulated.js';
import { mcpResultToText } from '../../server/mcp/client.js';

const task = {
  id: 't1', contextId: 'c1', agentId: 'a', agentName: 'Nova', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:01Z',
  status: { state: 'completed', timestamp: '2026-01-01T00:00:01Z' },
  history: [{ role: 'user', text: 'hi' }, { role: 'agent', text: 'hello!' }],
  artifacts: [{ text: 'hello!' }],
};

describe('A2A protocol shapes', () => {
  test('state normalisation across dialects', () => {
    assert.equal(normalizeState('TASK_STATE_COMPLETED'), 'completed');
    assert.equal(normalizeState('input-required'), 'input-required');
    assert.equal(normalizeState('TASK_STATE_INPUT_REQUIRED'), 'input-required');
    assert.equal(normalizeState('cancelled'), 'canceled');
    assert.equal(toV1State('working'), 'TASK_STATE_WORKING');
    assert.ok(isTerminal('TASK_STATE_FAILED'));
    assert.ok(!isTerminal('working'));
  });
  test('v1 wire task', () => {
    const w = taskToWire(task, 'v1');
    assert.equal(w.status.state, 'TASK_STATE_COMPLETED');
    assert.equal(w.history[0].role, 'ROLE_USER');
    assert.equal(w.history[1].role, 'ROLE_AGENT');
    assert.deepEqual(w.artifacts[0].parts, [{ text: 'hello!' }]);
    assert.equal(w.kind, undefined);
  });
  test('v0.3 wire task', () => {
    const w = taskToWire(task, 'v0.3', { historyLength: 1 });
    assert.equal(w.kind, 'task');
    assert.equal(w.status.state, 'completed');
    assert.equal(w.history.length, 1);
    assert.deepEqual(w.artifacts[0].parts, [{ kind: 'text', text: 'hello!' }]);
  });
  test('text extraction handles every part style', () => {
    assert.equal(messageText({ parts: [{ text: 'a' }, { kind: 'text', text: 'b' }, { kind: 'data', data: { x: 1 } }] }), 'a\nb\n```json\n{\n  "x": 1\n}\n```');
    assert.equal(resultText({ task: taskToWire(task, 'v1') }), 'hello!');
    assert.equal(resultText(taskToWire(task, 'v0.3')), 'hello!');
    assert.equal(resultText({ message: makeMessage({ role: 'agent', text: 'direct' }, 'v1') }), 'direct');
    assert.equal(resultTask({ message: {} }), null);
  });
});

describe('Simulated brain', () => {
  const roster = [{ name: 'Atlas', role: 'Researcher' }, { name: 'Quill', role: 'Writer' }];
  const tools = [{ name: 'message_agent' }, { name: 'web__web_fetch', inputSchema: { properties: { url: {} } } }, { name: 'remember' }, { name: 'kit__calculate', inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } }];
  const chat = (text, extra = {}) => simulated.chat({ messages: [{ role: 'user', content: text }], tools, meta: { agent: { name: 'Nova', role: 'Lead' }, roster, from: { type: 'user' }, ...extra } });

  test('delegates to every named colleague in parallel, with a cleaned-up message', async () => {
    const r = await chat('Ask Atlas and Quill what they think about launching a newsletter');
    const uses = r.content.filter((b) => b.type === 'tool_use');
    assert.deepEqual(uses.map((u) => u.input.agent), ['Atlas', 'Quill']);
    assert.equal(uses[0].input.message, 'What do you think about launching a newsletter');
    assert.equal(r.stopReason, 'tool_use');
  });
  test('does not re-delegate when the message came from another agent', async () => {
    const r = await chat('Ask Quill to check this', { from: { type: 'agent', name: 'Atlas' } });
    assert.equal(r.stopReason, 'end_turn');
  });
  test('fetches URLs, remembers, and uses named tools with inferred args', async () => {
    assert.equal((await chat('Summarise https://example.com/page please')).content[1].input.url, 'https://example.com/page');
    assert.equal((await chat('Remember that my favourite colour is teal')).content[1].input.note, 'my favourite colour is teal');
    const calc = await chat('use calculate tool with 12*7');
    assert.equal(calc.content[1].name, 'kit__calculate');
    assert.equal(calc.content[1].input.expression, '12*7');
  });
  test('summarises tool results into a final answer', async () => {
    const r = await simulated.chat({
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'message_agent', input: { agent: 'Atlas' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'Facts here' }] },
      ], tools, meta: { agent: { name: 'Nova' } },
    });
    assert.match(r.content[0].text, /\*\*Atlas\*\* says: Facts here/);
  });
  test('decision mode picks the best matching option', async () => {
    assert.equal(bestOption('We were charged twice, please refund', [{ label: 'billing', description: 'invoices, payments, refunds' }, { label: 'technical', description: 'bugs' }]).label, 'billing');
  });
  test('subject extraction', () => {
    assert.equal(subjectOf('Write a 200-word briefing on "Why teams adopt AI" using these notes:'), 'Why teams adopt AI');
    assert.equal(subjectOf('Can you write a short post about launching a newsletter?'), 'launching a newsletter');
  });
});

describe('MCP result flattening', () => {
  test('text, images, resources and structured content', () => {
    assert.equal(mcpResultToText({ content: [{ type: 'text', text: 'a' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }] }), 'a\n[image image/png, 0KB]');
    assert.equal(mcpResultToText({ content: [], structuredContent: { ok: 1 } }), '{\n  "ok": 1\n}');
    assert.equal(mcpResultToText({ content: [{ type: 'resource', resource: { uri: 'x', text: 'body' } }] }), 'body');
  });
});
