import { httpServer, sse } from '../helpers.js';

/**
 * These mock servers speak the real wire formats (Anthropic Messages streaming and
 * OpenAI Chat Completions streaming) so the adapters are exercised exactly as in production.
 */
export function anthropicMock() {
  const requests = [];
  let mode = 'normal';
  const srv = httpServer(async (req, res, body) => {
    requests.push({ url: req.url, headers: req.headers, body });
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }, { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }] }));
    }
    if (req.headers['x-api-key'] !== 'sk-ant-test') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); }
    if (mode === 'rate' && requests.filter((r) => r.url === '/v1/messages').length === 1) { res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'slow down' } })); }
    if (mode === 'overloaded') { res.writeHead(529, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { type: 'overloaded_error', message: 'Overloaded' } })); }
    const last = body.messages[body.messages.length - 1];
    const hasToolResult = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
    const ev = (type, data) => ({ event: type, data: { type, ...data } });
    if (body.tools?.some((t) => t.name === 'message_agent') && !hasToolResult && /ask atlas/i.test(JSON.stringify(last.content))) {
      // thinking + text + tool_use with input streamed in fragments
      return sse(res, [
        ev('message_start', { message: { id: 'msg_1', usage: { input_tokens: 120, output_tokens: 1 } } }),
        ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'I should ask Atlas.' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'SIG123' } }),
        ev('content_block_stop', { index: 0 }),
        ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
        ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Checking with ' } }),
        ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Atlas.' } }),
        ev('content_block_stop', { index: 1 }),
        ev('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'message_agent', input: {} } }),
        ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"agent": "At' } }),
        ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: 'las", "message": "What is MCP?"}' } }),
        ev('content_block_stop', { index: 2 }),
        ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } }),
        ev('message_stop', {}),
      ]);
    }
    const replyText = hasToolResult ? `Atlas told me: ${last.content[0].content}` : `Hello from mock Claude (model ${body.model})`;
    return sse(res, [
      ': keep-alive comment\n\n',
      ev('message_start', { message: { id: 'msg_2', usage: { input_tokens: 50, output_tokens: 1 } } }),
      ev('ping', {}),
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ...replyText.match(/.{1,7}/g).map((chunk) => ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: chunk } })),
      ev('content_block_stop', { index: 0 }),
      ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } }),
      ev('message_stop', {}),
    ]);
  });
  return { srv, requests, setMode: (m) => { mode = m; } };
}

export function openaiMock() {
  const requests = [];
  const srv = httpServer(async (req, res, body) => {
    requests.push({ url: req.url, headers: req.headers, body });
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'gpt-test' }, { id: 'a-model' }] })); }
    const last = body.messages[body.messages.length - 1];
    const chunk = (delta, finish = null) => ({ data: { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] } });
    if (last.role === 'user' && /use calculate/i.test(last.content)) {
      return sse(res, [
        chunk({ role: 'assistant', content: null }),
        chunk({ tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'toolkit__calculate', arguments: '' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"expre' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: 'ssion": "6*7"}' } }] }),
        chunk({}, 'tool_calls'),
        { data: { id: 'c1', choices: [], usage: { prompt_tokens: 80, completion_tokens: 20 } } },
        'data: [DONE]\n\n',
      ]);
    }
    const reply = last.role === 'tool' ? `The toolkit says ${last.content}` : `Hi from ${body.model}`;
    return sse(res, [chunk({ role: 'assistant', content: '' }), ...reply.match(/.{1,5}/g).map((c) => chunk({ content: c })), chunk({}, 'stop'), { data: { id: 'c1', choices: [], usage: { prompt_tokens: 30, completion_tokens: 9 } } }, 'data: [DONE]\n\n']);
  });
  return { srv, requests };
}

