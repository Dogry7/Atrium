import { uuid, sleep } from '../util.js';
import { ERR, isTerminal, normalizeState, resultTask, resultText, makeMessage } from './protocol.js';

/** Client for a remote A2A agent. Tries v1.0 first and falls back to v0.3. */
export class A2AClient {
  constructor({ url, token, headers = {}, timeoutMs = 180000 }) {
    this.input = url;
    this.token = token;
    this.headers = headers;
    this.timeoutMs = timeoutMs;
    this.dialect = null; // learned on first successful call
  }

  async resolveCard() {
    const u = new URL(this.input);
    const candidates = [];
    if (/\.json$/i.test(u.pathname)) candidates.push(u.toString());
    const base = u.toString().replace(/\/+$/, '').replace(/\/\.well-known\/.*$/, '');
    candidates.push(`${base}/.well-known/agent-card.json`, `${base}/.well-known/agent.json`, `${u.origin}/.well-known/agent-card.json`, `${u.origin}/.well-known/agent.json`);
    let lastErr;
    for (const c of [...new Set(candidates)]) {
      try {
        const res = await fetch(c, { headers: this.#headers() });
        if (!res.ok) { lastErr = new Error(`HTTP ${res.status} at ${c}`); continue; }
        const card = await res.json();
        if (!card?.name) { lastErr = new Error(`No agent card at ${c}`); continue; }
        this.card = card;
        this.endpoint = endpointOf(card, base);
        return card;
      } catch (e) { lastErr = e; }
    }
    // No card: treat the URL itself as a JSON-RPC endpoint.
    this.card = { name: new URL(this.input).host, description: 'A2A agent (no card found)', skills: [] };
    this.endpoint = this.input;
    this.cardError = lastErr?.message;
    return this.card;
  }

  #headers(extra = {}) {
    const h = { accept: 'application/json', 'user-agent': 'Atrium-A2A/1.0', ...this.headers, ...extra };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  async rpc(method, params, { signal, version } = {}) {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.#headers({ 'content-type': 'application/json', ...(version ? { 'A2A-Version': version } : {}) }),
      body: JSON.stringify({ jsonrpc: '2.0', id: uuid(), method, params }),
      signal,
    });
    const text = await res.text();
    let j; try { j = JSON.parse(text); } catch { throw new Error(`A2A agent returned non-JSON (HTTP ${res.status}): ${text.slice(0, 160)}`); }
    if (j.error) throw Object.assign(new Error(j.error.message || 'A2A error'), { code: j.error.code });
    return j.result;
  }

  /** Send a text message; waits for a terminal state. Returns { text, task, dialect }. */
  async send(text, { contextId, signal, fromName } = {}) {
    const withMeta = (m) => (fromName ? { ...m, metadata: { agentName: fromName } } : m);
    if (!this.endpoint) await this.resolveCard();
    const tryV1 = async () => {
      const r = await this.rpc('SendMessage', { message: withMeta(makeMessage({ role: 'user', text, messageId: uuid(), contextId }, 'v1')), configuration: { acceptedOutputModes: ['text/plain'] } }, { signal, version: '1.0' });
      this.dialect = 'v1'; return r;
    };
    const tryV03 = async () => {
      const r = await this.rpc('message/send', { message: withMeta(makeMessage({ role: 'user', text, messageId: uuid(), contextId }, 'v0.3')), configuration: { acceptedOutputModes: ['text/plain'], blocking: true } }, { signal });
      this.dialect = 'v0.3'; return r;
    };
    let result;
    if (this.dialect === 'v0.3') result = await tryV03();
    else {
      try { result = await tryV1(); }
      catch (e) { if (e.code === ERR.METHOD_NOT_FOUND || e.code === ERR.INVALID_REQUEST) result = await tryV03(); else throw e; }
    }
    let task = resultTask(result);
    const started = Date.now();
    while (task && !isTerminal(task.status?.state) && normalizeState(task.status?.state) !== 'input-required') {
      if (Date.now() - started > this.timeoutMs) throw new Error('Remote A2A agent did not finish in time');
      await sleep(1000, signal);
      const r = await this.rpc(this.dialect === 'v1' ? 'GetTask' : 'tasks/get', { id: task.id }, { signal, version: this.dialect === 'v1' ? '1.0' : undefined });
      task = resultTask(r) || r;
    }
    const state = task ? normalizeState(task.status?.state) : 'completed';
    const out = resultText(task || result);
    if (state === 'failed' || state === 'rejected') throw new Error(`Remote agent ${state}: ${out || 'no details'}`);
    return { text: out || '(no text in reply)', task, dialect: this.dialect, state };
  }
}

function endpointOf(card, base) {
  const ifaces = card.supportedInterfaces || card.interfaces || card.additionalInterfaces || [];
  const jsonrpc = ifaces.find((i) => /json-?rpc/i.test(i.protocolBinding || i.transport || ''));
  return jsonrpc?.url || card.url || base;
}
