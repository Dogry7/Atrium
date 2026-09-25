import { render, renderDeep, lookup } from './template.js';
import { uuid, now, truncate, resultToText, abortError } from '../util.js';

export const NODE_TYPES = {
  trigger: { label: 'Start', ports: ['out'] },
  agent: { label: 'Agent', ports: ['out'] },
  decide: { label: 'Decide', ports: 'options' },
  condition: { label: 'Condition', ports: ['true', 'false'] },
  tool: { label: 'Tool', ports: ['out'] },
  transform: { label: 'Transform', ports: ['out'] },
  output: { label: 'Output', ports: [] },
};

export function portsOf(node) {
  if (node.type === 'decide') return (node.data?.options || []).map((o) => o.label).filter(Boolean);
  return NODE_TYPES[node.type]?.ports || ['out'];
}

/** Static checks shown in the editor and enforced before running. */
export function validateWorkflow(wf, { agents = [], connectors = [] } = {}) {
  const errors = [];
  const nodes = wf.nodes || [];
  const ids = new Set(nodes.map((n) => n.id));
  if (!nodes.length) errors.push({ message: 'The workflow has no steps yet.' });
  if (!nodes.some((n) => n.type === 'trigger')) errors.push({ message: 'Add a Start node.' });
  for (const e of wf.edges || []) {
    if (!ids.has(e.from) || !ids.has(e.to)) errors.push({ message: 'A connection points to a missing step.', edgeId: e.id });
  }
  for (const n of nodes) {
    const d = n.data || {};
    const label = d.label || NODE_TYPES[n.type]?.label || n.type;
    if (!NODE_TYPES[n.type]) errors.push({ nodeId: n.id, message: `Unknown step type "${n.type}"` });
    if (n.type === 'agent' && !agents.some((a) => a.id === d.agentId)) errors.push({ nodeId: n.id, message: `"${label}": choose an agent.` });
    if (n.type === 'decide') {
      if ((d.options || []).filter((o) => o.label?.trim()).length < 2) errors.push({ nodeId: n.id, message: `"${label}": needs at least 2 options.` });
      if (d.engine === 'laya' && !connectors.some((c) => c.pluginId === 'laya')) errors.push({ nodeId: n.id, message: `"${label}": add a Laya connector first (or use Auto/LLM).` });
    }
    if (n.type === 'tool' && (!d.connectorId || !d.tool)) errors.push({ nodeId: n.id, message: `"${label}": choose a connector and tool.` });
    if (n.type !== 'trigger' && !(wf.edges || []).some((e) => e.to === n.id)) errors.push({ nodeId: n.id, message: `"${label}" isn't connected to anything before it.`, warning: true });
  }
  // cycle check
  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const e of wf.edges || []) adj.get(e.from)?.push(e.to);
  const color = new Map();
  const visit = (u) => { color.set(u, 1); for (const v of adj.get(u) || []) { if (color.get(v) === 1) return true; if (!color.get(v) && visit(v)) return true; } color.set(u, 2); return false; };
  for (const n of nodes) if (!color.get(n.id) && visit(n.id)) { errors.push({ message: 'The workflow has a loop. Steps must flow in one direction.' }); break; }
  return errors;
}

export class WorkflowEngine {
  constructor({ store, bus, runtime, plugins }) {
    this.store = store; this.bus = bus; this.runtime = runtime; this.plugins = plugins;
    this.active = new Map();
  }

  runSummary(r) {
    return { id: r.id, workflowId: r.workflowId, workflowName: r.workflowName, status: r.status, trigger: r.trigger, input: truncate(r.input, 300), output: typeof r.output === 'string' ? truncate(r.output, 800) : r.output, error: r.error, startedAt: r.startedAt, finishedAt: r.finishedAt, nodes: r.nodes };
  }

  cancel(runId) {
    const a = this.active.get(runId);
    if (!a) return false;
    a.abort(); return true;
  }

