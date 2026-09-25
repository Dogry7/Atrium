import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { render, renderDeep, lookup } from '../../server/workflows/template.js';
import { compare, matchOption, validateWorkflow, portsOf } from '../../server/workflows/engine.js';
import { parseSSE } from '../../server/providers/sse.js';
import { toAnthropicMessages } from '../../server/providers/anthropic.js';
import { toOpenAIMessages } from '../../server/providers/openai.js';
import { splitArgs } from '../../server/plugins/builtin/mcp.js';
import { htmlToText } from '../../server/plugins/builtin/web.js';
import { trimThread } from '../../server/runtime/agents.js';
import { toolName, mask, slugify } from '../../server/util.js';
import { markdown } from '../../web/js/markdown.js';

describe('templates', () => {
  const scope = { input: { city: 'Sydney', n: 3 }, last: 'prev', nodes: { a: { output: 'A out', choice: 'billing' } } };
  test('renders paths, nested fields and unknowns', () => {
    assert.equal(render('Hi {{input.city}} / {{ last }} / {{nodes.a.output}} / {{missing.x}}', scope), 'Hi Sydney / prev / A out / ');
  });
  test('objects are JSON-stringified', () => {
    assert.match(render('{{input}}', scope), /"city": "Sydney"/);
  });
  test('JSON string input can be traversed', () => {
    assert.equal(lookup({ input: '{"a":{"b":5}}' }, 'input.a.b'), 5);
  });
  test('renderDeep keeps raw types for whole-value templates', () => {
    assert.deepEqual(renderDeep({ n: '{{input.n}}', s: 'x{{input.n}}', arr: ['{{last}}'] }, scope), { n: 3, s: 'x3', arr: ['prev'] });
  });
});

describe('workflow helpers', () => {
  test('compare operators', () => {
    assert.equal(compare('Verdict: APPROVE', 'contains', 'approve'), true);
    assert.equal(compare('abc', 'not_contains', 'z'), true);
    assert.equal(compare(' Yes ', 'equals', 'yes'), true);
    assert.equal(compare('10', 'gt', '9'), true);
    assert.equal(compare('3', 'lt', '2'), false);
    assert.equal(compare('', 'empty'), true);
    assert.equal(compare('order #123', 'regex', '#\\d+'), true);
    assert.throws(() => compare('x', 'regex', '('), /Invalid regex/);
    assert.throws(() => compare('x', 'nope', 'y'), /Unknown operator/);
  });
  test('matchOption is strict but forgiving about formatting', () => {
    const opts = [{ label: 'billing' }, { label: 'technical' }, { label: 'general' }];
    assert.equal(matchOption('billing', opts), 'billing');
    assert.equal(matchOption('**Technical**.', opts), 'technical');
    assert.equal(matchOption('I think this is billing.', opts), 'billing');
    assert.equal(matchOption('billing or technical', opts), null); // ambiguous
    assert.equal(matchOption('sales', opts), null);
  });
  test('ports per node type', () => {
    assert.deepEqual(portsOf({ type: 'decide', data: { options: [{ label: 'a' }, { label: 'b' }] } }), ['a', 'b']);
    assert.deepEqual(portsOf({ type: 'condition' }), ['true', 'false']);
    assert.deepEqual(portsOf({ type: 'output' }), []);
  });
  test('validation catches missing agents, bad decide, loops and orphans', () => {
    const wf = {
      nodes: [
        { id: 't', type: 'trigger', data: {} },
        { id: 'a', type: 'agent', data: { agentId: 'ghost', label: 'A' } },
        { id: 'd', type: 'decide', data: { label: 'D', options: [{ label: 'x' }] } },
        { id: 'o', type: 'output', data: { label: 'Lonely' } },
      ],
      edges: [{ id: 'e1', from: 't', to: 'a' }, { id: 'e2', from: 'a', to: 'd' }, { id: 'e3', from: 'd', to: 'a', fromPort: 'x' }],
    };
    const errs = validateWorkflow(wf, { agents: [], connectors: [] });
    const msgs = errs.map((e) => e.message).join('\n');
    assert.match(msgs, /"A": choose an agent/);
    assert.match(msgs, /needs at least 2 options/);
    assert.match(msgs, /loop/);
    assert.ok(errs.find((e) => e.nodeId === 'o' && e.warning));
    assert.match(validateWorkflow({ nodes: [], edges: [] }).map((e) => e.message).join(), /no steps/);
  });
});

