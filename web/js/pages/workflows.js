import { html, useEffect, useRef, useState, useMemo, useCallback } from '../../lib/preact-htm.js';
import { api } from '../api.js';
import { useStore, go, toast, toastError, timeAgo, state } from '../state.js';
import { Icon } from '../icons.js';
import { Avatar, Modal, Field, Toggle, Seg, Empty, confirmDialog, CopyField, StatusBadge } from '../ui.js';
import { markdown } from '../markdown.js';

const TYPES = {
  trigger: { label: 'Start', icon: 'play', color: '#2fd18b', desc: 'Where the run begins. Receives the input.' },
  agent: { label: 'Agent', icon: 'agent', color: '#7c5cff', desc: 'An agent does a step of work.' },
  decide: { label: 'Decide', icon: 'bolt', color: '#f5b83d', desc: 'Route by meaning. Laya first, LLM if unsure.' },
  condition: { label: 'Condition', icon: 'split', color: '#3ba7ff', desc: 'Branch on a simple rule.' },
  tool: { label: 'Tool', icon: 'tool', color: '#22c3a6', desc: 'Call a connector tool directly.' },
  transform: { label: 'Transform', icon: 'wand', color: '#e858a8', desc: 'Combine or reshape text with a template.' },
  output: { label: 'Output', icon: 'output', color: '#8e8cf7', desc: 'The final result of the run.' },
};
const OPS = [['contains', 'contains'], ['not_contains', 'does not contain'], ['equals', 'equals'], ['not_equals', 'does not equal'], ['starts_with', 'starts with'], ['regex', 'matches regex'], ['gt', 'is greater than'], ['lt', 'is less than'], ['empty', 'is empty'], ['not_empty', 'is not empty']];
const NODE_W = 220;
const uid = (p) => `${p}_${Math.random().toString(16).slice(2, 10)}`;

function portsOf(n) {
  if (n.type === 'decide') return (n.data?.options || []).map((o) => o.label).filter(Boolean);
  if (n.type === 'condition') return ['true', 'false'];
  if (n.type === 'output') return [];
  return ['out'];
}
const portY = (i, count) => (count <= 1 ? 21 : 56 + i * 22);

function nodeSummary(n, agents, connectors) {
  const d = n.data || {};
  switch (n.type) {
    case 'trigger': return d.sampleInput ? `e.g. “${d.sampleInput}”` : 'Manual, webhook or schedule';
    case 'agent': { const a = agents.find((x) => x.id === d.agentId); return a ? html`<span class="row" style="gap:6px"><${Avatar} agent=${a} size=${18} radius=${6} /><b style="color:var(--text)">${a.name}</b><span class="muted ellipsis">${a.role}</span></span>` : html`<span style="color:var(--amber)">Choose an agent</span>`; }
    case 'decide': return `${d.engine === 'llm' ? 'LLM' : d.engine === 'laya' ? 'Laya' : 'Laya → LLM'} · ${d.question || 'no question'}`;
    case 'condition': return `if ${d.left || '{{last}}'} ${OPS.find((o) => o[0] === (d.op || 'contains'))?.[1]} ${['empty', 'not_empty'].includes(d.op) ? '' : `“${d.right || ''}”`}`;
    case 'tool': { const c = connectors.find((x) => x.id === d.connectorId); return c ? `${c.name} · ${d.tool || 'choose tool'}` : html`<span style="color:var(--amber)">Choose a connector</span>`; }
    case 'transform': case 'output': return (d.template || '{{last}}').slice(0, 80);
    default: return '';
  }
}