  /** Start a run. Returns { run, done } where done resolves when finished. */
  start(workflowId, { input = '', trigger = 'manual' } = {}) {
    const wf = this.store.get('workflows', workflowId);
    if (!wf) throw Object.assign(new Error('Workflow not found'), { status: 404 });
    const problems = validateWorkflow(wf, { agents: this.store.all('agents'), connectors: this.store.all('connectors') }).filter((e) => !e.warning);
    if (problems.length) throw Object.assign(new Error(problems.map((p) => p.message).join(' ')), { status: 400, details: problems });
    const run = {
      id: uuid(), workflowId: wf.id, workflowName: wf.name, status: 'running', trigger,
      input: typeof input === 'string' ? input : JSON.stringify(input), inputRaw: input, output: null, error: null,
      nodes: Object.fromEntries(wf.nodes.map((n) => [n.id, { status: 'pending' }])),
      startedAt: now(), finishedAt: null,
    };
    this.store.insert('runs', run);
    wf.lastRunAt = run.startedAt; this.store.save('workflows');
    this.bus.emitEvent('run.started', { run: this.runSummary(run) });
    const ctrl = new AbortController();
    this.active.set(run.id, ctrl);
    const done = this.#execute(wf, run, ctrl.signal).finally(() => this.active.delete(run.id));
    return { run, done };
  }

  async runAndWait(workflowId, opts) {
    const { done } = this.start(workflowId, opts);
    return done;
  }

