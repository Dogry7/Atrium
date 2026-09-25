import { sleep, truncate } from '../util.js';

// ATRIUM_SIM_FAST=1 removes the artificial "thinking" delays (used by the test-suite).
const fast = () => process.env.ATRIUM_SIM_FAST === '1';

/**
 * Offline "brain". Deterministic, no network. It is not an LLM, but it follows the same
 * provider contract (streams text, emits tool_use blocks) so the whole system works end to
 * end before any API key exists: delegation, tools, workflows, the world animation.
 */
export default {
  id: 'simulated',
  name: 'Simulated brain (offline)',
  defaultModel: 'sim-1',
  suggestedModels: [{ id: 'sim-1', name: 'Simulated (offline, deterministic)' }],
  configFields: [],
  isConfigured() { return true; },
  async listModels() { return this.suggestedModels; },

  async chat({ messages, tools = [], signal, onDelta, meta = {} }) {
    // A little "thinking" time so the colony is watchable: long enough for a robot to reach its workbench.
    if (!fast()) await sleep(meta.decide ? 250 : 1300 + Math.random() * 700, signal);
    const last = messages[messages.length - 1];
    const blocks = Array.isArray(last?.content) ? last.content : [{ type: 'text', text: last?.content || '' }];
    const toolResults = blocks.filter((b) => b.type === 'tool_result');
    const me = meta.agent || { name: 'Agent', role: 'assistant' };

    // Decision mode (used by workflow Decide nodes escalating to an LLM)
    if (meta.decide) {
      const text = meta.decide.text ?? blocks.map((b) => b.text || '').join(' ');
      const pick = bestOption(text, meta.decide.options);
      return stream(pick.label, onDelta, signal);
    }

    // 1) We have tool results → summarise and finish.
    if (toolResults.length) {
      const prev = messages[messages.length - 2];
      const uses = Array.isArray(prev?.content) ? prev.content.filter((b) => b.type === 'tool_use') : [];
      const parts = toolResults.map((r) => {
        const use = uses.find((u) => u.id === r.tool_use_id);
        const content = (typeof r.content === 'string' ? r.content : (r.content || []).map((c) => c.text || '').join('')).replace(/\n*_Simulated brain[^_]*_\s*$/, '');
        if (use?.name === 'message_agent') {
          return r.is_error ? `I tried to reach ${use.input.agent} but: ${truncate(content, 200)}` : `**${use.input.agent}** says: ${truncate(content, 700)}`;
        }
        const nice = (use?.name || 'tool').split('__').pop();
        return r.is_error ? `The \`${nice}\` tool failed: ${truncate(content, 300)}` : `Result from \`${nice}\`:\n${truncate(content, 900)}`;
      });
      const intro = uses.some((u) => u.name === 'message_agent') ? `I checked with the team.` : `Done.`;
      return stream(`${intro}\n\n${parts.join('\n\n')}\n\n_Simulated brain · add a Claude or OpenAI key in Settings for real answers._`, onDelta, signal);
    }

    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const lower = text.toLowerCase();
    const has = (n) => tools.find((t) => t.name === n);
    const calls = [];

    // 2) Delegation: a colleague is named → message them (in parallel if several).
    //    Only when talking to a human/workflow, so delegated work doesn't ricochet around the colony.
    if (has('message_agent') && meta.roster?.length && meta.from?.type !== 'agent') {
      const named = meta.roster.filter((a) => a.name.toLowerCase() !== me.name.toLowerCase() && new RegExp(`\\b${escapeRe(a.name.toLowerCase())}\\b`).test(lower));
      const ask = cleanAsk(text, meta.roster.map((r) => r.name));
      for (const a of named) calls.push({ name: 'message_agent', input: { agent: a.name, message: ask || text } });
    }
    // 3) URL → fetch it
    const url = text.match(/https?:\/\/[^\s)'"<>]+/)?.[0];
    const fetchTool = tools.find((t) => /(^|__)web_fetch$/.test(t.name));
    if (!calls.length && url && fetchTool) calls.push({ name: fetchTool.name, input: { url } });
    // 4) Memory
    if (!calls.length && has('remember') && /\bremember\b/.test(lower) && !/what do you remember/.test(lower)) {
      calls.push({ name: 'remember', input: { note: text.replace(/^.*?\bremember( that)?\b[:,]?\s*/i, '') || text } });
    }
    if (!calls.length && has('recall') && /(what do you remember|recall)/.test(lower)) calls.push({ name: 'recall', input: { query: '' } });
    // 5) Explicit tool usage: "use/call/run <tool>"
    if (!calls.length && /\b(use|call|run|invoke)\b/.test(lower)) {
      const t = tools.find((t) => {
        const short = t.name.split('__').pop().toLowerCase();
        return short.length > 2 && new RegExp(`\\b${escapeRe(short)}\\b`).test(lower) && t.name !== 'message_agent';
      });
      if (t) calls.push({ name: t.name, input: inferArgs(t, text) });
    }

    if (calls.length) {
      const content = [{ type: 'text', text: calls.length > 1 ? `Let me loop in ${calls.map((c) => c.input.agent || c.name).join(' and ')}.` : calls[0].name === 'message_agent' ? `Let me ask ${calls[0].input.agent}.` : `On it, using ${calls[0].name.split('__').pop()}.` }];
      onDelta?.(content[0].text);
      if (!fast()) await sleep(120, signal);
      calls.forEach((c, i) => content.push({ type: 'tool_use', id: `sim_${Date.now().toString(36)}_${i}`, name: c.name, input: c.input }));
      return { content, stopReason: 'tool_use', usage: { input: 0, output: 0 } };
    }

    return stream(compose(me, text, meta), onDelta, signal);
  },
};

async function stream(full, onDelta, signal) {
  const words = full.split(/(\s+)/);
  let chunk = '';
  for (let i = 0; i < words.length; i++) {
    chunk += words[i];
    if (chunk.length > 14 || i === words.length - 1) { onDelta?.(chunk); chunk = ''; if (!fast()) await sleep(28, signal); }
  }
  return { content: [{ type: 'text', text: full }], stopReason: 'end_turn', usage: { input: 0, output: 0 } };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function cleanAsk(text, names) {
  const nameRe = names.map(escapeRe).join('|');
  let t = text
    .replace(new RegExp(`\\b(?:please\\s+)?(?:ask|tell|check with|get|have|let|@)\\s*(?:(?:${nameRe})(?:\\s*,\\s*|\\s+and\\s+|\\s*&\\s*)?)+\\s*(?:to|for|about|if|whether)?\\s*`, 'ig'), '')
    .replace(new RegExp(`\\b(?:${nameRe})\\b[,:]?\\s*`, 'ig'), '');
  t = t.replace(/\bthey think\b/gi, 'you think').replace(/\bthey\b/gi, 'you').replace(/\btheir\b/gi, 'your').replace(/\bthem\b/gi, 'you');
  t = t.replace(/^[\s,:;-]+/, '').trim();
  if (/^what you think/i.test(t)) t = t.replace(/^what you think/i, 'What do you think');
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/** "Can you write a short post about launching a newsletter?" → "launching a newsletter" */
export function subjectOf(text) {
  const src = String(text || '').replace(/[*_`#>]+/g, '');
  const quoted = src.match(/["“]([^"”\n]{3,120})["”]/);
  if (quoted) return truncate(quoted[1].trim().replace(/[?!.]+$/, ''), 120);
  // "Instruction:\n\ncontent" → the content is the subject
  const colon = src.match(/^[^\n]*:\s*\n+\s*([\s\S]+)/);
  let t = (colon ? colon[1] : src).replace(/\s+/g, ' ').trim().replace(/[?!.]+$/, '');
  t = t.split(/(?<=[.!?])\s/)[0].replace(/[?!.]+$/, '');
  t = t.replace(/^(hey|hi|ok|okay|so|please)[,!\s]+/i, '')
    .replace(/^(can|could|would|will) you\s+/i, '')
    .replace(/^(please\s+)?(write|draft|create|make|give me|prepare|research|review|check|analy[sz]e|summari[sz]e|explain|describe|plan|find|look into|investigate|tell me)\s+(me\s+)?/i, '')
    .replace(/^(a|an|the|some)\s+((short|quick|brief|long|detailed|\d+[- ]word)\s+)*(post|note|summary|draft|briefing|plan|report|review|email|reply|overview|list|article|paragraph)?\s*(on|about|for|of|regarding)?\s*/i, '')
    .replace(/^what do you think (about|of)\s+/i, '')
    .replace(/^(what|how|why) (is|are|do|does|should|would|can)\s+/i, '');
  return truncate(t.trim() || text.trim(), 120);
}

function inferArgs(tool, text) {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (json) { try { return JSON.parse(json); } catch {} }
  const props = tool.inputSchema?.properties || {};
  const req = tool.inputSchema?.required || Object.keys(props);
  const args = {};
  const payload = text.replace(/^.*?\b(use|call|run|invoke)\b\s+\S+\s*(tool)?\s*(with|on|for|to)?\s*/i, '').trim() || text;
  for (const k of req) {
    const p = props[k] || {};
    if (p.type === 'number' || p.type === 'integer') args[k] = Number(payload.match(/-?\d+(\.\d+)?/)?.[0] ?? 1);
    else if (p.type === 'boolean') args[k] = true;
    else if (p.enum) args[k] = p.enum[0];
    else args[k] = payload;
  }
  return args;
}

function topicOf(text) {
  const first = text.split(/(?<=[.!?])\s|\n/)[0] || text;
  return truncate(first.replace(/\s+/g, ' ').trim(), 140);
}

function compose(me, text, meta) {
  const role = `${me.role || ''} ${me.instructions || ''}`.toLowerCase();
  if (!text) return `Hi, I'm ${me.name}. What can I do for you?`;
  if (/^(hi|hello|hey|yo|g'day|good (morning|afternoon|evening))\b/i.test(text.trim()) && text.length < 60) {
    const mates = (meta.roster || []).filter((r) => r.name !== me.name).map((r) => r.name).slice(0, 4);
    return `Hey! I'm ${me.name}, ${me.role || 'an agent'} here in the Atrium.${mates.length ? ` I work alongside ${mates.join(', ')}.` : ''} What should we work on?`;
  }
  const subject = subjectOf(text);
  const S = capital(subject);
  const note = '\n\n_Simulated brain · add a Claude or OpenAI key in Settings for real answers._';
  const fromAgent = meta.from?.type === 'agent' ? `${meta.from.name}, ` : '';
  if (/research|analy|investigat|scout/.test(role)) {
    return `${fromAgent ? capital(fromAgent) : ''}here are my research notes on **${subject}**:\n\n• **What it is:** the core idea and who it affects.\n• **Why it matters:** the main upside, and the evidence I'd want to see for it.\n• **Risks:** cost, effort, and what could make it fail.\n• **Next check:** find two real examples and compare their results.${note}`;
  }
  if (/writ|copy|author|draft|editor|content/.test(role)) {
    return `${fromAgent ? capital(fromAgent) : ''}here's a first draft on **${subject}**:\n\n> ${S} works best when it earns attention instead of asking for it. Lead with one clear promise, keep every piece short and useful, and end with a single next step for the reader.\n\nWant it longer, punchier, or in a different format?${note}`;
  }
  if (/review|critic|qa|quality|audit|sentinel|check/.test(role)) {
    const score = 6 + (text.length % 4);
    return `Review of **${truncate(subject, 70)}**:\n\n✅ Clear intent and structure\n⚠️ Needs one concrete example or number\n⚠️ Double-check facts and tone before it ships\n\n**Verdict: ${score >= 8 ? 'APPROVE' : 'REVISE'}** (${score}/10)${note}`;
  }
  if (/coordinat|manag|lead|plan|orchestr|director/.test(role)) {
    const team = (meta.roster || []).filter((r) => r.name !== me.name).slice(0, 3);
    const jobs = ['gather the facts', 'turn it into a draft', 'review it and sign off'];
    const steps = team.length ? team.map((r, i) => `${i + 1}. **${r.name}** (${r.role}) will ${jobs[i] || 'support'}`).join('\n') : '1. Clarify the goal\n2. Do the work\n3. Review';
    return `Here's how I'd tackle **${subject}**:\n\n${steps}\n\nTip: say "ask ${team[0]?.name || 'a colleague'} to …" and I'll delegate it for real.${note}`;
  }
  return `On **${subject}**: I'd start with the simplest version that could work, check it with a real example, then iterate.${note}`;
}

const STOP = new Set('the a an and or but to of in on for with about from into this that these those is are was were be been it its our your my we you they i me can could would should please make give write tell ask what how why when where who which some any more most very just also then than so if do does did have has had get let us draft short'.split(' '));
function keywords(text) {
  const seen = new Set();
  return (text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []).filter((w) => !STOP.has(w) && !seen.has(w) && seen.add(w));
}
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function bestOption(text, options) {
  const words = new Set(keywords(text));
  let best = options[0], bestScore = -1;
  for (const o of options) {
    const kws = keywords(`${o.label} ${o.description || ''}`);
    const score = kws.reduce((s, w) => s + (words.has(w) ? 1 : [...words].some((x) => x.startsWith(w.slice(0, 5)) && w.length > 4) ? 0.5 : 0), 0);
    if (score > bestScore) { best = o; bestScore = score; }
  }
  return best;
}
