import { html, useState } from '../../lib/preact-htm.js';
import { api } from '../api.js';
import { useStore, go, timeAgo, toastError } from '../state.js';
import { Icon } from '../icons.js';
import { Avatar, Empty, StatusBadge, Seg } from '../ui.js';
import { markdown } from '../markdown.js';

const fromLabel = (t) => t.from?.type === 'agent' ? `from ${t.from.name}` : t.from?.type === 'workflow' ? `workflow “${t.from.name}”` : t.from?.type === 'external' ? `A2A · ${t.from.name}` : 'from you';

function TaskNode({ t, all, depth = 0 }) {
  const agents = useStore((s) => s.agents);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const a = agents.find((x) => x.id === t.agentId);
  const kids = all.filter((c) => c.parentTaskId === t.id);
  const toggle = async () => {
    const next = !open; setOpen(next);
    if (next && !detail) { try { setDetail(await api.get(`/api/tasks/${t.id}`)); } catch (e) { toastError(e); } }
  };
  return html`<div class=${depth ? '' : 'card tl-item'} style=${depth ? 'padding:4px 0' : ''}>
    <div class="head" style="cursor:pointer" onClick=${toggle} role="button" tabindex="0" aria-expanded=${open}>
      ${a ? html`<${Avatar} agent=${a} size=${28} radius=${9} />` : html`<div class="avatar" style="width:28px;height:28px"></div>`}
      <div class="grow" style="min-width:0">
        <div class="row small" style="gap:8px"><b>${t.agentName}</b><span class="muted">${fromLabel(t)}</span></div>
        <div class="small dim ellipsis">${t.input}</div>
      </div>
      ${kids.length ? html`<span class="badge accent">${kids.length} handoff${kids.length > 1 ? 's' : ''}</span>` : null}
      <${StatusBadge} status=${t.status.state} />
      <span class="muted tiny nowrap" style="width:64px;text-align:right">${timeAgo(t.createdAt)}</span>
      <${Icon} name=${open ? 'chevronDown' : 'chevronRight'} size=${14} />
    </div>
    ${open ? html`<div class="io">
      <div><div class="tiny muted bold" style="margin-bottom:4px">INPUT</div>${detail?.input ?? t.input}</div>
      <div class="md">${t.status.state === 'failed' ? html`<span style="color:var(--red)">${t.status.message}</span>` : html`<div class="tiny muted bold" style="margin-bottom:4px">OUTPUT</div><div dangerouslySetInnerHTML=${{ __html: markdown(detail?.artifacts?.[0]?.text || t.output || '…') }}></div>`}</div>
    </div>
    ${detail?.steps?.length ? html`<div class="row wrap small" style="gap:6px;margin-top:8px">${detail.steps.map((s) => html`<span class=${`badge ${s.ok ? '' : 'red'}`}><${Icon} name=${s.tool === 'message_agent' ? 'chat' : 'tool'} size=${11} />${s.tool === 'message_agent' ? `→ ${s.input?.agent}` : s.tool.split('__').pop()} · ${s.ms}ms</span>`)}</div>` : null}
    ${detail?.usage && (detail.usage.input || detail.usage.output) ? html`<div class="muted tiny" style="margin-top:6px">${detail.usage.input} in · ${detail.usage.output} out tokens</div>` : null}` : null}
    ${kids.length ? html`<div class="tl-children">${kids.map((k) => html`<${TaskNode} key=${k.id} t=${k} all=${all} depth=${depth + 1} />`)}</div>` : null}
  </div>`;
}

export function ActivityPage() {
  const tasks = useStore((s) => s.tasks);
  const runs = useStore((s) => s.runs);
  const agents = useStore((s) => s.agents);
  const [kind, setKind] = useState('all');
  const [agentId, setAgentId] = useState('');
  let roots = tasks.filter((t) => !t.parentTaskId || !tasks.some((p) => p.id === t.parentTaskId));
  if (kind === 'chat') roots = roots.filter((t) => t.from?.type === 'user');
  if (kind === 'a2a') roots = roots.filter((t) => tasks.some((c) => c.parentTaskId === t.id) || t.from?.type === 'external');
  if (kind === 'workflow') roots = roots.filter((t) => t.from?.type === 'workflow');
  if (agentId) roots = roots.filter((t) => t.agentId === agentId || tasks.some((c) => c.parentTaskId === t.id && c.agentId === agentId));
  roots = roots.slice(-80).reverse();
  const recentRuns = runs.slice(-12).reverse();
  return html`<div class="page-scroll"><div class="page-inner">
    <h2 class="page-h">Activity</h2>
    <p class="page-sub">Every task, handoff and workflow run. Handoffs between agents (A2A) are nested under the task that started them.</p>
    ${recentRuns.length ? html`<div class="section-title">Workflow runs</div>
    <div class="col" style="gap:6px;margin-bottom:26px">${recentRuns.map((r) => html`<div class="card row" style="padding:10px 14px;cursor:pointer" key=${r.id} onClick=${() => go(`/workflows/${r.workflowId}`)}>
      <${Icon} name="flow" size=${15} style="color:var(--amber)" /><b class="small">${r.workflowName}</b><span class="muted small">${r.trigger}</span>
      <span class="grow small dim ellipsis">${r.status === 'failed' ? r.error : r.output ? String(typeof r.output === 'string' ? r.output : JSON.stringify(r.output)).replace(/\s+/g, ' ').slice(0, 120) : ''}</span>
      <${StatusBadge} status=${r.status} /><span class="muted tiny nowrap">${timeAgo(r.startedAt)}</span>
    </div>`)}</div>` : null}
    <div class="filters">
      <div class="section-title" style="margin:0 8px 0 0">Tasks</div>
      <${Seg} value=${kind} onChange=${setKind} label="Filter" options=${[{ value: 'all', label: 'All' }, { value: 'chat', label: 'Chats' }, { value: 'a2a', label: 'A2A' }, { value: 'workflow', label: 'Workflows' }]} />
      <select class="select" style="width:180px;height:32px" value=${agentId} onChange=${(e) => setAgentId(e.target.value)} aria-label="Filter by agent"><option value="">All agents</option>${agents.map((a) => html`<option value=${a.id}>${a.name}</option>`)}</select>
    </div>
    ${roots.length ? html`<div class="timeline">${roots.map((t) => html`<${TaskNode} key=${t.id} t=${t} all=${tasks} />`)}</div>`
      : html`<div class="card"><${Empty} icon="activity" title="Nothing here yet">Chat with an agent or run a workflow and it will appear here.<//></div>`}
  </div></div>`;
}