  #nodeUpdate(run, nodeId, patch) {
    Object.assign(run.nodes[nodeId], patch);
    this.store.save('runs');
    this.bus.emitEvent('run.node', { runId: run.id, workflowId: run.workflowId, nodeId, ...patch, output: patch.output !== undefined ? truncate(resultToText(patch.output), 800) : undefined });
  }

  async #execute(wf, run, signal) {
    const nodes = new Map(wf.nodes.map((n) => [n.id, n]));
    const edges = wf.edges || [];
    const edgeState = new Map(edges.map((e) => [e.id, 'pending']));
    const outputs = {};
    const scope = { input: run.inputRaw, run: { id: run.id }, nodes: outputs, now: now() };
    const running = new Set();
    let failure = null;

    const inbound = (id) => edges.filter((e) => e.to === id);
    const outbound = (id) => edges.filter((e) => e.from === id);

    const settle = (nodeId, firedPorts) => {
      for (const e of outbound(nodeId)) edgeState.set(e.id, firedPorts.has(e.fromPort || 'out') ? 'fired' : 'skipped');
    };

    const ready = () => {
      const list = [];
      for (const n of wf.nodes) {
        if (run.nodes[n.id].status !== 'pending') continue;
        const inE = inbound(n.id);
        if (!inE.length) { if (n.type === 'trigger') list.push({ n, go: true }); else list.push({ n, go: false }); continue; }
        if (inE.some((e) => edgeState.get(e.id) === 'pending')) continue;
        list.push({ n, go: inE.some((e) => edgeState.get(e.id) === 'fired') });
      }
      return list;
    };

    await new Promise((resolve) => {
      const pump = () => {
        if (failure || signal.aborted) { if (!running.size) resolve(); return; }
        let progressed = true;
        while (progressed) {
          progressed = false;
          for (const { n, go } of ready()) {
            progressed = true;
            if (!go) {
              run.nodes[n.id].status = 'skipped';
              this.#nodeUpdate(run, n.id, { status: 'skipped' });
              settle(n.id, new Set());
              continue;
            }
            running.add(n.id);
            const last = inbound(n.id).filter((e) => edgeState.get(e.id) === 'fired').map((e) => outputs[e.from]?.output).filter((x) => x != null);
            const lastVal = last.length <= 1 ? last[0] ?? scope.input : last.map((x) => resultToText(x)).join('\n\n---\n\n');
            const started = Date.now();
            this.#nodeUpdate(run, n.id, { status: 'running', startedAt: now() });
            this.#runNode(wf, run, n, { ...scope, last: lastVal }, signal)
              .then(({ output, ports, detail, taskId }) => {
                outputs[n.id] = { output, ...(detail || {}) };
                this.#nodeUpdate(run, n.id, { status: 'done', output, detail, taskId, ms: Date.now() - started, finishedAt: now() });
                settle(n.id, new Set(ports));
              })
              .catch((e) => {
                const canceled = e.name === 'AbortError' || signal.aborted;
                this.#nodeUpdate(run, n.id, { status: canceled ? 'canceled' : 'failed', error: canceled ? 'Cancelled' : e.message, ms: Date.now() - started, finishedAt: now() });
                if (!failure) failure = canceled ? abortError() : Object.assign(new Error(`${n.data?.label || NODE_TYPES[n.type]?.label}: ${e.message}`), { nodeId: n.id });
              })
              .finally(() => { running.delete(n.id); pump(); });
          }
        }
        if (!running.size) resolve();
      };
      pump();
    });

    // Anything left pending was unreachable
    for (const n of wf.nodes) if (run.nodes[n.id].status === 'pending') { run.nodes[n.id].status = 'skipped'; }
    if (failure || signal.aborted) {
      const canceled = signal.aborted || failure?.name === 'AbortError';
      run.status = canceled ? 'canceled' : 'failed';
      run.error = canceled ? 'Cancelled' : failure.message;
    } else {
      run.status = 'completed';
      const outs = wf.nodes.filter((n) => n.type === 'output' && run.nodes[n.id].status === 'done');
      if (outs.length === 1) run.output = outputs[outs[0].id].output;
      else if (outs.length > 1) run.output = Object.fromEntries(outs.map((n) => [n.data?.label || n.id, outputs[n.id].output]));
      else {
        const done = wf.nodes.filter((n) => run.nodes[n.id].status === 'done').sort((a, b) => (run.nodes[b.id].finishedAt || '').localeCompare(run.nodes[a.id].finishedAt || ''));
        run.output = done[0] ? outputs[done[0].id].output : null;
      }
    }
    run.finishedAt = now();
    this.store.save('runs');
    this.bus.emitEvent('run.finished', { run: this.runSummary(run) });
    return run;
  }

  async #runNode(wf, run, node, scope, signal) {
    const d = node.data || {};
    switch (node.type) {
      case 'trigger':
        return { output: scope.input, ports: ['out'] };

      case 'agent': {
        const prompt = render(d.prompt || '{{last}}', scope);
        const task = await this.runtime.run({
          agentId: d.agentId, input: prompt || '(empty input)', from: { type: 'workflow', id: wf.id, name: wf.name },
          contextId: d.keepMemory ? `wf:${wf.id}:${node.id}` : `wf-run:${run.id}:${node.id}`, signal, workflowRunId: run.id,
        });
        if (task.status.state !== 'completed') throw new Error(task.status.message || `agent ${task.status.state}`);
        return { output: task.artifacts[0]?.text || '', ports: ['out'], taskId: task.id };
      }

      case 'decide': {
        const text = render(d.text || '{{last}}', scope);
        const r = await this.decide(d, text, signal, { runId: run.id, nodeId: node.id });
        return { output: r.choice, ports: [r.choice], detail: r };
      }

      case 'condition': {
        const left = render(d.left ?? '{{last}}', scope);
        const right = render(d.right ?? '', scope);
        const ok = compare(left, d.op || 'contains', right);
        return { output: ok ? 'true' : 'false', ports: [ok ? 'true' : 'false'], detail: { result: ok } };
      }

      case 'tool': {
        let args = d.args ?? {};
        if (typeof args === 'string') {
          const rendered = render(args, scope);
          try { args = JSON.parse(rendered || '{}'); } catch { throw new Error(`Tool arguments are not valid JSON after filling in templates: ${truncate(rendered, 200)}`); }
        } else args = renderDeep(args, scope);
        const result = await this.plugins.callTool(d.connectorId, d.tool, args, { signal, workflowRunId: run.id });
        return { output: result, ports: ['out'] };
      }

      case 'transform':
        return { output: render(d.template ?? '{{last}}', scope), ports: ['out'] };

      case 'output':
        return { output: render(d.template ?? '{{last}}', scope), ports: [] };

      default:
        throw new Error(`Unknown step type ${node.type}`);
    }
  }

  /**
   * Decide with Laya (System 1) and escalate to an LLM agent (System 2) when Laya is unsure,
   * unavailable, or when the engine is 'llm'.
   */
  async decide(d, text, signal, ref = {}) {
    const options = (d.options || []).filter((o) => o.label?.trim());
    if (options.length < 2) throw new Error('Decide needs at least 2 options');
    const engine = d.engine || 'auto';
    const question = d.question || 'Which option fits best?';
    const layaConn = d.connectorId ? this.plugins.get(d.connectorId) : this.store.all('connectors').find((c) => c.pluginId === 'laya' && c.enabled !== false);
    let laya = null, layaError = null;

    if ((engine === 'auto' || engine === 'laya') && layaConn) {
      try {
        const inst = await this.plugins.instance(layaConn.id);
        this.bus.emitEvent('connector.call', { connectorId: layaConn.id, connectorName: layaConn.name, pluginId: 'laya', tool: 'decide', ...ref });
        laya = await inst.decide({ text, question, type: 'choice', options }, signal);
        if (d.threshold != null && d.threshold !== '') { laya.threshold = Number(d.threshold); laya.escalate = laya.confidence != null && laya.confidence < laya.threshold; }
        this.bus.emitEvent('connector.result', { connectorId: layaConn.id, tool: 'decide', ok: true, preview: `${laya.answer} (${Math.round((laya.confidence || 0) * 100)}%)` });
        if (engine === 'laya' || !laya.escalate) {
          return { choice: matchOption(laya.answer, options) || laya.answer, confidence: laya.confidence, probabilities: laya.probabilities, engine: 'laya', escalated: false, model: laya.model };
        }
      } catch (e) {
        if (engine === 'laya') throw e;
        layaError = e.message;
      }
    } else if (engine === 'laya') throw new Error('No Laya connector configured');

    // System 2: ask an LLM agent
    const agents = this.store.all('agents');
    const agent = agents.find((a) => a.id === d.agentId) || agents[0];
    if (!agent) throw new Error('No agent available to make the decision');
    const prompt = `${question}\n\nOptions:\n${options.map((o) => `- ${o.label}${o.description ? `: ${o.description}` : ''}`).join('\n')}\n\nContent:\n"""\n${text}\n"""\n\nReply with exactly one option label and nothing else.`;
    this.bus.emitEvent('agent.status', { agentId: agent.id, state: 'working', detail: 'deciding', active: 1 });
    let reply;
    try {
      reply = await this.runtime.complete(agent, { system: `You are ${agent.name}, making a routing decision. Answer with one label only.`, prompt, signal, meta: { decide: { options, text } }, maxTokens: 50 });
    } finally {
      this.bus.emitEvent('agent.status', { agentId: agent.id, state: (this.runtime.busy.get(agent.id) || 0) > 0 ? 'working' : 'idle', active: this.runtime.busy.get(agent.id) || 0 });
    }
    const choice = matchOption(reply, options);
    if (!choice) throw new Error(`${agent.name} answered "${truncate(reply, 80)}", which isn't one of the options`);
    return {
      choice, confidence: null, engine: 'llm', agentName: agent.name,
      escalated: !!(laya || layaError) && engine === 'auto',
      laya: laya ? { answer: laya.answer, confidence: laya.confidence, threshold: laya.threshold } : undefined,
      layaError: layaError || undefined,
    };
  }
}

