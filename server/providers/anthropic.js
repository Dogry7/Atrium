import { parseSSE } from './sse.js';
import { fetchWithRetry, ProviderError } from './common.js';
import { safeJson } from '../util.js';

const DEFAULT_BASE = 'https://api.anthropic.com';

function creds(settings) {
  const cfg = settings?.providers?.anthropic || {};
  return {
    apiKey: cfg.apiKey || process.env.ANTHROPIC_API_KEY || '',
    baseUrl: (cfg.baseUrl || DEFAULT_BASE).replace(/\/+$/, ''),
  };
}

export default {
  id: 'anthropic',
  name: 'Anthropic (Claude)',
  defaultModel: 'claude-sonnet-5',
  suggestedModels: [
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 (balanced)' },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 (agentic work)' },
    { id: 'claude-fable-5-1', name: 'Claude Fable 5.1 (deepest reasoning)' },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5 (fastest)' },
  ],
  configFields: [
    { key: 'apiKey', label: 'API key', type: 'password', help: 'From console.anthropic.com. Or set ANTHROPIC_API_KEY.' },
    { key: 'baseUrl', label: 'Base URL', type: 'text', default: DEFAULT_BASE, help: 'Leave as default unless you use a proxy/gateway.' },
  ],

  isConfigured(settings) { return !!creds(settings).apiKey; },

  async listModels(settings) {
    const { apiKey, baseUrl } = creds(settings);
    if (!apiKey) return this.suggestedModels;
    const res = await fetchWithRetry('anthropic', `${baseUrl}/v1/models?limit=100`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    }, { retries: 0 });
    const j = await res.json();
    const list = (j.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id }));
    return list.length ? list : this.suggestedModels;
  },

  async chat({ model, system, messages, tools = [], maxTokens = 4096, temperature, signal, onDelta, settings }) {
    const { apiKey, baseUrl } = creds(settings);
    if (!apiKey) throw new ProviderError('No Anthropic API key yet. Add one in Settings → Providers (or pick the Simulated brain for this agent).', { provider: 'anthropic', status: 401 });
    const body = {
      model: model || this.defaultModel,
      max_tokens: maxTokens,
      system: system || undefined,
      messages: toAnthropicMessages(messages),
      stream: true,
    };
    if (tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description || '', input_schema: normalizeSchema(t.inputSchema) }));
    if (typeof temperature === 'number') body.temperature = temperature;

    const res = await fetchWithRetry('anthropic', `${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', accept: 'text/event-stream' },
      body: JSON.stringify(body),
    }, { signal });

    // Non-streaming fallback (some gateways ignore stream:true)
    if (!(res.headers.get('content-type') || '').includes('text/event-stream')) {
      const j = await res.json();
      const content = (j.content || []).map(cleanBlock);
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (text) onDelta?.(text);
      return { content, stopReason: j.stop_reason || 'end_turn', usage: { input: j.usage?.input_tokens || 0, output: j.usage?.output_tokens || 0 } };
    }

    const blocks = [];
    const partialJson = {};
    let stopReason = 'end_turn';
    const usage = { input: 0, output: 0 };
    for await (const evt of parseSSE(res.body, signal)) {
      const d = safeJson(evt.data);
      if (!d) continue;
      switch (d.type) {
        case 'message_start':
          usage.input = d.message?.usage?.input_tokens || 0;
          usage.output = d.message?.usage?.output_tokens || 0;
          break;
        case 'content_block_start': {
          const b = { ...d.content_block };
          if (b.type === 'tool_use') { b.input = {}; partialJson[d.index] = ''; }
          if (b.type === 'text') b.text = b.text || '';
          if (b.type === 'thinking') { b.thinking = b.thinking || ''; b.signature = b.signature || ''; }
          blocks[d.index] = b;
          break;
        }
        case 'content_block_delta': {
          const b = blocks[d.index];
          if (!b) break;
          const delta = d.delta || {};
          if (delta.type === 'text_delta') { b.text += delta.text; onDelta?.(delta.text); }
          else if (delta.type === 'input_json_delta') partialJson[d.index] += delta.partial_json || '';
          else if (delta.type === 'thinking_delta') b.thinking += delta.thinking || '';
          else if (delta.type === 'signature_delta') b.signature += delta.signature || '';
          break;
        }
        case 'content_block_stop': {
          const b = blocks[d.index];
          if (b?.type === 'tool_use') b.input = safeJson(partialJson[d.index] || '{}', {}) || {};
          break;
        }
        case 'message_delta':
          if (d.delta?.stop_reason) stopReason = d.delta.stop_reason;
          if (d.usage?.output_tokens != null) usage.output = d.usage.output_tokens;
          break;
        case 'error':
          throw new ProviderError(`Anthropic stream error: ${d.error?.message || 'unknown'}`, { provider: 'anthropic', status: d.error?.type === 'overloaded_error' ? 529 : 500, retryable: true });
        default: break;
      }
    }
    return { content: blocks.filter(Boolean).map(cleanBlock), stopReason, usage };
  },
};

function cleanBlock(b) {
  if (b.type === 'text') return { type: 'text', text: b.text || '' };
  if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} };
  return b; // thinking / redacted_thinking are preserved verbatim
}

function normalizeSchema(s) {
  if (!s || typeof s !== 'object') return { type: 'object', properties: {} };
  const out = { ...s };
  if (!out.type) out.type = 'object';
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

/** Internal messages already use Anthropic blocks; just drop empties and unknown fields. */
export function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    let content = m.content;
    if (Array.isArray(content)) {
      content = content.filter((b) => !(b.type === 'text' && !b.text));
      if (!content.length) continue;
    } else if (!content) continue;
    const last = out[out.length - 1];
    // Anthropic requires alternating roles: merge consecutive same-role messages.
    if (last && last.role === m.role) {
      const a = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }];
      const b = Array.isArray(content) ? content : [{ type: 'text', text: content }];
      last.content = [...a, ...b];
    } else out.push({ role: m.role, content });
  }
  return out;
}
