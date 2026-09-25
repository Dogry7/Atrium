import { getProvider } from '../providers/index.js';
import { textOf } from '../providers/common.js';
import { id as newId, uuid, now, truncate, resultToText, abortError } from '../util.js';

export const MAX_A2A_DEPTH = 4;
const MAX_THREAD_MESSAGES = 40;

export const AVATAR_COLORS = ['#7C5CFF', '#22C3A6', '#FF7A59', '#3BA7FF', '#F5B83D', '#E858A8', '#6BCB5B', '#FF5D6C', '#8E8CF7', '#2EC4E6'];

/** The first colony plot index nobody holds (plots never move once assigned). */
export function nextPlot(agents) {
  const taken = new Set(agents.map((a) => a.plot).filter((n) => Number.isInteger(n)));
  let i = 0; while (taken.has(i)) i++;
  return i;
}

/** Give every agent without a plot the next free one (older data files, imports). */
export function assignPlots(store) {
  const agents = store.all('agents');
  let changed = false;
  const seen = new Set();
  for (const a of agents) {
    if (!Number.isInteger(a.plot) || a.plot < 0 || seen.has(a.plot)) { a.plot = null; }
    else seen.add(a.plot);
  }
  for (const a of agents) if (a.plot === null) { a.plot = nextPlot(agents); changed = true; }
  if (changed) store.save('agents');
  return changed;
}

export function agentDefaults(input = {}, existing = []) {
  const color = input.avatar?.color || AVATAR_COLORS[existing.length % AVATAR_COLORS.length];
  return {
    id: newId('agt'),
    name: 'New agent',
    role: 'Generalist',
    instructions: '',
    provider: 'simulated',
    model: '',
    temperature: null,
    maxTokens: 2048,
    maxSteps: 8,
    connectors: [],
    a2a: { enabled: true, allow: 'all' },
    memory: { enabled: true },
    ...input,
    avatar: { color, hair: 'short', accessory: 'none', ...(input.avatar || {}) },
    stats: { tasks: 0, tokensIn: 0, tokensOut: 0, lastActiveAt: null },
    plot: nextPlot(existing),
    createdAt: now(), updatedAt: now(),
  };
}

export class AgentRuntime {
  constructor({ store, bus, plugins, settings }) {
    this.store = store; this.bus = bus; this.plugins = plugins; this.settings = settings;
    this.active = new Map(); // taskId → { controller, agentId }
    this.busy = new Map(); // agentId → count
  }

  agents() { return this.store.all('agents'); }
  agent(idOrName) {
    if (!idOrName) return null;
    const s = String(idOrName).trim().toLowerCase();
    return this.agents().find((a) => a.id === idOrName) || this.agents().find((a) => a.name.toLowerCase() === s)
      || this.agents().find((a) => a.name.toLowerCase().startsWith(s));
  }

  canTalk(from, to) {
    if (!from.a2a?.enabled) return false;
    if (from.a2a.allow === 'all' || !from.a2a.allow) return true;
    return Array.isArray(from.a2a.allow) && from.a2a.allow.includes(to.id);
  }

  colleagues(agent) {
    if (!agent.a2a?.enabled) return [];
    return this.agents().filter((a) => a.id !== agent.id && this.canTalk(agent, a));
  }

  // ---------------------------------------------------------------- threads
  threadKey(agentId, contextId) { return `${agentId}::${contextId}`; }
  thread(agentId, contextId) {
    const key = this.threadKey(agentId, contextId);
    let t = this.store.get('threads', key);
    if (!t) { t = { id: key, agentId, contextId, messages: [], updatedAt: now() }; this.store.insert('threads', t); }
    return t;
  }
  clearThread(agentId, contextId) { return this.store.remove('threads', this.threadKey(agentId, contextId)); }