describe('SSE parser', () => {
  test('handles events split across arbitrary chunk boundaries, CRLF and comments', async () => {
    const raw = ': comment\r\n\r\nevent: a\r\ndata: {"x":1}\r\n\r\ndata: line1\ndata: line2\n\nevent: done\ndata: [DONE]\n\n';
    for (const size of [1, 3, 7, 1000]) {
      const chunks = [];
      for (let i = 0; i < raw.length; i += size) chunks.push(new TextEncoder().encode(raw.slice(i, i + size)));
      const body = new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); } });
      const out = [];
      for await (const e of parseSSE(body)) out.push(e);
      assert.deepEqual(out.map((e) => [e.event, e.data]), [['a', '{"x":1}'], ['message', 'line1\nline2'], ['done', '[DONE]']], `chunk size ${size}`);
    }
  });
});

describe('provider message mapping', () => {
  const internal = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }, { type: 'text', text: 'Let me check' }, { type: 'tool_use', id: 't1', name: 'web__fetch', input: { url: 'x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'page text' }] },
    { role: 'user', content: 'and also?' },
  ];
  test('Anthropic: merges consecutive same-role turns, keeps thinking blocks', () => {
    const out = toAnthropicMessages(internal);
    assert.equal(out.length, 3);
    assert.equal(out[1].content[0].type, 'thinking');
    assert.deepEqual(out[2].content.map((b) => b.type), ['tool_result', 'text']);
  });
  test('OpenAI: tool_use → tool_calls, tool_result → role tool, thinking dropped', () => {
    const out = toOpenAIMessages('SYS', internal);
    assert.deepEqual(out.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'user']);
    assert.equal(out[2].tool_calls[0].function.name, 'web__fetch');
    assert.equal(out[2].tool_calls[0].function.arguments, '{"url":"x"}');
    assert.equal(out[2].content, 'Let me check');
    assert.equal(out[3].tool_call_id, 't1');
    assert.equal(out[3].content, 'page text');
  });
  test('error tool results are marked for OpenAI', () => {
    const out = toOpenAIMessages('', [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'boom', is_error: true }] }]);
    assert.equal(out[0].content, 'ERROR: boom');
  });
});

describe('misc utilities', () => {
  test('tool names are sanitised and capped at 64 chars', () => {
    assert.equal(toolName('my connector!', 'do.thing'), 'my_connector___do_thing');
    assert.equal(toolName('x'.repeat(50), 'y'.repeat(50)).length, 64);
  });
  test('mask hides secrets', () => { assert.equal(mask('sk-ant-1234567890abcd'), 'sk-a••••abcd'); assert.equal(mask(''), ''); });
  test('slugify', () => { assert.equal(slugify('GitHub (MCP)!'), 'github_mcp'); });
  test('splitArgs respects quotes', () => { assert.deepEqual(splitArgs(`-y pkg "/My Docs" 'a b'`), ['-y', 'pkg', '/My Docs', 'a b']); });
  test('htmlToText strips scripts/styles and keeps structure', () => {
    const t = htmlToText('<html><head><title>T</title><style>.x{}</style></head><body><h1>Hello</h1><script>evil()</script><p>A &amp; B</p><ul><li>one</li></ul></body></html>');
    assert.match(t, /# Hello/); assert.match(t, /A & B/); assert.match(t, /• one/);
    assert.doesNotMatch(t, /evil|\.x\{/);
  });
  test('trimThread never starts on an orphaned tool_result', () => {
    const msgs = [];
    for (let i = 0; i < 30; i++) {
      msgs.push({ role: 'user', content: `q${i}` });
      msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'x', input: {} }] });
      msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'r' }] });
      msgs.push({ role: 'assistant', content: [{ type: 'text', text: 'a' }] });
    }
    const t = trimThread(msgs);
    assert.ok(t.length <= 40);
    assert.equal(typeof t[0].content, 'string');
  });
});

describe('markdown renderer (UI)', () => {
  test('escapes HTML: no script injection from model output', () => {
    const h = markdown('<img src=x onerror=alert(1)> **bold** [x](javascript:alert(1))');
    assert.doesNotMatch(h, /<img/);
    assert.doesNotMatch(h, /href="javascript/);
    assert.match(h, /<strong>bold<\/strong>/);
  });
  test('lists, code blocks and links', () => {
    const h = markdown('- a\n- b\n\n```js\nconst x = "<b>";\n```\nsee https://example.com');
    assert.match(h, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
    assert.match(h, /<pre><code>const x = &quot;&lt;b&gt;&quot;;<\/code><\/pre>/);
    assert.match(h, /<a href="https:\/\/example.com"/);
  });
});
