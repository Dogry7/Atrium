import { html, useEffect, useState } from '../../lib/preact-htm.js';
import { api } from '../api.js';
import { useStore, toast, toastError, applyTheme, state, worldPrefs, setWorldPref } from '../state.js';
import { PLANETS, PLANET_IDS } from '../world/colony.js';
import { Icon } from '../icons.js';
import { Field, Toggle, Seg, CopyField, ConfigForm, confirmDialog } from '../ui.js';

export function SettingsPage() {
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const agents = useStore((s) => s.agents);
  const worldSettings = useStore((s) => s.settings?.world);
  const wp = worldPrefs({ settings: { world: worldSettings } });
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [testing, setTesting] = useState({});
  const [results, setResults] = useState({});
  useEffect(() => { setDraft(structuredClone(settings)); }, [settings]);

  const save = async (patch, msg = 'Saved') => {
    try { await api.patch('/api/settings', patch); toast(msg, 'success', 2000); }
    catch (e) { toastError(e); }
  };
  const testProvider = async (p) => {
    setTesting((t) => ({ ...t, [p.id]: true }));
    try {
      await api.patch('/api/settings', { providers: { [p.id]: draft.providers?.[p.id] || {} } });
      const r = await api.post(`/api/providers/${p.id}/test`);
      setResults((x) => ({ ...x, [p.id]: r }));
    } catch (e) { setResults((x) => ({ ...x, [p.id]: { ok: false, message: e.message } })); }
    finally { setTesting((t) => ({ ...t, [p.id]: false })); }
  };
  const switchAll = async (provider, model) => {
    if (!(await confirmDialog({ title: `Switch all agents to ${provider === 'anthropic' ? 'Claude' : 'OpenAI-compatible'}?`, message: `All ${agents.length} agents will use ${model || 'the default model'}. You can still change individual agents later.`, confirm: 'Switch all' }))) return;
    try {
      for (const a of agents) await api.patch(`/api/agents/${a.id}`, { provider, model });
      await api.patch('/api/settings', { defaultProvider: provider, defaultModel: model });
      toast('All agents switched', 'success');
    } catch (e) { toastError(e); }
  };
  const importFile = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try { const j = JSON.parse(await f.text()); const r = await api.post('/api/import', j); toast(`Imported ${Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(', ')}`, 'success'); }
    catch (x) { toastError(x); }
    e.target.value = '';
  };

  const origin = location.origin;
  const setP = (pid, v) => setDraft((d) => ({ ...d, providers: { ...d.providers, [pid]: v } }));
  const a2a = draft.a2a || {};
  const nav = [['profile', 'Profile'], ['providers', 'AI providers'], ['a2a', 'A2A server'], ['access', 'CLI & MCP'], ['appearance', 'Appearance'], ['data', 'Data']];

  return html`<div class="page-scroll"><div class="page-inner">
    <h2 class="page-h">Settings</h2>
    <p class="page-sub">Everything is stored locally in the <code>data/</code> folder next to Atrium.</p>
    <div class="settings-grid">
      <nav class="settings-nav" aria-label="Settings sections">${nav.map(([id, l]) => html`<a href=${`#/settings`} onClick=${(e) => { e.preventDefault(); document.getElementById(`s-${id}`)?.scrollIntoView({ behavior: 'smooth' }); }}>${l}</a>`)}</nav>
      <div>
        <section class="card settings-card" id="s-profile">
          <h3>Profile</h3><p>What your agents call you.</p>
          <div class="row" style="align-items:flex-end">
            <${Field} label="Your name"><input class="input" value=${draft.userName || ''} onInput=${(e) => setDraft({ ...draft, userName: e.target.value })} style="width:260px" /><//>
            <button class="btn" style="margin-bottom:16px" onClick=${() => save({ userName: draft.userName })}>Save</button>
          </div>
        </section>

        <section class="card settings-card" id="s-providers">
          <h3>AI providers</h3><p>Keys stay on this machine. Agents choose their provider in the agent editor.</p>
          ${providers.filter((p) => p.id !== 'simulated').map((p) => html`<div class="card" style="padding:16px;margin-bottom:12px;background:var(--bg-2)" key=${p.id}>
            <div class="row" style="margin-bottom:12px"><${Icon} name="brain" size=${17} /><b class="grow">${p.name}</b>${p.configured ? html`<span class="badge green">configured</span>` : html`<span class="badge">not set</span>`}</div>
            <${ConfigForm} fields=${p.configFields} value=${draft.providers?.[p.id] || {}} onChange=${(v) => setP(p.id, v)} idPrefix=${`prov-${p.id}`} />
            <div class="row wrap">
              <button class="btn primary sm" onClick=${() => testProvider(p)} disabled=${testing[p.id]} data-testid=${`save-${p.id}`}>${testing[p.id] ? html`<span class="spinner"></span>Checking…` : 'Save & test'}</button>
              ${p.configured ? html`<button class="btn sm" onClick=${() => switchAll(p.id, p.id === 'anthropic' ? 'claude-sonnet-5' : (results[p.id]?.models?.[0]?.id || ''))}>Use for all agents</button>` : null}
              ${results[p.id] ? html`<span class=${`small ${results[p.id].ok ? '' : ''}`} style=${{ color: results[p.id].ok ? 'var(--green)' : 'var(--red)' }}>${results[p.id].message}</span>` : null}
            </div>
          </div>`)}
          <${Field} label="Default brain for new agents">
            <${Seg} value=${draft.defaultProvider} onChange=${(v) => { setDraft({ ...draft, defaultProvider: v }); save({ defaultProvider: v, defaultModel: v === 'anthropic' ? 'claude-sonnet-5' : '' }, 'Default updated'); }} options=${providers.map((p) => ({ value: p.id, label: p.id === 'anthropic' ? 'Claude' : p.id === 'openai' ? 'OpenAI-compatible' : 'Simulated' }))} />
          <//>
        </section>

        <section class="card settings-card" id="s-a2a">
          <h3>A2A server</h3><p>Every agent is published as an Agent2Agent (A2A) endpoint (v1.0 and v0.3), so other agents and apps can talk to it.</p>
          <div class="row" style="gap:12px;margin-bottom:16px"><${Toggle} on=${a2a.enabled !== false} onChange=${(v) => { setDraft({ ...draft, a2a: { ...a2a, enabled: v } }); save({ a2a: { enabled: v } }); }} label="Enable A2A server" id="tg-a2a-srv" /><label for="tg-a2a-srv" class="bold small">Accept A2A requests</label></div>
          <${Field} label="Front desk agent" help="Answers requests to the root card /.well-known/agent-card.json">
            <select class="select" value=${a2a.frontDeskAgentId || ''} onChange=${(e) => { setDraft({ ...draft, a2a: { ...a2a, frontDeskAgentId: e.target.value } }); save({ a2a: { frontDeskAgentId: e.target.value } }); }}><option value="">First agent</option>${agents.map((a) => html`<option value=${a.id}>${a.name}</option>`)}</select>
          <//>
          <${Field} label="Bearer token (optional)" help="If set, A2A callers must send Authorization: Bearer <token>.">
            <div class="row"><input class="input mono" type="password" value=${a2a.token || ''} onInput=${(e) => setDraft({ ...draft, a2a: { ...a2a, token: e.target.value } })} autocomplete="off" /><button class="btn" onClick=${() => save({ a2a: { token: a2a.token || '' } })}>Save</button></div>
          <//>
          <${Field} label="Root agent card"><${CopyField} value=${`${origin}/.well-known/agent-card.json`} /><//>
          <div class="muted small">Per-agent cards: <code>${origin}/a2a/&lt;agent-id&gt;/.well-known/agent-card.json</code>. The URL is also shown in each agent’s editor.</div>
        </section>

        <section class="card settings-card" id="s-access">
          <h3>Drive Atrium from anywhere</h3><p>Use the command line, or let Claude Desktop / Cowork operate your agents through MCP.</p>
          <${Field} label="CLI" help="From the Atrium folder."><${CopyField} value=${'node bin/atrium.js chat Nova "Ask Atlas to research MCP servers"'} /><//>
          <${Field} label="MCP server config (Claude Desktop, Cowork, Claude Code…)" help="Gives any MCP client tools to list agents, chat with them and run workflows.">
            <textarea class="textarea mono" rows="8" readonly value=${JSON.stringify({ mcpServers: { atrium: { command: 'node', args: ['/path/to/atrium/bin/atrium-mcp.js'], env: { ATRIUM_URL: origin } } } }, null, 2)}></textarea>
          <//>
          <${Field} label="REST API"><${CopyField} value=${`curl -s ${origin}/api/agents/Nova/chat -H 'content-type: application/json' -d '{"message":"hello","wait":true}'`} /><//>
        </section>

        <section class="card settings-card" id="s-appearance">
          <h3>Appearance</h3><p>Light or dark for the app.</p>
          <${Seg} label="Time of day" value=${draft.theme || 'dark'} onChange=${(v) => { setDraft({ ...draft, theme: v }); applyTheme(v); save({ theme: v }, 'Theme updated'); }} options=${[{ value: 'dark', label: 'Night', icon: 'moon' }, { value: 'light', label: 'Day', icon: 'sun' }, { value: 'system', label: 'System' }]} />
          <h4 style="margin:18px 0 4px">Colony planet</h4><p style="margin-top:0">Where the colony stands. Plots, habitats, chats and running tasks all come along.</p>
          <div data-testid="settings-planet"><${Seg} label="Planet" value=${wp.planet} onChange=${(v) => setWorldPref({ planet: v }, { toast: `Welcome to ${PLANETS[v].name}` })} options=${PLANET_IDS.map((id) => ({ value: id, label: PLANETS[id].name, icon: 'planet' }))} /></div>
          <h4 style="margin:18px 0 4px">Time of day</h4><p style="margin-top:0">Live follows your clock: sunrise, sunset and stars at night.</p>
          <div data-testid="settings-time"><${Seg} label="Time of day" value=${wp.time} onChange=${(v) => setWorldPref({ time: v })} options=${[{ value: 'live', label: 'Live', icon: 'clock' }, { value: 'dawn', label: 'Dawn' }, { value: 'day', label: 'Day', icon: 'sun' }, { value: 'dusk', label: 'Dusk' }, { value: 'night', label: 'Night', icon: 'moon' }]} /></div>
          <h4 style="margin:18px 0 4px">Graphics</h4><p style="margin-top:0">Auto lowers the resolution if the colony gets choppy. Low turns shadows off (takes effect next time you open the colony).</p>
          <div data-testid="settings-quality"><${Seg} label="Graphics quality" value=${wp.quality} onChange=${(v) => { try { localStorage.removeItem('atrium.gfx'); } catch {} setWorldPref({ quality: v }, { toast: 'Graphics updated' }); }} options=${[{ value: 'auto', label: 'Auto' }, { value: 'high', label: 'High' }, { value: 'low', label: 'Low' }]} /></div>
        </section>

        <section class="card settings-card" id="s-data">
          <h3>Data</h3><p>Export agents, workflows, connectors (secrets masked) and memories to a JSON file, or import one.</p>
          <div class="row">
            <a class="btn" href="/api/export" download="atrium-export.json"><${Icon} name="download" size=${15} />Export</a>
            <label class="btn"><${Icon} name="upload" size=${15} />Import<input type="file" accept="application/json,.json" style="display:none" onChange=${importFile} /></label>
          </div>
        </section>
      </div>
    </div>
  </div></div>`;
}
