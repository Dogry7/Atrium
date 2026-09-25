import { parseSSE } from './sse.js';
import { fetchWithRetry, ProviderError } from './common.js';
import { safeJson } from '../util.js';

const DEFAULT_BASE = 'https://api.openai.com/v1';

function creds(settings) {
  const cfg = settings?.providers?.openai || {};
  return {
    apiKey: cfg.apiKey || process.env.OPENAI_API_KEY || '',
    baseUrl: (cfg.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_BASE).replace(/\/+$/, ''),
  };
}

export default {
  id: 'openai',
  name: 'OpenAI-compatible',
  defaultModel: '',
  suggestedModels: [],
  configFields: [
    { key: 'apiKey', label: 'API key', type: 'password', help: 'OpenAI, OpenRouter, Groq, Together… Leave blank for Ollama / LM Studio.' },
    { key: 'baseUrl', label: 'Base URL', type: 'text', default: DEFAULT_BASE, help: 'e.g. https://openrouter.ai/api/v1 · http://localhost:11434/v1 (Ollama) · http://localhost:1234/v1 (LM Studio)' },
  ],

  isConfigured(settings) { const c = creds(settings); return !!c.apiKey || c.baseUrl !== DEFAULT_BASE; },

  async listModels(settings) {
    const { apiKey, baseUrl } = creds(settings);
    if (!apiKey && baseUrl === DEFAULT_BASE) return [];
    const res = await fetchWithRetry('openai', `${baseUrl}/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} }, { retries: 0 });
    const j = await res.json();
    return (j.data || []).map((m) => ({ id: m.id, name: m.id })).sort((a, b) => a.id.localeCompare(b.id));
  },

  async chat({ model, system, messages, tools = [], maxTokens = 4096, temperature, signal, onDelta, settings }) {
    const { apiKey, baseUrl } = creds(settings);
    if (!apiKey && baseUrl === DEFAULT_BASE) throw new ProviderError('No OpenAI API key yet. Add one in Settings → Providers, or point the base URL at a local server (Ollama/LM Studio).', { provider: 'openai', status: 401 });
    if (!model) throw new ProviderError('This agent has no model selected for the OpenAI-compatible provider. Pick one in the agent editor.', { provider: 'openai', status: 400 });
    const body = {
      model,
      messages: toOpenAIMessages(system, messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    // api.openai.com's newer models require max_completion_tokens; most compatible servers use max_tokens.
    if (baseUrl.includes('api.openai.com')) body.max_completion_tokens = maxTokens; else body.max_tokens = maxTokens;
    if (typeof temperature === 'number') body.temperature = temperature;
    if (tools.length) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} } } }));

    const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const res = await fetchWithRetry('openai', `${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, { signal });

    let text = '';
    const calls = [];
    let finish = 'stop';
    const usage = { input: 0, output: 0 };

    if (!(res.headers.get('content-type') || '').includes('text/event-stream')) {
      const j = await res.json();
      const msg = j.choices?.[0]?.message || {};
      text = msg.content || '';
      if (text) onDelta?.(text);
      for (const tc of msg.tool_calls || []) calls.push({ id: tc.id, name: tc.function?.name, args: tc.function?.arguments || '' });
      finish = j.choices?.[0]?.finish_reason || 'stop';
      usage.input = j.usage?.prompt_tokens || 0; usage.output = j.usage?.completion_tokens || 0;
    } else {
      for await (const evt of parseSSE(res.body, signal)) {
        if (evt.data === '[DONE]') break;
        const d = safeJson(evt.data);
        if (!d) continue;
        if (d.error) throw new ProviderError(`OpenAI-compatible stream error: ${d.error.message || JSON.stringify(d.error)}`, { provider: 'openai' });
        if (d.usage) { usage.input = d.usage.prompt_tokens || 0; usage.output = d.usage.completion_tokens || 0; }
        const ch = d.choices?.[0];
        if (!ch) continue;
        const delta = ch.delta || {};
        if (delta.content) { text += delta.content; onDelta?.(delta.content); }
        for (const tc of delta.tool_calls || []) {
          const i = tc.index ?? calls.length;
          calls[i] ||= { id: '', name: '', args: '' };
          if (tc.id) calls[i].id = tc.id;
          if (tc.function?.name) calls[i].name += tc.function.name;
          if (tc.function?.arguments) calls[i].args += tc.function.arguments;
        }
        if (ch.finish_reason) finish = ch.finish_reason;
      }
    }

    const content = [];
    if (text) content.push({ type: 'text', text });
    calls.filter(Boolean).forEach((c, i) => {
      content.push({ type: 'tool_use', id: c.id || `call_${Date.now()}_${i}`, name: c.name, input: safeJson(c.args || '{}', {}) || {} });
    });
    const hasTools = content.some((b) => b.type === 'tool_use');
    const stopReason = hasTools ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn';
    return { content, stopReason, usage };
  },
};

/** Internal (Anthropic-style) messages → OpenAI chat messages. */
export function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    const blocks = m.content || [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const toolCalls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      }));
      const msg = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    } else {
      for (const b of blocks.filter((b) => b.type === 'tool_result')) {
        const c = typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x.text || '').join('');
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? 'ERROR: ' : '') + c });
      }
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}