  // ---------------------------------------------------------------- tasks
  taskSummary(t) {
    return {
      id: t.id, contextId: t.contextId, agentId: t.agentId, agentName: t.agentName, from: t.from, parentTaskId: t.parentTaskId,
      status: t.status, input: truncate(t.input, 300), output: truncate(t.artifacts?.[0]?.text || '', 600),
      steps: t.steps?.length || 0, usage: t.usage, createdAt: t.createdAt, updatedAt: t.updatedAt, workflowRunId: t.workflowRunId,
    };
  }

  setTaskState(task, state, message) {
    task.status = { state, message: message || undefined, timestamp: now() };
    task.updatedAt = now();
    this.store.save('tasks');
    this.bus.emitEvent('task.updated', { task: this.taskSummary(task) });
  }

  setBusy(agentId, delta, detail) {
    const n = Math.max(0, (this.busy.get(agentId) || 0) + delta);
    this.busy.set(agentId, n);
    this.bus.emitEvent('agent.status', { agentId, state: n > 0 ? 'working' : 'idle', active: n, detail });
  }

  cancel(taskId) {
    const a = this.active.get(taskId);
    if (!a) return false;
    a.controller.abort();
    return true;
  }

  /**
   * Run one task on an agent. Resolves to the finished task.
   * from: { type: 'user'|'agent'|'workflow'|'external', id?, name? }
   */
  async run({ agentId, input, from = { type: 'user', name: 'You' }, contextId, chain = [], parentTaskId, signal, workflowRunId, taskId, extraSystem }) {
    const agent = this.agent(agentId);
    if (!agent) throw Object.assign(new Error(`No agent called "${agentId}"`), { status: 404 });
    const ctx = contextId || (from.type === 'agent' ? `a2a:${from.id}` : 'chat');
    const task = {
      id: taskId || uuid(), contextId: ctx, agentId: agent.id, agentName: agent.name, from, parentTaskId, workflowRunId,
      chain: [...chain, agent.id], input,
      status: { state: 'working', timestamp: now() },
      history: [{ role: 'user', text: input, messageId: uuid() }], artifacts: [], steps: [], usage: { input: 0, output: 0 },
      createdAt: now(), updatedAt: now(),
    };
    this.store.insert('tasks', task);
    this.bus.emitEvent('task.created', { task: this.taskSummary(task) });
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    this.active.set(task.id, { controller, agentId: agent.id });
    this.setBusy(agent.id, +1, from.type === 'agent' ? `talking with ${from.name}` : 'thinking');

    try {
      const reply = await this.#loop(agent, task, controller.signal, extraSystem);
      task.history.push({ role: 'agent', text: reply, messageId: uuid() });
      task.artifacts = [{ artifactId: uuid(), name: 'response', text: reply }];
      agent.stats = agent.stats || { tasks: 0, tokensIn: 0, tokensOut: 0 };
      agent.stats.tasks++; agent.stats.tokensIn += task.usage.input; agent.stats.tokensOut += task.usage.output;
      agent.stats.lastActiveAt = now();
      this.store.save('agents');
      this.setTaskState(task, 'completed');
      this.bus.emitEvent('agent.reply', { agentId: agent.id, agentName: agent.name, taskId: task.id, contextId: task.contextId, text: reply, from, stats: { tasks: agent.stats.tasks, lastActiveAt: agent.stats.lastActiveAt } });
      return task;
    } catch (e) {
      const canceled = e.name === 'AbortError' || controller.signal.aborted;
      this.setTaskState(task, canceled ? 'canceled' : 'failed', canceled ? 'Cancelled' : e.message);
      this.bus.emitEvent('agent.error', { agentId: agent.id, agentName: agent.name, taskId: task.id, error: canceled ? 'Cancelled' : e.message });
      return task;
    } finally {
      this.active.delete(task.id);
      signal?.removeEventListener('abort', onAbort);
      this.setBusy(agent.id, -1);
    }
  }