export function WorkflowsPage({ id }) {
  const workflows = useStore((s) => s.workflows);
  const runs = useStore((s) => s.runs);
  const current = workflows.find((w) => w.id === id) || null;
  useEffect(() => { if (!id && workflows[0]) go(`/workflows/${workflows[0].id}`); }, [id, workflows.length]);

  const create = async () => {
    try { const wf = await api.post('/api/workflows', { name: 'Untitled workflow' }); go(`/workflows/${wf.id}`); toast('Workflow created. Add steps from the toolbar.', 'success'); }
    catch (e) { toastError(e); }
  };

  return html`<div class="wf-layout">
    <div class="wf-list">
      <div class="row between" style="padding:14px 14px 8px">
        <div class="section-title" style="margin:0">Workflows</div>
        <button class="btn xs" onClick=${create} data-testid="wf-new"><${Icon} name="plus" size=${13} />New</button>
      </div>
      <div class="items">
        ${workflows.map((w) => {
          const last = runs.filter((r) => r.workflowId === w.id).slice(-1)[0];
          return html`<div class=${`wf-item ${w.id === id ? 'sel' : ''}`} key=${w.id} onClick=${() => go(`/workflows/${w.id}`)} role="button" tabindex="0">
            <div class="row" style="gap:8px"><div class="n grow ellipsis">${w.name}</div>${last ? html`<span class=${`status-dot ${last.status === 'completed' ? 'green' : last.status === 'running' ? 'accent' : last.status === 'failed' ? 'red' : ''}`}></span>` : null}</div>
            <div class="d">${w.nodes.length} steps${last ? ` · ran ${timeAgo(last.startedAt)}` : ''}</div>
          </div>`;
        })}
        ${!workflows.length ? html`<div class="muted small" style="padding:12px">No workflows yet.</div>` : null}
      </div>
    </div>
    ${current ? html`<${Editor} key=${current.id} wf=${current} />` : html`<div style="grid-column: span 2" class="wf-canvas"><${Empty} icon="flow" title="Build a workflow" action=${html`<button class="btn primary" onClick=${create}><${Icon} name="plus" size=${15} />New workflow</button>`}>Chain agents, Laya decisions, conditions and tools into a repeatable process. Run it by hand, from a webhook, or on a schedule.<//></div>`}
  </div>`;
}

function Editor({ wf }) {
  const agents = useStore((s) => s.agents);
  const connectors = useStore((s) => s.connectors);
  const runs = useStore((s) => s.runs);
  const [doc, setDoc] = useState(() => structuredClone({ name: wf.name, description: wf.description, nodes: wf.nodes, edges: wf.edges, trigger: wf.trigger }));
  const [sel, setSel] = useState(null); // {kind:'node'|'edge', id}
  const [view, setView] = useState({ x: 40, y: 40, z: 1 });
  const [ghost, setGhost] = useState(null);
  const [problems, setProblems] = useState([]);
  const [saveState, setSaveState] = useState('saved');
  const [runId, setRunId] = useState(null);
  const [runOpen, setRunOpen] = useState(false);
  const [trigOpen, setTrigOpen] = useState(false);
  const canvasRef = useRef();
  const saveTimer = useRef();
  const docRef = useRef(doc); docRef.current = doc;
  const viewRef = useRef(view); viewRef.current = view;

  // fit view on open
  useEffect(() => {
    const r = canvasRef.current.getBoundingClientRect();
    if (!doc.nodes.length) return;
    const xs = doc.nodes.map((n) => n.x), ys = doc.nodes.map((n) => n.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs) + NODE_W, minY = Math.min(...ys), maxY = Math.max(...ys) + 120;
    // leave room for the step toolbar on the left and the run panel at the bottom
    const left = 96, availW = r.width - left - 30, availH = r.height * 0.58 - 70;
    const z = Math.max(0.72, Math.min(1.05, availW / (maxX - minX), availH / (maxY - minY)));
    setView({ z, x: left + Math.max(0, (availW - (maxX - minX) * z) / 2) - minX * z, y: 70 + Math.max(0, (availH - (maxY - minY) * z) / 2) - minY * z });
    api.get(`/api/workflows/${wf.id}`).then((w) => setProblems(w.problems || [])).catch(() => {});
  }, []);

  const persist = useCallback((next) => {
    setSaveState('saving');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try { const r = await api.put(`/api/workflows/${wf.id}`, next); setProblems(r.problems || []); setSaveState('saved'); }
      catch (e) { setSaveState('error'); toastError(e); }
    }, 450);
  }, [wf.id]);
  const update = (fn) => setDoc((d) => { const n = fn(structuredClone(d)); persist(n); return n; });
  useEffect(() => () => { // flush on unmount
    if (saveTimer.current) { clearTimeout(saveTimer.current); api.put(`/api/workflows/${wf.id}`, docRef.current).catch(() => {}); }
  }, []);
  useEffect(() => { // re-validate when agents/connectors change
    api.get(`/api/workflows/${wf.id}`).then((w) => setProblems(w.problems || [])).catch(() => {});
  }, [agents.length, connectors.length]);

  const run = runId ? runs.find((r) => r.id === runId) : null;
  const nodeStatus = (nid) => run?.nodes?.[nid]?.status;
  const invalid = new Set(problems.filter((p) => p.nodeId && !p.warning).map((p) => p.nodeId));

  // ------------------------------------------------------------ canvas interactions
  const toWorld = (cx, cy) => { const r = canvasRef.current.getBoundingClientRect(); const v = viewRef.current; return { x: (cx - r.left - v.x) / v.z, y: (cy - r.top - v.y) / v.z }; };

  const onCanvasDown = (e) => {
    if (e.target !== canvasRef.current && !e.target.classList.contains('wf-world') && e.target.tagName !== 'svg') return;
    setSel(null);
    const start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    canvasRef.current.classList.add('panning');
    const move = (ev) => setView((v) => ({ ...v, x: start.vx + ev.clientX - start.x, y: start.vy + ev.clientY - start.y }));
    const up = () => { canvasRef.current?.classList.remove('panning'); removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };
  const onWheel = (e) => {
    e.preventDefault();
    const r = canvasRef.current.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= 40) {
      setView((v) => { const z = Math.max(0.35, Math.min(1.8, v.z * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022)))); const k = z / v.z; return { z, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k }; });
    } else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
  };
  useEffect(() => {
    const c = canvasRef.current;
    const noScroll = () => { if (c.scrollLeft || c.scrollTop) { c.scrollLeft = 0; c.scrollTop = 0; } };
    c.addEventListener('wheel', onWheel, { passive: false });
    c.addEventListener('scroll', noScroll);
    return () => { c.removeEventListener('wheel', onWheel); c.removeEventListener('scroll', noScroll); };
  }, []);

  const dragNode = (e, n) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSel({ kind: 'node', id: n.id });
    const start = toWorld(e.clientX, e.clientY);
    const orig = { x: n.x, y: n.y };
    let moved = false;
    const move = (ev) => {
      const p = toWorld(ev.clientX, ev.clientY);
      const nx = Math.round((orig.x + p.x - start.x) / 10) * 10, ny = Math.round((orig.y + p.y - start.y) / 10) * 10;
      moved = true;
      setDoc((d) => ({ ...d, nodes: d.nodes.map((x) => (x.id === n.id ? { ...x, x: nx, y: ny } : x)) }));
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); if (moved) persist(docRef.current); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };

  const startConnect = (e, n, port, i, count) => {
    e.stopPropagation(); e.preventDefault();
    const from = { x: n.x + NODE_W, y: n.y + portY(i, count) };
    const move = (ev) => setGhost({ from, to: toWorld(ev.clientX, ev.clientY) });
    const up = (ev) => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      setGhost(null);
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-node]');
      const to = el?.dataset.node;
      if (!to || to === n.id) return;
      const target = docRef.current.nodes.find((x) => x.id === to);
      if (target?.type === 'trigger') { toast('The Start step can’t have inputs.', 'error'); return; }
      if (docRef.current.edges.some((x) => x.from === n.id && x.to === to && (x.fromPort || 'out') === port)) return;
      if (reaches(docRef.current, to, n.id)) { toast('That would create a loop.', 'error'); return; }
      update((d) => { d.edges.push({ id: uid('e'), from: n.id, to, fromPort: port }); return d; });
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };

  const addNode = (type) => {
    if (type === 'trigger' && doc.nodes.some((n) => n.type === 'trigger')) { toast('This workflow already has a Start step.'); return; }
    const r = canvasRef.current.getBoundingClientRect();
    const c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
    const selected = sel?.kind === 'node' ? doc.nodes.find((n) => n.id === sel.id) : null;
    const pos = selected ? { x: selected.x + 280, y: selected.y } : { x: Math.round((c.x - NODE_W / 2) / 10) * 10, y: Math.round((c.y - 40) / 10) * 10 };
    const data = {
      trigger: { label: 'Start', sampleInput: '' },
      agent: { label: 'Agent step', agentId: agents[0]?.id || '', prompt: '{{last}}' },
      decide: { label: 'Decide', engine: 'auto', question: 'Which option fits best?', text: '{{last}}', agentId: agents[0]?.id || '', threshold: 0.7, options: [{ label: 'yes', description: '' }, { label: 'no', description: '' }] },
      condition: { label: 'Condition', left: '{{last}}', op: 'contains', right: '' },
      tool: { label: 'Tool', connectorId: connectors[0]?.id || '', tool: '', args: '{}' },
      transform: { label: 'Transform', template: '{{last}}' },
      output: { label: 'Output', template: '{{last}}' },
    }[type];
    const node = { id: uid('n'), type, x: pos.x, y: pos.y, data };
    // keep the new step on screen: pan if it would land outside the visible canvas
    const v = viewRef.current;
    const sx = v.x + pos.x * v.z, sy = v.y + pos.y * v.z, sw = NODE_W * v.z, sh = 90 * v.z;
    const minX = 96, maxX = r.width - 24, minY = 70, maxY = r.height - 24;
    let dx = 0, dy = 0;
    if (sx + sw > maxX) dx = maxX - (sx + sw); else if (sx < minX) dx = minX - sx;
    if (sy + sh > maxY) dy = maxY - (sy + sh); else if (sy < minY) dy = minY - sy;
    if (dx || dy) setView({ ...v, x: v.x + dx, y: v.y + dy });
    update((d) => {
      d.nodes.push(node);
      if (selected && portsOf(selected).length === 1 && type !== 'trigger') d.edges.push({ id: uid('e'), from: selected.id, to: node.id, fromPort: portsOf(selected)[0] });
      return d;
    });
    setSel({ kind: 'node', id: node.id });
  };

  const removeSel = () => {
    if (!sel) return;
    if (sel.kind === 'node') update((d) => { d.nodes = d.nodes.filter((n) => n.id !== sel.id); d.edges = d.edges.filter((e) => e.from !== sel.id && e.to !== sel.id); return d; });
    else update((d) => { d.edges = d.edges.filter((e) => e.id !== sel.id); return d; });
    setSel(null);
  };
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest('input, textarea, select')) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); removeSel(); }
    };
    addEventListener('keydown', onKey); return () => removeEventListener('keydown', onKey);
  }, [sel]);

  const startRun = async (input) => {
    clearTimeout(saveTimer.current);
    try {
      await api.put(`/api/workflows/${wf.id}`, docRef.current);
      const r = await api.post(`/api/workflows/${wf.id}/run`, { input });
      setRunId(r.runId); setRunOpen(false);
    } catch (e) { toastError(e); }
  };

  const deleteWf = async () => {
    if (!(await confirmDialog({ title: `Delete “${doc.name}”?`, message: 'The workflow and its trigger settings will be removed. Past runs stay in Activity.', confirm: 'Delete', danger: true }))) return;
    clearTimeout(saveTimer.current); saveTimer.current = null;
    await api.del(`/api/workflows/${wf.id}`).catch(toastError);
    go('/workflows');
  };

  const selNode = sel?.kind === 'node' ? doc.nodes.find((n) => n.id === sel.id) : null;
  const errors = problems.filter((p) => !p.warning);
  const lastRuns = runs.filter((r) => r.workflowId === wf.id).slice(-8).reverse();

  return html`
    <div class="wf-canvas" ref=${canvasRef} onPointerDown=${onCanvasDown} data-testid="wf-canvas">
      <div class="palette-bar glass" onPointerDown=${(e) => e.stopPropagation()} role="toolbar" aria-label="Add a step">
        <div class="pb-title">Add</div>
        ${Object.entries(TYPES).map(([k, t]) => html`<button title=${`${t.label}: ${t.desc}`} onClick=${() => addNode(k)} data-testid=${`add-${k}`}><span class="sw" style=${{ background: t.color }}><${Icon} name=${t.icon} size=${13} stroke=${2.4} /></span>${t.label}</button>`)}
      </div>
      <div class="world-hud" style="top:14px;left:14px;display:flex;gap:8px;align-items:center" onPointerDown=${(e) => e.stopPropagation()}>
        <input class="input" style="width:240px;font-weight:650;background:var(--surface)" value=${doc.name} aria-label="Workflow name"
          onInput=${(e) => update((d) => { d.name = e.target.value; return d; })} />
        <span class="muted tiny nowrap">${saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Not saved' : 'Saved'}</span>
      </div>
      <div class="world-hud" style="top:14px;right:14px;display:flex;gap:8px" onPointerDown=${(e) => e.stopPropagation()}>
        <button class="btn glass" onClick=${() => setTrigOpen(true)}><${Icon} name="webhook" size=${15} />Triggers${doc.trigger?.webhook?.enabled || doc.trigger?.schedule?.enabled ? html`<span class="status-dot green" style="width:6px;height:6px"></span>` : null}</button>
        <button class="btn primary" onClick=${() => setRunOpen(true)} disabled=${errors.length > 0} title=${errors.length ? errors.map((p) => p.message).join('\n') : 'Run this workflow'} data-testid="wf-run"><${Icon} name="play" size=${14} />Run</button>
      </div>
      <div class="wf-world" style=${{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
        <svg class="wf-edges" width="1" height="1">
          ${doc.edges.map((e) => {
            const a = doc.nodes.find((n) => n.id === e.from), b = doc.nodes.find((n) => n.id === e.to);
            if (!a || !b) return null;
            const ports = portsOf(a); const i = Math.max(0, ports.indexOf(e.fromPort || 'out'));
            const x1 = a.x + NODE_W, y1 = a.y + portY(i, ports.length), x2 = b.x, y2 = b.y + 21;
            const dx = x2 > x1 + 10 ? Math.max(20, Math.min(120, (x2 - x1) / 2)) : 90;
            const sa = nodeStatus(a.id), sb = nodeStatus(b.id);
            const fired = run && sa === 'done' && (a.type !== 'decide' && a.type !== 'condition' ? true : run.nodes?.[a.id]?.output === e.fromPort || (a.type === 'condition' && String(run.nodes?.[a.id]?.detail?.result) === e.fromPort));
            const cls = `edge ${sel?.id === e.id ? 'sel' : ''} ${fired && sb === 'running' ? 'flow' : fired ? 'fired' : run && sb === 'skipped' ? 'skipped' : ''}`;
            return html`<g key=${e.id}>
              <path class=${cls} d=${`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`} onPointerDown=${(ev) => { ev.stopPropagation(); setSel({ kind: 'edge', id: e.id }); }} />
              <path d=${`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`} stroke="transparent" stroke-width="14" fill="none" style="pointer-events:stroke;cursor:pointer" onPointerDown=${(ev) => { ev.stopPropagation(); setSel({ kind: 'edge', id: e.id }); }} />
            </g>`;
          })}
          ${ghost ? html`<path class="ghost" d=${`M${ghost.from.x},${ghost.from.y} C${ghost.from.x + 60},${ghost.from.y} ${ghost.to.x - 60},${ghost.to.y} ${ghost.to.x},${ghost.to.y}`} />` : null}
        </svg>
        ${doc.nodes.map((n) => {
          const t = TYPES[n.type] || TYPES.transform;
          const ports = portsOf(n);
          const st = nodeStatus(n.id);
          const out = run?.nodes?.[n.id];
          return html`<div class=${`node ${sel?.id === n.id ? 'sel' : ''} ${st ? `st-${st}` : ''} ${invalid.has(n.id) ? 'invalid' : ''}`} key=${n.id} data-node=${n.id} data-testid=${`node-${n.data?.label || n.type}`}
              style=${{ left: n.x + 'px', top: n.y + 'px', minHeight: Math.max(64, ports.length > 1 ? 50 + ports.length * 22 : 0) + 'px' }}
              onPointerDown=${(e) => dragNode(e, n)}>
            <div class="node-head">
              <span class="ic" style=${{ background: t.color }}><${Icon} name=${t.icon} size=${13} stroke=${2.4} /></span>
              <span class="t">${n.data?.label || t.label}</span>
              ${st === 'running' ? html`<span class="spinner" style="color:var(--accent)"></span>` : st === 'done' ? html`<${Icon} name="ok" size=${15} style="color:var(--green)" />` : st === 'failed' ? html`<${Icon} name="errc" size=${15} style="color:var(--red)" />` : html`<span class="k">${t.label}</span>`}
            </div>
            <div class="node-body" style=${{ paddingRight: ports.length > 1 ? '64px' : undefined }}>
              <div class="line">${nodeSummary(n, agents, connectors)}</div>
              ${out?.output != null && st === 'done' ? html`<div class="node-out">${String(out.output).slice(0, 160)}</div>` : null}
              ${out?.error ? html`<div class="node-out" style="color:var(--red)">${out.error}</div>` : null}
            </div>
            ${n.type !== 'trigger' ? html`<span class="port in" title="Input"></span>` : null}
            ${ports.map((p, i) => html`<span class="port" style=${{ right: '-8px', top: portY(i, ports.length) - 7 + 'px' }} title=${`Drag to connect (${p})`}
                onPointerDown=${(e) => startConnect(e, n, p, i, ports.length)} data-port=${p}></span>
              ${ports.length > 1 ? html`<span class="port-label" style=${{ top: portY(i, ports.length) + 'px' }}>${p}</span>` : null}`)}
          </div>`;
        })}
      </div>
      ${run ? html`<${RunPanel} run=${run} doc=${doc} onClose=${() => setRunId(null)} />` : null}
      ${!doc.nodes.length ? html`<div style="position:absolute;inset:0;display:grid;place-items:center;pointer-events:none"><div class="muted">Add a Start step from the toolbar above.</div></div>` : null}
    </div>
    <div class="wf-panel">
      ${selNode ? html`<${NodeConfig} key=${selNode.id} node=${selNode} doc=${doc} update=${update} onDelete=${removeSel} problems=${problems.filter((p) => p.nodeId === selNode.id)} />`
        : sel?.kind === 'edge' ? html`<div class="body"><div class="section-title">Connection</div><p class="small dim">Selected connection. Press <span class="kbd">Delete</span> or:</p><button class="btn danger" onClick=${removeSel}><${Icon} name="trash" size=${14} />Remove connection</button></div>`
        : html`<div class="body">
          <div class="section-title">Workflow</div>
          <${Field} label="Description"><textarea class="textarea" rows="2" value=${doc.description || ''} onInput=${(e) => update((d) => { d.description = e.target.value; return d; })} placeholder="What does this workflow do?"></textarea><//>
          ${problems.length ? html`<div class="section-title" style="margin-top:6px">Checks</div><div class="problems" style="margin-bottom:18px">${problems.map((p) => html`<div class=${`problem ${p.warning ? '' : 'err'}`}><${Icon} name=${p.warning ? 'info' : 'alert'} size=${14} style="flex:none;margin-top:2px" /><span>${p.message}</span></div>`)}</div>` : html`<div class="callout" style="margin-bottom:18px;font-size:12.5px"><${Icon} name="ok" size=${15} /><div>Ready to run.</div></div>`}
          <div class="section-title">How to edit</div>
          <div class="small dim col" style="gap:6px;margin-bottom:18px">
            <span>• Add steps from the toolbar. Selecting a step first auto-connects the new one after it.</span>
            <span>• Drag from a step’s right-hand dot onto another step to connect them.</span>
            <span>• Click a step to configure it; <span class="kbd">Delete</span> removes the selection.</span>
            <span>• Drag the background to pan and scroll to zoom.</span>
          </div>
          <div class="section-title">Recent runs</div>
          ${lastRuns.length ? html`<div class="col" style="gap:6px">${lastRuns.map((r) => html`<button class="card row" style="padding:9px 11px;text-align:left;cursor:pointer" onClick=${() => setRunId(r.id)}>
            <${StatusBadge} status=${r.status} /><span class="grow small dim ellipsis">${r.trigger} · ${timeAgo(r.startedAt)}</span><${Icon} name="chevronRight" size=${14} />
          </button>`)}</div>` : html`<p class="muted small">No runs yet.</p>`}
          <div class="divider"></div>
          <button class="btn danger sm" onClick=${deleteWf}><${Icon} name="trash" size=${14} />Delete workflow</button>
        </div>`}
    </div>
    ${runOpen ? html`<${RunModal} doc=${doc} onClose=${() => setRunOpen(false)} onRun=${startRun} />` : null}
    ${trigOpen ? html`<${TriggerModal} wf=${wf} doc=${doc} update=${update} onClose=${() => setTrigOpen(false)} />` : null}
  `;
}

function reaches(doc, from, target) {
  const seen = new Set(); const stack = [from];
  while (stack.length) { const x = stack.pop(); if (x === target) return true; if (seen.has(x)) continue; seen.add(x); for (const e of doc.edges) if (e.from === x) stack.push(e.to); }
  return false;
}
function ancestors(doc, id) {
  const out = []; const seen = new Set(); const stack = [id];
  while (stack.length) { const x = stack.pop(); for (const e of doc.edges) if (e.to === x && !seen.has(e.from)) { seen.add(e.from); out.push(e.from); stack.push(e.from); } }
  return out.map((i) => doc.nodes.find((n) => n.id === i)).filter(Boolean);
}

function TemplateField({ label, value, onChange, doc, node, rows = 4, help }) {
  const ref = useRef();
  const vars = [{ v: '{{input}}', t: 'Run input' }, { v: '{{last}}', t: 'Previous step output' }, ...ancestors(doc, node.id).filter((n) => n.type !== 'trigger').map((n) => ({ v: `{{nodes.${n.id}.output}}`, t: n.data?.label || n.type }))];
  const insert = (v) => {
    const el = ref.current; const s = el?.selectionStart ?? value.length, e = el?.selectionEnd ?? value.length;
    const next = value.slice(0, s) + v + value.slice(e);
    onChange(next);
    setTimeout(() => { el?.focus(); el?.setSelectionRange(s + v.length, s + v.length); }, 0);
  };
  return html`<${Field} label=${label} help=${help}>
    <textarea ref=${ref} class="textarea mono" rows=${rows} value=${value} onInput=${(e) => onChange(e.target.value)}></textarea>
    <div class="var-chips">${vars.map((x) => html`<button type="button" class="var-chip" title=${x.v} onClick=${() => insert(x.v)}>+ ${x.t}</button>`)}</div>
  <//>`;
}

function NodeConfig({ node, doc, update, onDelete, problems }) {
  const agents = useStore((s) => s.agents);
  const connectors = useStore((s) => s.connectors);
  const d = node.data || {};
  const t = TYPES[node.type];
  const set = (patch) => update((doc) => { const n = doc.nodes.find((x) => x.id === node.id); n.data = { ...n.data, ...patch }; return doc; });
  const renamePort = (oldL, newL) => update((doc) => {
    const n = doc.nodes.find((x) => x.id === node.id);
    n.data.options = n.data.options.map((o) => (o.label === oldL ? { ...o, label: newL } : o));
    for (const e of doc.edges) if (e.from === node.id && e.fromPort === oldL) e.fromPort = newL;
    return doc;
  });
  const conn = connectors.find((c) => c.id === d.connectorId);
  const [tools, setTools] = useState(conn?.tools || null);
  const [loadingTools, setLoadingTools] = useState(false);
  useEffect(() => { setTools(conn?.tools || null); }, [d.connectorId, conn?.tools?.length]);
  const loadTools = async () => {
    setLoadingTools(true);
    try { const r = await api.post(`/api/connectors/${d.connectorId}/test`); if (r.ok) setTools(r.tools); else toast(r.message, 'error'); }
    catch (e) { toastError(e); } finally { setLoadingTools(false); }
  };
  const selectedTool = tools?.find((x) => x.name === d.tool);
  const layas = connectors.filter((c) => c.pluginId === 'laya');

  return html`<div class="body">
    <div class="row" style="margin-bottom:14px">
      <span class="ic" style=${{ background: t.color, width: '30px', height: '30px', borderRadius: '9px', display: 'grid', placeItems: 'center', color: 'white' }}><${Icon} name=${t.icon} size=${16} /></span>
      <div class="grow"><div class="bold">${t.label}</div><div class="muted tiny">${t.desc}</div></div>
      <button class="btn sm icon ghost danger" onClick=${onDelete} title="Delete step" aria-label="Delete step"><${Icon} name="trash" size=${15} /></button>
    </div>
    ${problems.map((p) => html`<div class=${`problem ${p.warning ? '' : 'err'}`} style="margin-bottom:12px"><${Icon} name="alert" size=${14} style="flex:none;margin-top:2px" /><span>${p.message}</span></div>`)}
    <${Field} label="Step name"><input class="input" value=${d.label || ''} onInput=${(e) => set({ label: e.target.value })} /><//>

    ${node.type === 'trigger' ? html`
      <${Field} label="Sample input" help="Pre-filled when you press Run. Webhook calls send their JSON body as the input."><textarea class="textarea" rows="4" value=${d.sampleInput || ''} onInput=${(e) => set({ sampleInput: e.target.value })}></textarea><//>` : null}

    ${node.type === 'agent' ? html`
      <${Field} label="Agent">
        <select class="select" value=${d.agentId || ''} onChange=${(e) => set({ agentId: e.target.value })}><option value="" disabled>Choose an agent…</option>${agents.map((a) => html`<option value=${a.id}>${a.name} · ${a.role}</option>`)}</select>
      <//>
      <${TemplateField} label="Prompt" value=${d.prompt ?? '{{last}}'} onChange=${(v) => set({ prompt: v })} doc=${doc} node=${node} rows=${6} help="What to ask the agent. Click a variable to insert it." />
      <div class="row" style="gap:10px"><${Toggle} on=${!!d.keepMemory} onChange=${(v) => set({ keepMemory: v })} label="Remember across runs" id="tg-km" /><label for="tg-km" class="small">Remember previous runs <span class="muted">(shared conversation)</span></label></div>` : null}

    ${node.type === 'decide' ? html`
      <${Field} label="Engine" help=${d.engine === 'laya' ? 'Laya only: fastest, fails if Laya is unavailable.' : d.engine === 'llm' ? 'Ask an LLM agent every time.' : 'Laya decides in milliseconds. Below the confidence threshold it escalates to an LLM agent.'}>
        <${Seg} value=${d.engine || 'auto'} onChange=${(v) => set({ engine: v })} options=${[{ value: 'auto', label: 'Laya → LLM' }, { value: 'laya', label: 'Laya only' }, { value: 'llm', label: 'LLM only' }]} />
      <//>
      ${d.engine !== 'llm' && !layas.length ? html`<div class="callout amber" style="margin:-6px 0 14px;font-size:12.5px"><${Icon} name="bolt" size=${15} /><div>No Laya connector yet${d.engine === 'laya' ? '' : ', so this will use the LLM'}. <a href="#/connectors">Add Laya</a></div></div>` : null}
      ${layas.length > 1 && d.engine !== 'llm' ? html`<${Field} label="Laya connector"><select class="select" value=${d.connectorId || ''} onChange=${(e) => set({ connectorId: e.target.value })}><option value="">First available</option>${layas.map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select><//>` : null}
      ${d.engine !== 'laya' ? html`<${Field} label="LLM agent (escalation)"><select class="select" value=${d.agentId || ''} onChange=${(e) => set({ agentId: e.target.value })}>${agents.map((a) => html`<option value=${a.id}>${a.name}</option>`)}</select><//>` : null}
      <${Field} label="Question"><input class="input" value=${d.question || ''} onInput=${(e) => set({ question: e.target.value })} /><//>
      <${TemplateField} label="Decide about" value=${d.text ?? '{{last}}'} onChange=${(v) => set({ text: v })} doc=${doc} node=${node} rows=${2} />
      <${Field} label="Options (each becomes a branch)">
        ${(d.options || []).map((o, i) => html`<div class="opt-row" key=${i}>
          <input class="input mono" value=${o.label} placeholder="label" onChange=${(e) => renamePort(o.label, e.target.value.trim().replace(/\s+/g, '_'))} aria-label="Option label" />
          <input class="input" value=${o.description || ''} placeholder="what it means" onInput=${(e) => set({ options: d.options.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })} aria-label="Option description" />
          <button class="btn icon sm ghost" aria-label="Remove option" onClick=${() => update((doc) => { const n = doc.nodes.find((x) => x.id === node.id); n.data.options = n.data.options.filter((_, j) => j !== i); doc.edges = doc.edges.filter((e) => !(e.from === node.id && e.fromPort === o.label)); return doc; })}><${Icon} name="x" size=${14} /></button>
        </div>`)}
        <button class="btn sm" style="width:max-content" onClick=${() => set({ options: [...(d.options || []), { label: `option_${(d.options?.length || 0) + 1}`, description: '' }] })}><${Icon} name="plus" size=${13} />Add option</button>
      <//>
      ${d.engine !== 'llm' ? html`<${Field} label="Escalate below confidence" help="0–1. Laya answers under this go to the LLM."><input class="input" type="number" min="0" max="1" step="0.05" value=${d.threshold ?? 0.7} onInput=${(e) => set({ threshold: e.target.value === '' ? '' : Number(e.target.value) })} /><//>` : null}` : null}

    ${node.type === 'condition' ? html`
      <${TemplateField} label="Value" value=${d.left ?? '{{last}}'} onChange=${(v) => set({ left: v })} doc=${doc} node=${node} rows=${2} />
      <${Field} label="Rule"><select class="select" value=${d.op || 'contains'} onChange=${(e) => set({ op: e.target.value })}>${OPS.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select><//>
      ${!['empty', 'not_empty'].includes(d.op) ? html`<${Field} label="Compare to"><input class="input" value=${d.right || ''} onInput=${(e) => set({ right: e.target.value })} placeholder="e.g. APPROVE" /><//>` : null}
      <p class="small muted">Connect the <b>true</b> and <b>false</b> dots to different steps.</p>` : null}

    ${node.type === 'tool' ? html`
      <${Field} label="Connector"><select class="select" value=${d.connectorId || ''} onChange=${(e) => set({ connectorId: e.target.value, tool: '' })}><option value="" disabled>Choose…</option>${connectors.map((c) => html`<option value=${c.id}>${c.name} (${c.pluginName})</option>`)}</select><//>
      ${d.connectorId ? html`<${Field} label="Tool" right=${html`<button class="btn xs ghost" onClick=${loadTools} disabled=${loadingTools}>${loadingTools ? 'Loading…' : tools ? 'Refresh' : 'Load tools'}</button>`}>
        ${tools ? html`<select class="select" value=${d.tool || ''} onChange=${(e) => { const tl = tools.find((x) => x.name === e.target.value); set({ tool: e.target.value, args: JSON.stringify(skeleton(tl?.inputSchema), null, 2) }); }}><option value="" disabled>Choose a tool…</option>${tools.map((x) => html`<option value=${x.name}>${x.name}</option>`)}</select>`
          : html`<div class="muted small">Press “Load tools” to connect and list its tools.</div>`}
      <//>` : null}
      ${selectedTool ? html`<p class="small dim" style="margin-top:-8px">${selectedTool.description}</p>` : null}
      <${TemplateField} label="Arguments (JSON)" value=${typeof d.args === 'string' ? d.args : JSON.stringify(d.args || {}, null, 2)} onChange=${(v) => set({ args: v })} doc=${doc} node=${node} rows=${5} help="Templates are filled in before the JSON is parsed." />` : null}

    ${node.type === 'transform' || node.type === 'output' ? html`
      <${TemplateField} label="Template" value=${d.template ?? '{{last}}'} onChange=${(v) => set({ template: v })} doc=${doc} node=${node} rows=${7} help=${node.type === 'output' ? 'This becomes the result of the run.' : 'Markdown and text, with variables.'} />` : null}
  </div>`;
}

function skeleton(schema) {
  const out = {};
  for (const [k, p] of Object.entries(schema?.properties || {})) {
    if (!(schema.required || []).includes(k) && Object.keys(schema.properties).length > 3) continue;
    out[k] = p.type === 'number' || p.type === 'integer' ? 0 : p.type === 'boolean' ? false : p.type === 'object' ? {} : p.type === 'array' ? [] : '{{last}}';
  }
  return out;
}

function RunModal({ doc, onClose, onRun }) {
  const trig = doc.nodes.find((n) => n.type === 'trigger');
  const [input, setInput] = useState(trig?.data?.sampleInput || '');
  return html`<${Modal} title=${`Run “${doc.name}”`} icon="play" onClose=${onClose} footer=${html`
    <button class="btn ghost" onClick=${onClose}>Cancel</button>
    <button class="btn primary" onClick=${() => onRun(input)} data-testid="wf-run-go"><${Icon} name="play" size=${14} />Run workflow</button>`}>
    <div class="modal-body">
      <${Field} label="Input" help="Available to steps as {{input}}. Plain text or JSON."><textarea class="textarea" rows="6" value=${input} onInput=${(e) => setInput(e.target.value)} autofocus onKeyDown=${(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onRun(input); }}></textarea><//>
      <div class="muted tiny"><span class="kbd">⌘</span> <span class="kbd">↵</span> to run</div>
    </div>
  <//>`;
}

function RunPanel({ run, doc, onClose }) {
  const [tab, setTab] = useState('result');
  const ms = run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null;
  const order = doc.nodes.slice().sort((a, b) => (run.nodes?.[a.id]?.startedAt || 'z').localeCompare(run.nodes?.[b.id]?.startedAt || 'z'));
  const output = typeof run.output === 'string' ? run.output : run.output ? JSON.stringify(run.output, null, 2) : '';
  return html`<div class="run-panel glass" onPointerDown=${(e) => e.stopPropagation()} data-testid="run-panel">
    <div class="rp-head">
      <${StatusBadge} status=${run.status} />
      <b class="small">Run</b>
      <span class="muted tiny">${run.trigger} · ${timeAgo(run.startedAt)}${ms != null ? ` · ${(ms / 1000).toFixed(1)}s` : ''}</span>
      <span class="spacer"></span>
      <div class="seg"><button class=${tab === 'result' ? 'on' : ''} onClick=${() => setTab('result')}>Result</button><button class=${tab === 'steps' ? 'on' : ''} onClick=${() => setTab('steps')}>Steps</button></div>
      ${run.status === 'running' ? html`<button class="btn sm" onClick=${() => api.post(`/api/runs/${run.id}/cancel`)}><${Icon} name="stop" size=${13} />Stop</button>` : null}
      <button class="btn sm icon ghost" onClick=${onClose} aria-label="Close run panel"><${Icon} name="x" size=${15} /></button>
    </div>
    <div class="rp-body">
      ${tab === 'result' ? (run.status === 'running' ? html`<div class="row dim small"><span class="spinner"></span>Working through the steps… watch the colony to see who’s on it.</div>`
        : run.status === 'failed' ? html`<div class="problem err"><${Icon} name="alert" size=${14} style="flex:none;margin-top:2px" /><span>${run.error}</span></div>`
        : run.status === 'canceled' ? html`<div class="muted small">This run was stopped.</div>`
        : html`<div class="md small" data-testid="run-output" dangerouslySetInnerHTML=${{ __html: markdown(output || '(empty)') }}></div>`)
      : html`<div class="col" style="gap:8px">${order.map((n) => { const s = run.nodes?.[n.id]; if (!s) return null; return html`<div class="card" style="padding:9px 11px">
          <div class="row small"><${StatusBadge} status=${s.status === 'done' ? 'completed' : s.status} /><b>${n.data?.label || TYPES[n.type].label}</b><span class="spacer"></span>${s.ms != null ? html`<span class="muted tiny">${(s.ms / 1000).toFixed(2)}s</span>` : null}</div>
          ${s.detail?.engine ? html`<div class="tiny dim" style="margin-top:4px">Decided by <b>${s.detail.engine === 'laya' ? 'Laya' : s.detail.agentName || 'LLM'}</b>${s.detail.confidence != null ? ` · ${Math.round(s.detail.confidence * 100)}% confident` : ''}${s.detail.escalated ? ` · escalated${s.detail.laya ? ` (Laya said ${s.detail.laya.answer} at ${Math.round(s.detail.laya.confidence * 100)}%)` : s.detail.layaError ? ` (Laya unavailable)` : ''}` : ''}</div>` : null}
          ${s.output != null ? html`<div class="node-out" style="max-height:120px;overflow:auto;white-space:pre-wrap">${String(s.output)}</div>` : null}
          ${s.error ? html`<div class="tiny" style="color:var(--red);margin-top:4px">${s.error}</div>` : null}
        </div>`; })}</div>`}
    </div>
  </div>`;
}

function TriggerModal({ wf, doc, update, onClose }) {
  const t = doc.trigger || {};
  const hook = t.webhook || {};
  const sch = t.schedule || {};
  const url = `${location.origin}/api/hooks/${wf.id}?token=${hook.token || ''}`;
  const setT = (k, patch) => update((d) => { d.trigger = d.trigger || {}; d.trigger[k] = { ...(d.trigger[k] || {}), ...patch }; return d; });
  return html`<${Modal} title="Triggers" icon="webhook" onClose=${onClose} footer=${html`<button class="btn primary" onClick=${onClose}>Done</button>`}>
    <div class="modal-body">
      <div class="row" style="gap:12px;margin-bottom:10px"><${Toggle} on=${!!hook.enabled} onChange=${(v) => setT('webhook', { enabled: v })} label="Webhook" id="tg-hook" /><label for="tg-hook" class="grow"><div class="bold">Webhook</div><div class="muted small">Run this workflow when something POSTs to a URL.</div></label></div>
      ${hook.enabled ? html`<${Field} label="URL" help="POST a JSON body. It becomes {{input}}. Add &wait=1 to get the result in the response."><${CopyField} value=${url} /><//>
        <${Field} label="Try it"><${CopyField} value=${`curl -X POST '${url}&wait=1' -H 'content-type: application/json' -d '{"input":"hello"}'`} /><//>
        <button class="btn sm" onClick=${() => setT('webhook', { token: 'hook_' + Math.random().toString(16).slice(2, 14) })}><${Icon} name="refresh" size=${13} />New secret token</button>` : null}
      <div class="divider"></div>
      <div class="row" style="gap:12px;margin-bottom:10px"><${Toggle} on=${!!sch.enabled} onChange=${(v) => setT('schedule', { enabled: v })} label="Schedule" id="tg-sch" /><label for="tg-sch" class="grow"><div class="bold">Schedule</div><div class="muted small">Run automatically while Atrium is running.</div></label></div>
      ${sch.enabled ? html`<div class="grid2">
        <${Field} label="Every (minutes)"><input class="input" type="number" min="1" value=${sch.everyMinutes || 60} onInput=${(e) => setT('schedule', { everyMinutes: Number(e.target.value) })} /><//>
        <${Field} label="Input"><input class="input" value=${sch.input || ''} onInput=${(e) => setT('schedule', { input: e.target.value })} placeholder="optional" /><//>
      </div>` : null}
    </div>
  <//>`;
}
