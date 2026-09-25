import { html, useEffect, useRef, useState } from '../../lib/preact-htm.js';
import { api } from '../api.js';
import { useStore, state, go, toast, toastError, providerName } from '../state.js';
import { Icon, PLUGIN_ICON, PLUGIN_COLOR } from '../icons.js';
import { Avatar, Modal, Field, Toggle, Seg, Empty, confirmDialog, CopyField } from '../ui.js';
import { drawRobot, looks, HAIR_STYLES, ACCESSORIES, SKINS, HAIR_COLORS } from '../world/character.js';
import { BotPreview } from '../world/preview.js';

export const openBuilder = (id = null) => window.dispatchEvent(new CustomEvent('atrium:builder', { detail: { id } }));

const PRESETS = [
  { role: 'Researcher', icon: 'search', instructions: 'You dig up facts. Be precise, cite where information came from, and flag uncertainty. Use web tools when you have them.' },
  { role: 'Writer', icon: 'text', instructions: 'You turn notes into clear, warm, well-structured writing. Keep it tight. Match the requested format and length.' },
  { role: 'Reviewer & QA', icon: 'check', instructions: 'You review work critically: accuracy, clarity, tone and risk. Give a verdict (APPROVE or REVISE) and the top fixes.' },
  { role: 'Team Lead & Coordinator', icon: 'users', instructions: 'You coordinate the team. Break requests into parts, delegate to the right colleagues in parallel, then combine their answers into one clear response.' },
  { role: 'Support Agent', icon: 'chat', instructions: 'You help customers kindly and concisely. Resolve what you can, ask for missing details, and escalate billing or security issues.' },
  { role: 'Data Analyst', icon: 'activity', instructions: 'You analyse data and numbers. Show your working, state assumptions, and summarise the key insight first.' },
];

const HEAD_LABEL = { short: 'Antenna', long: 'Twin antennae', bun: 'Dome', buzz: 'Bolts & fin', curly: 'Coil', none: 'Smooth' };
const GEAR_LABEL = { none: 'None', glasses: 'Visor', headset: 'Headset', cap: 'Crest', beanie: 'Dish' };

function Preview({ draft }) {
  const ref = useRef(); const view = useRef(); const flat = useRef(false);
  const L = looks({ id: draft.id || 'draft', avatar: draft.avatar });
  useEffect(() => {
    const c = ref.current;
    c.style.width = '200px'; c.style.height = '220px';
    try { view.current = new BotPreview(c, L); }
    catch { // no WebGL: draw the 2D robot instead
      flat.current = true;
      const dpr = devicePixelRatio || 1; c.width = 200 * dpr; c.height = 220 * dpr;
      const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawRobot(ctx, L, 100, 190, { s: 3.4, facing: 1, now: 0 });
    }
    return () => view.current?.destroy();
  }, []);
  const key = JSON.stringify([L.color, L.hair, L.accessory, L.skin, L.hairColor]);
  useEffect(() => { view.current?.set(L); if (flat.current) { const ctx = ref.current.getContext('2d'); ctx.clearRect(0, 0, 200, 220); drawRobot(ctx, L, 100, 190, { s: 3.4, facing: 1, now: 0 }); } }, [key]);
  return html`<canvas ref=${ref} aria-hidden="true" data-testid="bot-preview"></canvas>`;
}