  /** Convenience: run and return the text (throws on failure). */
  async ask(opts) {
    const t = await this.run(opts);
    if (t.status.state !== 'completed') throw new Error(t.status.message || `Task ${t.status.state}`);
    return t.artifacts[0]?.text || '';
  }

  systemPrompt(agent, task, extraSystem) {
    const s = this.settings();
    const lines = [`You are ${agent.name}, ${agent.role || 'an AI agent'}. You work in Atrium, a shared workspace where AI agents collaborate with each other and with ${s.userName || 'the user'}.`];
    if (agent.instructions?.trim()) lines.push('', agent.instructions.trim());
    const mates = this.colleagues(agent);
    if (mates.length) {
      lines.push('', '## Colleagues you can message (tool: message_agent)');
      for (const m of mates) lines.push(`- ${m.name}: ${m.role || 'agent'}${m.instructions ? ` (${truncate(m.instructions.replace(/\s+/g, ' '), 90)})` : ''}`);
      lines.push('', 'Delegate when a colleague is better suited. You can message several colleagues in the same turn and they will work in parallel. Messages must be self-contained: colleagues cannot see your conversation. When a colleague asks you something, answer it directly instead of bouncing it back.');
    }
    if (agent.memory?.enabled) {
      const notes = this.store.all('memories').filter((m) => m.agentId === agent.id).slice(-20);
      if (notes.length) { lines.push('', '## Your memory (notes you saved earlier)'); for (const n of notes) lines.push(`- ${n.text}`); }
    }
    const f = task.from;
    lines.push('', `Current time: ${new Date().toString()}.`);
    lines.push(f.type === 'agent' ? `This message is from your colleague ${f.name}. Reply to them directly and concisely.`
      : f.type === 'workflow' ? `This request comes from the workflow "${f.name}". Produce exactly the output the step asks for, without preamble.`
      : f.type === 'external' ? `This message arrived over the A2A protocol from an external agent${f.name ? ` (${f.name})` : ''}.`
      : `You are talking with ${s.userName || 'the user'} directly.`);
    if (extraSystem) lines.push('', extraSystem);
    return lines.join('\n');
  }

  builtinTools(agent) {
    const tools = [];
    if (agent.a2a?.enabled && this.colleagues(agent).length) {
      tools.push({
        name: 'message_agent',
        description: 'Send a message to a colleague agent and wait for their reply. Use it to ask questions, delegate work, or get a review. Call it multiple times in one turn to work with several colleagues in parallel.',
        inputSchema: { type: 'object', properties: { agent: { type: 'string', description: 'Colleague name', enum: this.colleagues(agent).map((a) => a.name) }, message: { type: 'string', description: 'A complete, self-contained message' } }, required: ['agent', 'message'] },
      });
      tools.push({ name: 'list_agents', description: 'List colleague agents with their roles and what they are doing right now.', inputSchema: { type: 'object', properties: {} } });
    }
    if (agent.memory?.enabled) {
      tools.push({ name: 'remember', description: 'Save a short note to your long-term memory (facts, preferences, decisions) so you remember it in future conversations.', inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] } });
      tools.push({ name: 'recall', description: 'Search your long-term memory notes.', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Keywords; empty returns recent notes' } } } });
    }
    return tools;
  }

