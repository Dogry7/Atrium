// A Node stand-in for `laya-serve` implementing the same /v1/systemone + /health wire protocol.
// Used when Python/laya aren't installed. Scores options by keyword overlap.
import { httpServer } from '../helpers.js';

export async function layaMock({ apiKey } = {}) {
  const calls = [];
  const s = await httpServer(async (req, res, body) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) return send(401, { detail: 'invalid or missing bearer token' });
    if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok', loaded: ['english'], device: 'cpu' });
    if (req.method !== 'POST' || req.url !== '/v1/systemone') return send(404, { detail: 'Not Found' });
    if (!body || typeof body !== 'object' || !('questions' in body)) return send(400, { detail: "request body must be an object with a 'questions' field" });
    if (!body.questions.probe) calls.push(body);
    const words = new Set(String(typeof body.state === 'string' ? body.state : JSON.stringify(body.state)).toLowerCase().match(/[a-z]+/g) || []);
    const answers = {};
    for (const [k, q] of Object.entries(body.questions)) {
      if (q.type === 'noul') { answers[k] = { type: 'noul', noul: 0.9, confidence: 0.9 }; continue; }
      if (q.type !== 'choice') return send(422, { detail: `question '${k}': unknown type '${q.type}'` });
      const stems = new Set([...words].map((w) => w.slice(0, 5)));
      const scores = Object.fromEntries(Object.entries(q.criteria).map(([label, desc]) => [label, 1 + 3 * (`${label} ${desc}`.toLowerCase().match(/[a-z]+/g) || []).filter((w) => stems.has(w.slice(0, 5))).length]));
      const total = Object.values(scores).reduce((a, b) => a + b, 0);
      const probabilities = Object.fromEntries(Object.entries(scores).map(([l, v]) => [l, +(v / total).toFixed(4)]));
      const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
      answers[k] = { type: 'choice', choice, probabilities, confidence: probabilities[choice] };
    }
    send(200, { model: 'laya-mock', answers, usage: { input_tokens: 0, output_tokens: 0 }, routing: { model: body.model || 'english', reason: 'mock' } });
  });
  return { ...s, calls };
}
