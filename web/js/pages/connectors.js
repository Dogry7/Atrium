import { html, useEffect, useState } from '../../lib/preact-htm.js';
import { api } from '../api.js';
import { useStore, toast, toastError } from '../state.js';
import { Icon, PLUGIN_ICON, PLUGIN_COLOR } from '../icons.js';
import { Modal, Field, ConfigForm, Empty, StatusBadge, confirmDialog, Toggle, Avatar } from '../ui.js';

const MCP_PRESETS = [
  { name: 'Everything (MCP demo)', config: { transport: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-everything' }, note: 'Reference server with test tools: echo, add, …' },
  { name: 'Filesystem', config: { transport: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-filesystem ~/Documents' }, note: 'Read/write files in a folder you choose.' },
  { name: 'GitHub', config: { transport: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-github', env: '{"GITHUB_PERSONAL_ACCESS_TOKEN": ""}' }, note: 'Issues, PRs, repos. Needs a token.' },
  { name: 'Laya (MCP)', config: { transport: 'stdio', command: 'laya-mcp-server', env: '{"LAYA_DEVICE": "cpu"}' }, note: 'pip install "laya[mcp]". Tools: laya_predict, laya_route…' },
  { name: 'Remote MCP (HTTP)', config: { transport: 'http', url: 'https://', headers: '{"Authorization": "Bearer "}' }, note: 'Any hosted Streamable-HTTP MCP server.' },
];

export function ConnectorsPage() {
  const connectors = useStore((s) => s.connectors);
  const types = useStore((s) => s.pluginTypes);
  const pluginErrors = useStore((s) => s.pluginErrors);
  const agents = useStore((s) => s.agents);
  const [editing, setEditing] = useState(null); // {pluginId, connector?, preset?}
  const [explore, setExplore] = useState(null);
  const [testing, setTesting] = useState({});

  const test = async (c) => {
    setTesting((t) => ({ ...t, [c.id]: true }));
    try {
      const r = await api.post(`/api/connectors/${c.id}/test`);
      toast(r.ok ? `${c.name}: ${r.message}` : `${c.name}: ${r.message}`, r.ok ? 'success' : 'error', r.ok ? 3500 : 8000);
    } catch (e) { toastError(e); }
    finally { setTesting((t) => ({ ...t, [c.id]: false })); }
  };
  const remove = async (c) => {
    const users = agents.filter((a) => a.connectors?.includes(c.id));
    if (!(await confirmDialog({ title: `Remove ${c.name}?`, message: users.length ? `${users.map((a) => a.name).join(', ')} will lose access to its tools.` : 'No agents use it.', confirm: 'Remove', danger: true }))) return;
    await api.del(`/api/connectors/${c.id}`).catch(toastError);
  };
  const reload = async () => { try { const r = await api.post('/api/plugins/reload'); toast(`Reloaded plugins: ${r.types.length} available${r.errors.length ? `, ${r.errors.length} failed` : ''}`, r.errors.length ? 'error' : 'success'); } catch (e) { toastError(e); } };

  return html`<div class="page-scroll"><div class="page-inner">
    <h2 class="page-h">Connectors</h2>
    <p class="page-sub">Plug tools, apps, models and other agents into your team. Each connector is an instance of a plugin; give it to any agent in the agent editor.</p>

    <div class="section-title">Your connectors</div>
    ${connectors.length ? html`<div class="conn-grid" style="margin-bottom:34px">
      ${connectors.map((c) => {
        const users = agents.filter((a) => a.connectors?.includes(c.id));
        const toolCount = c.tools?.length ?? c.toolNames?.length;
        return html`<div class="card conn-card" key=${c.id} data-testid=${`conn-${c.name}`}>
          <div class="row" style="gap:12px">
            <div class="conn-icon" style=${{ background: (PLUGIN_COLOR[c.pluginId] || '#7c5cff') + '22', color: PLUGIN_COLOR[c.pluginId] || 'var(--accent-text)' }}><${Icon} name=${PLUGIN_ICON[c.pluginId] || 'plug'} size=${19} /></div>
            <div class="grow" style="min-width:0"><div class="bold ellipsis">${c.name}</div><div class="muted small">${c.pluginName}</div></div>
            <${StatusBadge} status=${c.enabled === false ? 'disabled' : c.status} />
          </div>
          ${c.error ? html`<div class="problem err small"><${Icon} name="alert" size=${14} style="flex:none;margin-top:2px" /><span style="overflow-wrap:anywhere">${c.error}</span></div>` : null}
          <div class="row small dim" style="gap:14px">
            <span><${Icon} name="tool" size=${13} /> ${toolCount != null ? `${toolCount} tool${toolCount === 1 ? '' : 's'}` : 'tools load on first use'}</span>
            <span class="row" style="gap:4px">${users.length ? html`${users.slice(0, 5).map((a) => html`<${Avatar} agent=${a} size=${20} radius=${6} />`)}<span class="muted">${users.length} agent${users.length > 1 ? 's' : ''}</span>` : html`<span class="muted">no agents yet</span>`}</span>
          </div>
          <div class="row" style="gap:6px">
            <button class="btn sm" onClick=${() => test(c)} disabled=${testing[c.id]} data-testid=${`test-${c.name}`}>${testing[c.id] ? html`<span class="spinner"></span>Testing…` : html`<${Icon} name="refresh" size=${13} />Test`}</button>
            <button class="btn sm" onClick=${() => setExplore(c)}><${Icon} name="tool" size=${13} />Tools</button>
            <span class="spacer"></span>
            <button class="btn sm icon ghost" title="Edit" aria-label=${`Edit ${c.name}`} onClick=${() => setEditing({ pluginId: c.pluginId, connector: c })}><${Icon} name="edit" size=${14} /></button>
            <button class="btn sm icon ghost danger" title="Remove" aria-label=${`Remove ${c.name}`} onClick=${() => remove(c)}><${Icon} name="trash" size=${14} /></button>
          </div>
        </div>`;
      })}
    </div>` : html`<div class="card" style="margin-bottom:34px"><${Empty} icon="plug" title="No connectors yet">Add one below, e.g. an MCP server or the Laya decision model.<//></div>`}

    <div class="row between"><div class="section-title">Add a connector</div><button class="btn xs ghost" onClick=${reload} title="Rescan the plugins/ folder"><${Icon} name="refresh" size=${12} />Reload plugins</button></div>
    <div class="type-grid" style="margin-bottom:14px">
      ${types.map((t) => html`<button class="card type-card hoverable" key=${t.id} onClick=${() => setEditing({ pluginId: t.id })} data-testid=${`add-plugin-${t.id}`}>
        <div class="row" style="gap:10px"><div class="conn-icon" style=${{ width: '34px', height: '34px', background: (PLUGIN_COLOR[t.id] || '#7c5cff') + '22', color: PLUGIN_COLOR[t.id] || 'var(--accent-text)' }}><${Icon} name=${PLUGIN_ICON[t.id] || t.icon || 'plug'} size=${17} /></div>
        <div class="t grow">${t.name}</div>${t.builtin ? null : html`<span class="badge blue">plugin</span>`}</div>
        <div class="d">${t.description}</div>
      </button>`)}
    </div>
    ${pluginErrors?.length ? html`<div class="problems" style="margin-bottom:14px">${pluginErrors.map((e) => html`<div class="problem err"><${Icon} name="alert" size=${14} style="flex:none;margin-top:2px" /><span><b>plugins/${e.plugin}</b>: ${e.error}</span></div>`)}</div>` : null}
    <div class="callout"><${Icon} name="info" size=${16} /><div><b>Build your own plugin:</b> drop a folder with an <code>index.js</code> into <code>plugins/</code> and press “Reload plugins”. See <code>plugins/example-toolkit</code> for a working template.</div></div>

    ${editing ? html`<${ConnectorEditor} ...${editing} onClose=${() => setEditing(null)} />` : null}
    ${explore ? html`<${ToolExplorer} connector=${explore} onClose=${() => setExplore(null)} />` : null}
  </div></div>`;
}

function ConnectorEditor({ pluginId, connector, onClose }) {
  const types = useStore((s) => s.pluginTypes);
  const agents = useStore((s) => s.agents);
  const type = types.find((t) => t.id === pluginId);
  const [name, setName] = useState(connector?.name || (pluginId === 'laya' ? 'Laya' : pluginId === 'web' ? 'Web' : pluginId === 'mcp' || pluginId === 'a2a-remote' ? '' : type?.name || ''));
  const [config, setConfig] = useState(connector ? { ...connector.config } : Object.fromEntries((type?.configFields || []).filter((f) => f.default !== undefined).map((f) => [f.key, f.default])));
  const [giveTo, setGiveTo] = useState([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  if (!type) return null;

  const save = async (andTest = true) => {
    const missing = (type.configFields || []).filter((f) => f.required && !String(config[f.key] ?? '').trim());
    if (!name.trim()) return toast(pluginId === 'mcp' ? 'Give the connector a name, or pick a preset' : 'Give the connector a name', 'error');
    if (missing.length) return toast(`Fill in: ${missing.map((f) => f.label).join(', ')}`, 'error');
    for (const f of type.configFields) if (f.type === 'json' && typeof config[f.key] === 'string' && config[f.key].trim()) {
      try { JSON.parse(config[f.key]); } catch { return toast(`${f.label} must be valid JSON`, 'error'); }
    }
    setBusy(true); setResult(null);
    try {
      const c = connector ? await api.patch(`/api/connectors/${connector.id}`, { name, config }) : await api.post('/api/connectors', { pluginId, name, config });
      for (const aid of giveTo) {
        const a = agents.find((x) => x.id === aid);
        if (a && !a.connectors?.includes(c.id)) await api.patch(`/api/agents/${aid}`, { connectors: [...(a.connectors || []), c.id] });
      }
      if (andTest) {
        const r = await api.post(`/api/connectors/${c.id}/test`);
        setResult(r);
        if (r.ok) { toast(`${name} connected: ${r.message}`, 'success'); onClose(); }
      } else onClose();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };

  return html`<${Modal} title=${connector ? `Edit ${connector.name}` : `Add ${type.name}`} icon=${PLUGIN_ICON[pluginId] || 'plug'} onClose=${onClose} footer=${html`
      ${result && !result.ok ? html`<button class="btn ghost" onClick=${onClose}>Keep & close</button>` : html`<button class="btn ghost" onClick=${onClose}>Cancel</button>`}
      <button class="btn primary" onClick=${() => save(true)} disabled=${busy} data-testid="save-connector">${busy ? html`<span class="spinner"></span>Connecting…` : connector ? 'Save & test' : 'Add & test'}</button>`}>
    <div class="modal-body">
      <p class="small dim" style="margin-top:0">${type.description}</p>
      ${pluginId === 'mcp' && !connector ? html`<${Field} label="Start from a preset"><div class="row wrap" style="gap:6px">${MCP_PRESETS.map((p) => html`<button type="button" class="chip" title=${p.note} onClick=${() => { setName(p.name.replace(' (MCP demo)', '')); setConfig({ ...config, ...p.config }); }}>${p.name}</button>`)}</div><//>` : null}
      ${pluginId === 'laya' ? html`<div class="callout" style="margin-bottom:16px;font-size:12.5px"><${Icon} name="bolt" size=${15} /><div><b>Run Laya locally:</b><br /><code>pip install "laya[serve]"</code><br /><code>LAYA_PRELOAD=1 laya-serve</code> (serves on :8000, first run downloads ~0.8GB of weights)</div></div>` : null}
      <${Field} label="Name" htmlFor="con-name"><input id="con-name" class="input" value=${name} onInput=${(e) => setName(e.target.value)} placeholder=${type.name} autofocus /><//>
      <${ConfigForm} fields=${type.configFields} value=${config} onChange=${setConfig} />
      ${!connector && agents.length ? html`<${Field} label="Give it to" help="You can change this later in each agent’s settings."><div class="row wrap" style="gap:6px">${agents.map((a) => { const on = giveTo.includes(a.id); return html`<button type="button" class=${`chip ${on ? 'on' : ''}`} onClick=${() => setGiveTo(on ? giveTo.filter((x) => x !== a.id) : [...giveTo, a.id])}><${Avatar} agent=${a} size=${18} radius=${6} />${a.name}</button>`; })}</div><//>` : null}
      ${result ? html`<div class=${`problem ${result.ok ? '' : 'err'}`} style="margin-top:6px"><${Icon} name=${result.ok ? 'ok' : 'alert'} size=${14} style="flex:none;margin-top:2px" /><span style="overflow-wrap:anywhere">${result.message}</span></div>` : null}
    </div>
  <//>`;
}

function ToolExplorer({ connector, onClose }) {
  const [tools, setTools] = useState(connector.tools || null);
  const [err, setErr] = useState('');
  const [active, setActive] = useState(null);
  const [args, setArgs] = useState('{}');
  const [res, setRes] = useState(null);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (tools) return;
    api.post(`/api/connectors/${connector.id}/test`).then((r) => { if (r.ok) setTools(r.tools); else setErr(r.message); }).catch((e) => setErr(e.message));
  }, []);
  const pick = (t) => {
    setActive(t); setRes(null);
    const sk = {};
    for (const [k, p] of Object.entries(t.inputSchema?.properties || {})) if ((t.inputSchema.required || []).includes(k)) sk[k] = p.type === 'number' || p.type === 'integer' ? 1 : p.type === 'boolean' ? true : p.enum ? p.enum[0] : '';
    setArgs(JSON.stringify(sk, null, 2));
  };
  const run = async () => {
    let a; try { a = JSON.parse(args || '{}'); } catch { return toast('Arguments must be valid JSON', 'error'); }
    setRunning(true);
    try { setRes(await api.post(`/api/connectors/${connector.id}/tools/${encodeURIComponent(active.name)}`, { args: a })); }
    catch (e) { setRes({ ok: false, error: e.message }); } finally { setRunning(false); }
  };
  return html`<${Modal} wide title=${`${connector.name} · tools`} icon="tool" onClose=${onClose}>
    <div class="modal-body" style="display:grid;grid-template-columns:280px 1fr;gap:18px;min-height:360px">
      <div class="tool-list" style="max-height:60vh;overflow:auto">
        ${err ? html`<div class="problem err"><span>${err}</span></div>` : !tools ? html`<div class="row dim small"><span class="spinner"></span>Connecting…</div>` : !tools.length ? html`<div class="muted small">This connector has no tools.</div>`
          : tools.map((t) => html`<button class="tool-row" style=${{ textAlign: 'left', cursor: 'pointer', borderColor: active?.name === t.name ? 'var(--accent)' : undefined }} onClick=${() => pick(t)}><div class="tn">${t.name}</div><div class="td">${t.description}</div></button>`)}
      </div>
      <div>
        ${active ? html`
          <div class="bold mono" style="margin-bottom:4px">${active.name}</div>
          <p class="small dim" style="margin-top:0">${active.description}</p>
          <${Field} label="Arguments (JSON)"><textarea class="textarea mono" rows="6" value=${args} onInput=${(e) => setArgs(e.target.value)}></textarea><//>
          <button class="btn primary sm" onClick=${run} disabled=${running} data-testid="tool-run">${running ? html`<span class="spinner"></span>Running…` : html`<${Icon} name="play" size=${13} />Run tool`}</button>
          ${res ? html`<div style="margin-top:14px"><div class="row small" style="margin-bottom:6px">${res.ok ? html`<span class="badge green">OK</span>` : html`<span class="badge red">Error</span>`}<span class="muted tiny">${res.ms != null ? `${res.ms}ms` : ''}</span></div>
            <div class="result-box" data-testid="tool-result">${res.ok ? (typeof res.result === 'string' ? res.result : JSON.stringify(res.result, null, 2)) : res.error}</div></div>` : null}`
          : html`<${Empty} icon="tool" title="Pick a tool">Try any tool by hand before you give it to an agent.<//>`}
      </div>
    </div>
  <//>`;
}