export function matchOption(reply, options) {
  if (reply == null) return null;
  const r = String(reply).trim().toLowerCase().replace(/^["'`*\s]+|["'`*.\s]+$/g, '');
  const exact = options.find((o) => o.label.toLowerCase() === r);
  if (exact) return exact.label;
  const contained = options.filter((o) => new RegExp(`\\b${o.label.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(r));
  if (contained.length === 1) return contained[0].label;
  return null;
}

export function compare(left, op, right) {
  const l = String(left ?? ''), r = String(right ?? '');
  const ln = parseFloat(l), rn = parseFloat(r);
  switch (op) {
    case 'contains': return l.toLowerCase().includes(r.toLowerCase());
    case 'not_contains': return !l.toLowerCase().includes(r.toLowerCase());
    case 'equals': return l.trim().toLowerCase() === r.trim().toLowerCase();
    case 'not_equals': return l.trim().toLowerCase() !== r.trim().toLowerCase();
    case 'starts_with': return l.trim().toLowerCase().startsWith(r.trim().toLowerCase());
    case 'regex': try { return new RegExp(r, 'i').test(l); } catch { throw new Error(`Invalid regex: ${r}`); }
    case 'gt': return ln > rn;
    case 'lt': return ln < rn;
    case 'empty': return !l.trim();
    case 'not_empty': return !!l.trim();
    default: throw new Error(`Unknown operator ${op}`);
  }
}

export { lookup };
