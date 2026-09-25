/**
 * Laya connector (convaiinnovations/laya): a fast, calibrated "System 1" decision model.
 * Talks to `laya-serve` over its /v1/systemone wire protocol.
 *   pip install "laya[serve]" && LAYA_PRELOAD=1 laya-serve   # → http://localhost:8000
 */
export default {
  id: 'laya',
  name: 'Laya decisions',
  description: 'Fast calibrated decisions (choice / score / yes-no) from Laya. Agents get a laya_decide tool; workflow Decide nodes use it and escalate to an LLM when unsure.',
  icon: 'bolt',
  category: 'decision',
  configFields: [
    { key: 'baseUrl', label: 'laya-serve URL', type: 'text', default: 'http://localhost:8000', help: 'Run: pip install "laya[serve]" && laya-serve' },
    { key: 'apiKey', label: 'API key', type: 'password', help: 'Only if you set LAYA_API_KEY on the server.' },
    { key: 'model', label: 'Checkpoint', type: 'select', default: 'auto', options: [
      { value: 'auto', label: 'Auto (router picks)' }, { value: 'english', label: 'English (ModernBERT-large)' },
      { value: 'multilingual', label: 'Multilingual (mmBERT)' }, { value: 'typed-decisions', label: 'Typed decisions' },
    ] },
    { key: 'threshold', label: 'Escalate below confidence', type: 'number', default: 0.7, help: 'Decisions under this confidence are flagged for escalation to an LLM.' },
    { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number', default: 30000 },
  ],

  async create(config) {
    const base = String(config.baseUrl || 'http://localhost:8000').replace(/\/+$/, '');
    const threshold = config.threshold === '' || config.threshold == null ? 0.7 : Number(config.threshold);
    const timeoutMs = Number(config.timeoutMs) || 30000;
    const headers = { 'content-type': 'application/json' };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

    async function call(path, init = {}, signal) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
      let res;
      try { res = await fetch(base + path, { ...init, headers, signal: ctrl.signal }); }
      catch (e) {
        throw new Error(ctrl.signal.aborted && !signal?.aborted ? `Laya timed out after ${timeoutMs / 1000}s` : `Can't reach laya-serve at ${base} (${e.cause?.code || e.message}). Start it with: laya-serve`);
      } finally { clearTimeout(t); }
      const text = await res.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      if (!res.ok) throw new Error(`Laya ${res.status}: ${body?.detail || text.slice(0, 200)}`);
      return body;
    }

    /** Raw predict: state + Laya question map → Laya response. */
    async function predict(state, questions, signal) {
      const body = { state, questions };
      if (config.model && config.model !== 'auto') body.model = config.model;
      return call('/v1/systemone', { method: 'POST', body: JSON.stringify(body) }, signal);
    }

    /** Friendly single-question decision used by the tool and the workflow Decide node. */
    async function decide({ text, question, type = 'choice', options, levels }, signal) {
      const q = { type, instructions: question || 'Decide.' };
      if (type === 'choice') {
        if (Array.isArray(options)) q.criteria = Object.fromEntries(options.map((o) => typeof o === 'string' ? [o, o] : [o.label, o.description || o.label]));
        else q.criteria = options || {};
        if (Object.keys(q.criteria).length < 2) throw new Error('A choice decision needs at least 2 options');
      } else if (type === 'score') {
        q.criteria = levels?.length ? levels : ['low', 'medium', 'high'];
      }
      const r = await predict(typeof text === 'string' ? text : JSON.stringify(text), { decision: q }, signal);
      const a = r?.answers?.decision;
      if (!a) throw new Error('Laya returned no answer');
      const answer = type === 'choice' ? a.choice : type === 'score' ? a.score : a.noul;
      const confidence = typeof a.confidence === 'number' ? a.confidence : null;
      return {
        answer, type, confidence,
        probabilities: a.probabilities,
        escalate: confidence != null && confidence < threshold,
        threshold,
        model: r.routing?.model || r.model || config.model || 'auto',
      };
    }

    return {
      predict, decide, threshold,
      async listTools() {
        return [{
          name: 'laya_decide',
          description: 'Make a fast, calibrated decision about a piece of text using Laya (System 1). Returns the answer plus a confidence 0-1. Use for routing, triage, classification, urgency scoring or yes/no checks. If "escalate" is true, think harder yourself.',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The content to decide about (email, ticket, message, JSON…)' },
              question: { type: 'string', description: 'The decision question, e.g. "Which team should handle this?"' },
              type: { type: 'string', enum: ['choice', 'score', 'noul'], description: 'choice = pick one option; score = ordinal level; noul = yes/no probability' },
              options: { type: 'object', additionalProperties: { type: 'string' }, description: 'For choice: {"label": "what it means", ...}' },
              levels: { type: 'array', items: { type: 'string' }, description: 'For score: ordered levels, low → high' },
            },
            required: ['text', 'question', 'type'],
          },
        }];
      },
      async callTool(name, args, { signal } = {}) {
        if (name !== 'laya_decide') throw new Error(`Unknown tool ${name}`);
        return decide(args, signal);
      },
      async test() {
        const h = await call('/health');
        // /health is public on laya-serve, so also run a tiny decision to check auth + model.
        const t0 = Date.now();
        await predict('Connection test from Atrium.', { probe: { type: 'noul', instructions: 'Is this a connection test?' } });
        return { ok: true, message: `laya-serve is up · device ${h.device || 'auto'} · loaded: ${(h.loaded || []).join(', ') || 'lazy'} · test decision in ${Date.now() - t0}ms` };
      },
      async close() {},
    };
  },
};