  async #loop(agent, task, signal, extraSystem) {
    const provider = getProvider(agent.provider);
    if (!provider) throw new Error(`Unknown provider "${agent.provider}"`);
    const settings = this.settings();
    const thread = this.thread(agent.id, task.contextId);
    const { tools: connectorTools, problems } = await this.plugins.toolsFor(agent.connectors || []);
    for (const p of problems) this.bus.emitEvent('agent.warning', { agentId: agent.id, taskId: task.id, message: `${p.name} unavailable: ${p.error}` });
    const tools = [...this.builtinTools(agent), ...connectorTools];
    const system = this.systemPrompt(agent, task, extraSystem);
    const working = trimThread(thread.messages);
    working.push({ role: 'user', content: task.input });
    const meta = { agent: { id: agent.id, name: agent.name, role: agent.role, instructions: agent.instructions }, roster: this.colleagues(agent).map((a) => ({ name: a.name, role: a.role })), from: task.from };
    const maxSteps = Math.max(1, Math.min(Number(agent.maxSteps) || 8, 30));
    let finalText = '';

    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) throw abortError();
      this.bus.emitEvent('agent.thinking', { agentId: agent.id, taskId: task.id, step });
      const res = await provider.chat({
        model: agent.model || provider.defaultModel, system, messages: working, tools,
        maxTokens: Number(agent.maxTokens) || 2048, temperature: agent.temperature ?? undefined,
        signal, settings, meta,
        onDelta: (text) => this.bus.emitEvent('agent.delta', { agentId: agent.id, taskId: task.id, text }),
      });
      if (signal.aborted) throw abortError(); // providers that ignore the signal still get stopped here
      task.usage.input += res.usage?.input || 0;
      task.usage.output += res.usage?.output || 0;
      working.push({ role: 'assistant', content: res.content });
      const uses = res.content.filter((b) => b.type === 'tool_use');
      const text = textOf(res.content);
      if (!uses.length) { finalText = text; break; }
      if (text.trim()) this.bus.emitEvent('agent.note', { agentId: agent.id, taskId: task.id, text });
      const results = await Promise.all(uses.map((u) => this.#execTool(agent, task, u, connectorTools, signal)));
      working.push({ role: 'user', content: results });
      if (step === maxSteps - 1) {
        // Out of steps: ask for a final answer without tools.
        const wrap = await provider.chat({ model: agent.model || provider.defaultModel, system, messages: [...working, { role: 'user', content: 'You have used all your tool steps. Give your best final answer now.' }], tools: [], maxTokens: Number(agent.maxTokens) || 2048, signal, settings, meta, onDelta: (t) => this.bus.emitEvent('agent.delta', { agentId: agent.id, taskId: task.id, text: t }) });
        finalText = textOf(wrap.content);
        working.push({ role: 'assistant', content: wrap.content });
      }
    }
    if (!finalText.trim()) finalText = '(no reply)';
    // Persist the conversation (without thinking blocks' bulk for other providers: keep as-is, they're needed for Claude).
    thread.messages = [...working];
    thread.updatedAt = now();
    this.store.save('threads');
    return finalText.trim();
  }

  async #execTool(agent, task, use, connectorTools, signal) {
    const started = Date.now();
    const conn = connectorTools.find((t) => t.name === use.name);
    this.bus.emitEvent('agent.tool', { agentId: agent.id, taskId: task.id, phase: 'start', tool: use.name, callId: use.id, input: use.input, connectorId: conn?.connectorId, connectorName: conn?.connectorName, pluginId: conn?.pluginId });
    let output, ok = true;
    try {
      if (use.name === 'message_agent') output = await this.#messageAgent(agent, task, use.input || {}, signal);
      else if (use.name === 'list_agents') output = this.colleagues(agent).map((a) => ({ name: a.name, role: a.role, status: (this.busy.get(a.id) || 0) > 0 ? 'busy' : 'available' }));
      else if (use.name === 'remember') output = this.#remember(agent, use.input?.note);
      else if (use.name === 'recall') output = this.#recall(agent, use.input?.query);
      else if (conn) output = await this.plugins.callTool(conn.connectorId, conn.rawName, use.input || {}, { signal, agentId: agent.id, agentName: agent.name, taskId: task.id });
      else throw new Error(`Tool "${use.name}" is not available to ${agent.name}`);
    } catch (e) {
      if (e.name === 'AbortError' || signal.aborted) throw e;
      ok = false; output = `Error: ${e.message}`;
    }
    const text = truncate(resultToText(output), 20000);
    task.steps.push({ type: 'tool', tool: use.name, input: use.input, ok, output: truncate(text, 2000), ms: Date.now() - started, connectorName: conn?.connectorName });
    this.bus.emitEvent('agent.tool', { agentId: agent.id, taskId: task.id, phase: 'end', tool: use.name, callId: use.id, ok, output: truncate(text, 600), ms: Date.now() - started, connectorId: conn?.connectorId, pluginId: conn?.pluginId });
    return { type: 'tool_result', tool_use_id: use.id, content: text, ...(ok ? {} : { is_error: true }) };
  }

  async #messageAgent(agent, task, { agent: targetName, message }, signal) {
    const target = this.agent(targetName);
    if (!target) throw new Error(`There is no colleague called "${targetName}". Colleagues: ${this.colleagues(agent).map((a) => a.name).join(', ') || 'none'}`);
    if (target.id === agent.id) throw new Error('You cannot message yourself.');
    if (!this.canTalk(agent, target)) throw new Error(`You are not allowed to message ${target.name}.`);
    if (!message || !String(message).trim()) throw new Error('message is empty');
    if (task.chain.includes(target.id)) throw new Error(`${target.name} is already waiting on this conversation (it's upstream of you). Don't message them; put your answer in your reply instead.`);
    if (task.chain.length >= MAX_A2A_DEPTH) throw new Error(`Delegation depth limit (${MAX_A2A_DEPTH}) reached. Answer with what you have.`);
    this.bus.emitEvent('a2a.message', { kind: 'request', fromId: agent.id, fromName: agent.name, toId: target.id, toName: target.name, text: truncate(message, 500), taskId: task.id });
    const child = await this.run({
      agentId: target.id, input: String(message), from: { type: 'agent', id: agent.id, name: agent.name },
      contextId: `a2a:${agent.id}`, chain: task.chain, parentTaskId: task.id, signal, workflowRunId: task.workflowRunId,
    });
    if (signal.aborted) throw abortError();
    if (child.status.state !== 'completed') throw new Error(`${target.name} couldn't complete it: ${child.status.message || child.status.state}`);
    const reply = child.artifacts[0]?.text || '';
    this.bus.emitEvent('a2a.message', { kind: 'reply', fromId: target.id, fromName: target.name, toId: agent.id, toName: agent.name, text: truncate(reply, 500), taskId: child.id });
    return reply;
  }

  #remember(agent, note) {
    if (!note?.trim()) throw new Error('note is empty');
    const m = { id: newId('mem'), agentId: agent.id, text: note.trim().slice(0, 1000), createdAt: now() };
    this.store.insert('memories', m);
    this.bus.emitEvent('agent.memory', { agentId: agent.id, memory: m });
    return 'Saved to memory.';
  }

  #recall(agent, query = '') {
    const notes = this.store.all('memories').filter((m) => m.agentId === agent.id);
    const q = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const hits = q.length ? notes.filter((n) => q.some((w) => n.text.toLowerCase().includes(w))) : notes.slice(-15);
    return hits.length ? hits.map((n) => `- ${n.text}`).join('\n') : 'No matching memories.';
  }

  /** One-shot completion with a given agent's brain (no tools, no thread). Used by Decide escalation. */
  async complete(agent, { system, prompt, meta = {}, signal, maxTokens = 400 }) {
    const provider = getProvider(agent.provider);
    const res = await provider.chat({ model: agent.model || provider.defaultModel, system, messages: [{ role: 'user', content: prompt }], tools: [], maxTokens, signal, settings: this.settings(), meta: { agent: { name: agent.name, role: agent.role }, ...meta } });
    return textOf(res.content).trim();
  }
}

/** Keep the most recent messages, starting at a clean user turn (never an orphaned tool_result). */
export function trimThread(messages) {
  let list = messages.slice(-MAX_THREAD_MESSAGES);
  while (list.length && !(list[0].role === 'user' && (typeof list[0].content === 'string' || !list[0].content.some?.((b) => b.type === 'tool_result')))) list = list.slice(1);
  return list.map((m) => ({ ...m }));
}
