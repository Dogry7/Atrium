import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../helpers.js';
import { anthropicMock, openaiMock } from '../fixtures/llm-mocks.js';
import anthropic from '../../server/providers/anthropic.js';
import openai from '../../server/providers/openai.js';

describe('Anthropic adapter (wire-compatible mock)', () => {
  let t, mock, m;
  before(async () => {
    mock = anthropicMock(); m = await mock.srv;
    t = await startApp();
    await t.patch('/api/settings', { providers: { anthropic: { apiKey: 'sk-ant-test', baseUrl: m.url } } });
  });
  after(async () => { await t.close(); await m.close(); });

  test('model list comes from /v1/models with the right headers', async () => {
    const r = await t.post('/api/providers/anthropic/test');
    assert.equal(r.body.ok, true);
    assert.deepEqual(r.body.models.map((x) => x.id), ['claude-sonnet-5', 'claude-opus-5-5']);
    const hdr = mock.requests.find((x) => x.url.startsWith('/v1/models')).headers;
    assert.equal(hdr['x-api-key'], 'sk-ant-test');
    assert.equal(hdr['anthropic-version'], '2023-06-01');
  });

  test('streams a reply; system prompt, model and max_tokens are sent correctly', async () => {
    await t.patch(`/api/agents/${t.agent('Quill').id}`, { provider: 'anthropic', model: 'claude-sonnet-5', maxTokens: 900 });
    const r = await t.post('/api/agents/Quill/chat', { message: 'hello', wait: true });
    assert.equal(r.body.reply, 'Hello from mock Claude (model claude-sonnet-5)');
    const req = mock.requests.filter((x) => x.url === '/v1/messages').pop();
    assert.equal(req.body.model, 'claude-sonnet-5');
    assert.equal(req.body.max_tokens, 900);
    assert.equal(req.body.stream, true);
    assert.match(req.body.system, /You are Quill, Writer/);
    assert.equal(req.body.temperature, undefined, 'temperature omitted unless set');
    const task = t.app.store.get('tasks', r.body.taskId);
    assert.deepEqual(task.usage, { input: 50, output: 12 });
  });

  test('tool use round-trip: streamed JSON input, thinking blocks preserved, tool_result sent back', async () => {
    await t.patch(`/api/agents/${t.agent('Nova').id}`, { provider: 'anthropic', model: 'claude-opus-5-5' });
    const r = await t.post('/api/agents/Nova/chat', { message: 'Please ask Atlas what MCP is', wait: true });
    assert.equal(r.body.status.state, 'completed', r.body.error);
    assert.match(r.body.reply, /^Atlas told me: /);
    const msgs = mock.requests.filter((x) => x.url === '/v1/messages');
    const second = msgs[msgs.length - 1].body;
    const assistant = second.messages[second.messages.length - 2];
    assert.deepEqual(assistant.content.map((b) => b.type), ['thinking', 'text', 'tool_use']);
    assert.equal(assistant.content[0].signature, 'SIG123');
    assert.deepEqual(assistant.content[2].input, { agent: 'Atlas', message: 'What is MCP?' });
    const toolResult = second.messages[second.messages.length - 1].content[0];
    assert.equal(toolResult.type, 'tool_result');
    assert.equal(toolResult.tool_use_id, 'toolu_1');
    // tool schema is Anthropic-shaped
    const first = msgs[msgs.length - 2].body;
    const tool = first.tools.find((x) => x.name === 'message_agent');
    assert.equal(tool.input_schema.type, 'object');
  });

  test('401 → clear error; 429 → retried; 529 → overloaded message', async () => {
    await t.patch('/api/settings', { providers: { anthropic: { apiKey: 'wrong-key' } } });
    let r = await t.post('/api/agents/Quill/chat', { message: 'hi', wait: true });
    assert.match(r.body.error, /API key was rejected \(401\)/);
    await t.patch('/api/settings', { providers: { anthropic: { apiKey: 'sk-ant-test' } } });
    mock.requests.length = 0; mock.setMode('rate');
    r = await t.post('/api/agents/Quill/chat', { message: 'hi', wait: true });
    assert.equal(r.body.status.state, 'completed');
    assert.equal(mock.requests.filter((x) => x.url === '/v1/messages').length, 2, 'retried once after 429');
    mock.setMode('overloaded');
    const res = await anthropic.chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }], settings: { providers: { anthropic: { apiKey: 'sk-ant-test', baseUrl: m.url } } } }).catch((e) => e);
    assert.match(res.message, /overloaded right now \(529\)/);
    mock.setMode('normal');
  });
});

describe('OpenAI-compatible adapter (wire-compatible mock)', () => {
  let t, mock, m;
  before(async () => {
    mock = openaiMock(); m = await mock.srv;
    t = await startApp();
    await t.patch('/api/settings', { providers: { openai: { apiKey: 'sk-oa-test', baseUrl: `${m.url}/v1` } } });
  });
  after(async () => { await t.close(); await m.close(); });

  test('model list, bearer auth and model-required validation', async () => {
    const r = await t.get('/api/providers/openai/models');
    assert.deepEqual(r.body.models.map((x) => x.id), ['a-model', 'gpt-test']);
    assert.equal(mock.requests[0].headers.authorization, 'Bearer sk-oa-test');
    const noModel = await openai.chat({ model: '', messages: [], settings: { providers: { openai: { apiKey: 'k', baseUrl: m.url } } } }).catch((e) => e);
    assert.match(noModel.message, /no model selected/);
  });

  test('streamed tool_calls fragments are reassembled, executed, and fed back as role:tool', async () => {
    const kit = (await t.post('/api/connectors', { pluginId: 'example-toolkit', name: 'Toolkit' })).body;
    await t.patch(`/api/agents/${t.agent('Atlas').id}`, { provider: 'openai', model: 'gpt-test', connectors: [kit.id], temperature: 0.2 });
    const r = await t.post('/api/agents/Atlas/chat', { message: 'use calculate on 6*7', wait: true });
    assert.equal(r.body.status.state, 'completed', r.body.error);
    assert.equal(r.body.reply, 'The toolkit says 6*7 = 42');
    const chats = mock.requests.filter((x) => x.url === '/v1/chat/completions');
    const first = chats[chats.length - 2].body, second = chats[chats.length - 1].body;
    assert.equal(first.messages[0].role, 'system');
    assert.equal(first.max_tokens, 2048, 'non-openai.com base uses max_tokens');
    assert.equal(first.temperature, 0.2);
    assert.ok(first.tools.find((x) => x.function.name === 'toolkit__calculate'));
    const toolMsg = second.messages[second.messages.length - 1];
    assert.equal(toolMsg.role, 'tool');
    assert.equal(toolMsg.tool_call_id, 'call_abc');
    assert.equal(second.messages[second.messages.length - 2].tool_calls[0].function.arguments, '{"expression":"6*7"}');
    assert.deepEqual(t.app.store.get('tasks', r.body.taskId).usage, { input: 110, output: 29 });
  });

  test('api.openai.com base uses max_completion_tokens', async () => {
    let captured;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => { captured = { url, body: JSON.parse(init.body) }; return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }); };
    try { await openai.chat({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }], settings: { providers: { openai: { apiKey: 'k' } } } }); }
    finally { globalThis.fetch = realFetch; }
    assert.equal(captured.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(captured.body.max_completion_tokens, 4096);
    assert.equal(captured.body.max_tokens, undefined);
  });
});