export function AgentBuilder({ id, onClose }) {
  const agents = useStore((s) => s.agents);
  const connectors = useStore((s) => s.connectors);
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const colors = useStore((s) => s.colors);
  const existing = id ? agents.find((a) => a.id === id) : null;
  const [draft, setDraft] = useState(() => existing ? structuredClone(existing) : {
    name: '', role: '', instructions: '',
    provider: settings.defaultProvider || 'simulated', model: settings.defaultModel || (settings.defaultProvider === 'anthropic' ? 'claude-sonnet-5' : ''),
    temperature: null, maxSteps: 8, maxTokens: 2048, connectors: [],
    a2a: { enabled: true, allow: 'all' }, memory: { enabled: true },
    avatar: { color: colors[agents.length % colors.length] || '#7C5CFF', hair: HAIR_STYLES[agents.length % 5], accessory: 'none' },
  });
  const [models, setModels] = useState([]);
  const [modelErr, setModelErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState({});
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const setAv = (patch) => setDraft((d) => ({ ...d, avatar: { ...d.avatar, ...patch } }));

  useEffect(() => {
    let dead = false;
    setModels([]); setModelErr('');
    api.get(`/api/providers/${draft.provider}/models`).then((r) => {
      if (dead) return;
      setModels(r.models || []); setModelErr(r.error || '');
      if (!draft.model && r.models?.[0] && draft.provider !== 'openai') set({ model: providers.find((p) => p.id === draft.provider)?.defaultModel || r.models[0].id });
    }).catch(() => {});
    return () => { dead = true; };
  }, [draft.provider]);

  const save = async () => {
    const e = {};
    if (!draft.name.trim()) e.name = 'Give your agent a name.';
    else if (agents.some((a) => a.id !== id && a.name.toLowerCase() === draft.name.trim().toLowerCase())) e.name = 'Another agent already has this name.';
    if (!draft.role.trim()) e.role = 'What does this agent do? e.g. Researcher';
    if (draft.provider === 'openai' && !draft.model) e.model = 'Pick a model for the OpenAI-compatible provider.';
    setErr(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    const body = { name: draft.name.trim(), role: draft.role.trim(), instructions: draft.instructions, provider: draft.provider, model: draft.model, temperature: draft.temperature, maxSteps: draft.maxSteps, maxTokens: draft.maxTokens, connectors: draft.connectors, a2a: draft.a2a, memory: draft.memory, avatar: draft.avatar };
    try {
      const a = id ? await api.patch(`/api/agents/${id}`, body) : await api.post('/api/agents', body);
      toast(id ? `${a.name} updated` : `${a.name} landed in the colony`, 'success');
      onClose(a);
      if (!id) go(`/world/${a.id}`);
    } catch (x) { setErr({ name: x.status === 409 ? x.message : undefined }); toastError(x); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!(await confirmDialog({ title: `Delete ${existing.name}?`, message: 'Their chats and memories are deleted too. This can’t be undone.', confirm: 'Delete agent', danger: true }))) return;
    try { await api.del(`/api/agents/${id}`); toast(`${existing.name} left the colony`); onClose(null); go('/world'); } catch (x) { toastError(x); }
  };

  const others = agents.filter((a) => a.id !== id);
  const allowAll = draft.a2a.allow === 'all' || !draft.a2a.allow;
  const allowList = Array.isArray(draft.a2a.allow) ? draft.a2a.allow : [];
  const prov = providers.find((p) => p.id === draft.provider);

  return html`<${Modal} wide title=${existing ? `Edit ${existing.name}` : 'New agent'} icon=${existing ? 'edit' : 'sparkles'} onClose=${() => onClose(null)} class="builder-modal"
    footer=${html`
      ${existing ? html`<button class="btn danger" onClick=${remove}><${Icon} name="trash" size=${15} />Delete</button>` : null}
      <span class="spacer"></span>
      <button class="btn ghost" onClick=${() => onClose(null)}>Cancel</button>
      <button class="btn primary" onClick=${save} disabled=${saving} data-testid="save-agent">${saving ? 'Saving…' : existing ? 'Save changes' : 'Create agent'}</button>`}>
    <div class="builder">
      <div class="builder-preview" style=${{ '--c': draft.avatar.color }}>
        <${Preview} draft=${draft} />
        <div class="pv-name">${draft.name || 'Unnamed agent'}</div>
        <div class="pv-role">${draft.role || 'Pick a role →'}</div>
        <div class="row wrap" style="justify-content:center;gap:6px">
          <span class="badge">${prov?.name.replace(' (offline)', '') || draft.provider}</span>
          ${draft.connectors.length ? html`<span class="badge blue">${draft.connectors.length} tool${draft.connectors.length > 1 ? 's' : ''}</span>` : null}
          ${draft.a2a.enabled ? html`<span class="badge accent">A2A</span>` : null}
        </div>
      </div>
      <div class="builder-form">
        <div class="form-section">
          <h4><span class="n">1</span>Identity</h4>
          <div class="grid2">
            <${Field} label="Name" error=${err.name} htmlFor="ag-name"><input id="ag-name" class=${`input ${err.name ? 'invalid' : ''}`} maxlength="40" placeholder="e.g. Nova" value=${draft.name} onInput=${(e) => set({ name: e.target.value })} autofocus /><//>
            <${Field} label="Role" error=${err.role} htmlFor="ag-role"><input id="ag-role" class=${`input ${err.role ? 'invalid' : ''}`} placeholder="e.g. Researcher" value=${draft.role} onInput=${(e) => set({ role: e.target.value })} /><//>
          </div>
          <div class="row wrap" style="gap:6px;margin:-4px 0 14px">
            <span class="muted tiny" style="margin-right:2px">Quick roles:</span>
            ${PRESETS.map((p) => html`<button type="button" class=${`chip ${draft.role === p.role ? 'on' : ''}`} onClick=${() => set({ role: p.role, instructions: p.instructions })}><${Icon} name=${p.icon} size=${13} />${p.role}</button>`)}
          </div>
          <div class="grid2">
            <${Field} label="Colour"><div class="swatches">${colors.map((c) => html`<button type="button" class=${`swatch ${draft.avatar.color === c ? 'on' : ''}`} style=${{ background: c, color: c }} aria-label=${`Colour ${c}`} onClick=${() => setAv({ color: c })}></button>`)}</div><//>
            <${Field} label="Shell & light colour"><div class="swatches">
              ${SKINS.map((c) => html`<button type="button" class=${`swatch ${looks(draft).skin === c ? 'on' : ''}`} style=${{ background: c, color: c, width: '20px', height: '20px' }} aria-label="Skin tone" onClick=${() => setAv({ skin: c })}></button>`)}
              <span style="width:6px"></span>
              ${HAIR_COLORS.map((c) => html`<button type="button" class=${`swatch ${looks(draft).hairColor === c ? 'on' : ''}`} style=${{ background: c, color: c, width: '20px', height: '20px' }} aria-label="Hair colour" onClick=${() => setAv({ hairColor: c })}></button>`)}
            </div><//>
          </div>
          <div class="grid2">
            <${Field} label="Head"><div class="row wrap" style="gap:5px">${HAIR_STYLES.map((h) => html`<button type="button" class=${`chip ${draft.avatar.hair === h ? 'on' : ''}`} onClick=${() => setAv({ hair: h })} data-value=${h}>${HEAD_LABEL[h] || h}</button>`)}</div><//>
            <${Field} label="Gear"><div class="row wrap" style="gap:5px">${ACCESSORIES.map((h) => html`<button type="button" class=${`chip ${draft.avatar.accessory === h ? 'on' : ''}`} onClick=${() => setAv({ accessory: h })} data-value=${h}>${GEAR_LABEL[h] || h}</button>`)}</div><//>
          </div>
        </div>

        <div class="form-section">
          <h4><span class="n">2</span>Brain</h4>
          <${Field} label="Model provider">
            <${Seg} label="Model provider" value=${draft.provider} onChange=${(v) => set({ provider: v, model: '' })} options=${providers.map((p) => ({ value: p.id, label: p.id === 'anthropic' ? 'Claude' : p.id === 'openai' ? 'OpenAI-compatible' : 'Simulated', icon: p.id === 'simulated' ? 'sparkles' : 'brain' }))} />
          <//>
          ${prov && !prov.configured ? html`<div class="callout amber" style="margin:-4px 0 14px;font-size:12.5px"><${Icon} name="key" size=${15} /><div>No ${prov.name} key yet. You can still create the agent; add the key in <a href="#/settings" onClick=${() => onClose(null)}>Settings</a> before chatting.</div></div>` : null}
          ${draft.provider === 'simulated' ? html`<div class="callout" style="margin:-4px 0 14px;font-size:12.5px"><${Icon} name="info" size=${15} /><div>The Simulated brain works offline and shows how the system behaves (delegation, tools, workflows), but its answers are templates. Switch to Claude or OpenAI for real reasoning.</div></div>` : html`
          <div class="grid2">
            <${Field} label="Model" error=${err.model || modelErr} htmlFor="ag-model" help=${models.length ? `${models.length} models available` : 'Type a model id'}>
              <input id="ag-model" class="input mono" list="model-list" value=${draft.model} placeholder=${prov?.defaultModel || 'model id'} onInput=${(e) => set({ model: e.target.value })} />
              <datalist id="model-list">${models.map((m) => html`<option value=${m.id}>${m.name}</option>`)}</datalist>
            <//>
            <${Field} label=${html`Temperature <span class="muted tiny">${draft.temperature == null ? 'default' : draft.temperature}</span>`} help="Leave on default for newer reasoning models.">
              <div class="row"><input type="range" min="0" max="1" step="0.1" class="grow" value=${draft.temperature ?? 0.7} onInput=${(e) => set({ temperature: Number(e.target.value) })} aria-label="Temperature" />
              <button type="button" class="btn xs ghost" onClick=${() => set({ temperature: null })}>Reset</button></div>
            <//>
          </div>`}
          <div class="grid2">
            <${Field} label="Max tool steps per task" help="How many tool/delegation rounds before it must answer."><input class="input" type="number" min="1" max="30" value=${draft.maxSteps} onInput=${(e) => set({ maxSteps: Number(e.target.value) })} /><//>
            <${Field} label="Max output tokens"><input class="input" type="number" min="64" max="64000" step="256" value=${draft.maxTokens} onInput=${(e) => set({ maxTokens: Number(e.target.value) })} /><//>
          </div>
        </div>

        <div class="form-section">
          <h4><span class="n">3</span>Personality & instructions</h4>
          <${Field} help="How this agent should think, talk and work. It already knows its name, role and colleagues.">
            <textarea class="textarea" rows="5" placeholder="e.g. You are a meticulous researcher. Always cite sources…" value=${draft.instructions} onInput=${(e) => set({ instructions: e.target.value })} aria-label="Instructions"></textarea>
          <//>
        </div>

        <div class="form-section">
          <h4><span class="n">4</span>Tools & connectors</h4>
          ${connectors.length ? html`<div class="opt-grid">
            ${connectors.map((c) => {
              const on = draft.connectors.includes(c.id);
              return html`<button type="button" class=${`opt-card ${on ? 'on' : ''}`} onClick=${() => set({ connectors: on ? draft.connectors.filter((x) => x !== c.id) : [...draft.connectors, c.id] })} aria-pressed=${on}>
                <span class="check">${on ? html`<${Icon} name="check" size=${12} stroke=${3} />` : null}</span>
                <div style="min-width:0"><div class="t row" style="gap:6px"><${Icon} name=${PLUGIN_ICON[c.pluginId] || 'plug'} size=${13} style=${{ color: PLUGIN_COLOR[c.pluginId] }} />${c.name}</div><div class="d">${c.pluginName}${c.tools ? ` · ${c.tools.length} tools` : ''}</div></div>
              </button>`;
            })}
          </div>` : html`<p class="muted small" style="margin:0 0 10px">No connectors yet.</p>`}
          <button type="button" class="btn sm ghost" style="margin-top:8px" onClick=${() => { onClose(null); go('/connectors'); }}><${Icon} name="plus" size=${14} />Add a connector (MCP, web, Laya…)</button>
          <div class="row" style="margin:14px 0 4px;gap:12px">
            <${Toggle} on=${draft.memory.enabled} onChange=${(v) => set({ memory: { enabled: v } })} label="Long-term memory" id="tg-mem" />
            <label for="tg-mem" class="grow"><div class="bold small">Long-term memory</div><div class="muted tiny">Can save and recall notes across conversations.</div></label>
          </div>
        </div>

        <div class="form-section">
          <h4><span class="n">5</span>Collaboration (A2A)</h4>
          <div class="row" style="gap:12px;margin-bottom:12px">
            <${Toggle} on=${draft.a2a.enabled} onChange=${(v) => set({ a2a: { ...draft.a2a, enabled: v } })} label="Can message colleagues" id="tg-a2a" />
            <label for="tg-a2a" class="grow"><div class="bold small">Can message other agents</div><div class="muted tiny">Delegates, asks questions and works with colleagues in parallel. Off = single-agent mode.</div></label>
          </div>
          ${draft.a2a.enabled ? html`
            <${Seg} label="Who can it talk to" value=${allowAll ? 'all' : 'some'} onChange=${(v) => set({ a2a: { ...draft.a2a, allow: v === 'all' ? 'all' : allowList } })} options=${[{ value: 'all', label: 'Everyone' }, { value: 'some', label: 'Only selected' }]} />
            ${!allowAll ? html`<div class="row wrap" style="gap:6px;margin-top:10px">
              ${others.length ? others.map((a) => { const on = allowList.includes(a.id); return html`<button type="button" class=${`chip ${on ? 'on' : ''}`} onClick=${() => set({ a2a: { ...draft.a2a, allow: on ? allowList.filter((x) => x !== a.id) : [...allowList, a.id] } })}><${Avatar} agent=${a} size=${18} radius=${6} />${a.name}</button>`; }) : html`<span class="muted small">No other agents yet.</span>`}
            </div>` : null}` : null}
          ${existing ? html`<div style="margin-top:16px"><${Field} label="A2A agent card" help="Other A2A-compatible agents and apps can reach this agent here."><${CopyField} value=${`${location.origin}/a2a/${existing.id}/.well-known/agent-card.json`} /><//></div>` : null}
        </div>
      </div>
    </div>
  <//>`;
}

export function BuilderHost() {
  const [open, setOpen] = useState(null);
  useEffect(() => { const fn = (e) => setOpen({ id: e.detail?.id || null, k: Date.now() }); addEventListener('atrium:builder', fn); return () => removeEventListener('atrium:builder', fn); }, []);
  if (!open) return null;
  return html`<${AgentBuilder} key=${open.k} id=${open.id} onClose=${() => setOpen(null)} />`;
}

export function AgentsPage() {
  const agents = useStore((s) => s.agents);
  const busy = useStore((s) => s.busy);
  const connectors = useStore((s) => s.connectors);
  const [q, setQ] = useState('');
  const list = agents.filter((a) => !q || `${a.name} ${a.role}`.toLowerCase().includes(q.toLowerCase()));
  const dup = async (a) => {
    let name = `${a.name} 2`; let i = 2;
    while (agents.some((x) => x.name.toLowerCase() === name.toLowerCase())) name = `${a.name} ${++i}`;
    try { const n = await api.post('/api/agents', { ...a, name, id: undefined }); toast(`Duplicated as ${n.name}`, 'success'); } catch (e) { toastError(e); }
  };
  return html`<div class="page-scroll"><div class="page-inner">
    <div class="row between" style="margin-bottom:20px;align-items:flex-end">
      <div><h2 class="page-h">Agents</h2><p class="page-sub" style="margin:0">Build your team. Each agent gets its own plot in the colony, and its habitat grows as it finishes work.</p></div>
      <div class="row">
        <input class="input" style="width:220px" placeholder="Filter agents…" value=${q} onInput=${(e) => setQ(e.target.value)} aria-label="Filter agents" />
        <button class="btn primary" onClick=${() => openBuilder()} data-testid="agents-new"><${Icon} name="plus" size=${15} />New agent</button>
      </div>
    </div>
    ${!agents.length ? html`<div class="card"><${Empty} icon="users" title="No agents yet" action=${html`<button class="btn primary" onClick=${() => openBuilder()}>Create an agent</button>`}>Agents are AI teammates with a name, a role and tools. They can work alone or together.<//></div>` : html`
    <div class="agent-grid">
      ${list.map((a) => html`<div class="card agent-card hoverable" key=${a.id} style=${{ '--c': a.avatar?.color }} onClick=${() => go(`/world/${a.id}`)} data-testid=${`agent-card-${a.name}`}>
        <div class="top">
          <${Avatar} agent=${a} size=${52} busy=${busy[a.id] > 0} />
          <div class="grow" style="min-width:0"><div class="n ellipsis">${a.name}</div><div class="r ellipsis">${a.role}</div></div>
        </div>
        <div class="desc">${a.instructions || 'No special instructions.'}</div>
        <div class="row wrap" style="gap:6px">
          <span class="badge">${a.provider === 'simulated' ? 'Simulated' : `${providerName(a.provider).replace(' (Claude)', '')}${a.model ? ` · ${a.model}` : ''}`}</span>
          ${(a.connectors || []).map((cid) => { const c = connectors.find((x) => x.id === cid); return c ? html`<span class="badge" title=${c.pluginName}><${Icon} name=${PLUGIN_ICON[c.pluginId] || 'plug'} size=${11} style=${{ color: PLUGIN_COLOR[c.pluginId] }} />${c.name}</span>` : null; })}
          ${a.a2a?.enabled ? html`<span class="badge accent">A2A</span>` : html`<span class="badge">Solo</span>`}
        </div>
        <div class="row between">
          <div class="stats"><span><b>${a.stats?.tasks || 0}</b> tasks</span><span><b>${fmt((a.stats?.tokensIn || 0) + (a.stats?.tokensOut || 0))}</b> tokens</span></div>
          <div class="actions" onClick=${(e) => e.stopPropagation()}>
            <button class="btn xs" onClick=${() => go(`/world/${a.id}`)}><${Icon} name="chat" size=${12} />Chat</button>
            <button class="btn xs icon" title="Edit" aria-label=${`Edit ${a.name}`} onClick=${() => openBuilder(a.id)}><${Icon} name="edit" size=${12} /></button>
            <button class="btn xs icon" title="Duplicate" aria-label=${`Duplicate ${a.name}`} onClick=${() => dup(a)}><${Icon} name="copy" size=${12} /></button>
          </div>
        </div>
      </div>`)}
      <button class="new-card" onClick=${() => openBuilder()}><${Icon} name="plus" size=${22} /><b>New agent</b><span class="small muted">Name it, give it a job, plug in tools</span></button>
    </div>`}
  </div></div>`;
}

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
