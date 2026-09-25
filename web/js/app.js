import { html, render, useEffect, useLayoutEffect, useState, useRef } from '../lib/preact-htm.js';
import { useStore, loadState, startLive, useRoute, go, state, applyTheme, toast, toastError, worldPrefs, setWorldPref } from './state.js';
import { PLANETS, PLANET_IDS } from './world/colony.js';
import { api } from './api.js';
import { Icon } from './icons.js';
import { Toasts, ConfirmHost, Avatar } from './ui.js';
import { WorldPage } from './pages/world.js';
import { AgentsPage, BuilderHost, openBuilder } from './pages/agents.js';
import { WorkflowsPage } from './pages/workflows.js';
import { ConnectorsPage } from './pages/connectors.js';
import { ActivityPage } from './pages/activity.js';
import { SettingsPage } from './pages/settings.js';

const NAV = [
  { id: 'world', label: 'Colony', icon: 'planet', key: '1' },
  { id: 'agents', label: 'Agents', icon: 'users', key: '2' },
  { id: 'workflows', label: 'Workflows', icon: 'flow', key: '3' },
  { id: 'connectors', label: 'Connectors', icon: 'plug', key: '4' },
  { id: 'activity', label: 'Activity', icon: 'activity', key: '5' },
];
const TITLES = { world: ['Colony', 'Your agents at work'], agents: ['Agents', 'Build and manage your team'], workflows: ['Workflows', 'Multi-agent processes'], connectors: ['Connectors', 'Tools, apps and other agents'], activity: ['Activity', 'Tasks, handoffs and runs'], settings: ['Settings', ''] };

function Palette({ onClose }) {
  const agents = useStore((s) => s.agents);
  const workflows = useStore((s) => s.workflows);
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const listRef = useRef(); const inputRef = useRef();
  useLayoutEffect(() => { inputRef.current?.focus(); }, []);
  const items = [
    ...agents.map((a) => ({ group: 'Chat with', label: a.name, sub: a.role, agent: a, run: () => { go(`/world/${a.id}`); setTimeout(() => document.querySelector('.inspector textarea')?.focus(), 80); } })),
    ...workflows.map((w) => ({ group: 'Workflows', label: w.name, sub: 'open', icon: 'flow', run: () => go(`/workflows/${w.id}`) })),
    { group: 'Actions', label: 'New agent', icon: 'plus', run: () => openBuilder() },
    { group: 'Actions', label: 'New workflow', icon: 'flow', run: async () => { try { const w = await api.post('/api/workflows', { name: 'Untitled workflow' }); go(`/workflows/${w.id}`); } catch (e) { toastError(e); } } },
    { group: 'Actions', label: 'Add connector', icon: 'plug', run: () => go('/connectors') },
    ...PLANET_IDS.filter((id) => id !== worldPrefs().planet).map((id) => ({ group: 'Actions', label: `Fly the colony to ${PLANETS[id].name}`, sub: PLANETS[id].blurb, icon: 'planet', run: () => { go('/world'); setWorldPref({ planet: id }, { toast: `Welcome to ${PLANETS[id].name}` }); } })),
    { group: 'Actions', label: 'Toggle day / night', icon: 'sun', run: () => { const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; applyTheme(t); api.patch('/api/settings', { theme: t }); } },
    ...NAV.map((n) => ({ group: 'Go to', label: n.label, icon: n.icon, run: () => go(`/${n.id}`) })),
    { group: 'Go to', label: 'Settings', icon: 'settings', run: () => go('/settings') },
  ];
  const f = items.filter((x) => !q || `${x.label} ${x.sub || ''} ${x.group}`.toLowerCase().includes(q.toLowerCase()));
  useEffect(() => setI(0), [q]);
  useEffect(() => { listRef.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' }); }, [i]);
  const pick = (x) => { onClose(); x?.run(); };
  let lastGroup = null;
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="palette" role="dialog" aria-label="Command palette">
      <div class="p-search"><${Icon} name="search" size=${18} />
        <input ref=${inputRef} autofocus placeholder="Chat with an agent, open a workflow, or run a command…" value=${q} onInput=${(e) => setQ(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(f.length - 1, x + 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)); } else if (e.key === 'Enter') pick(f[i]); else if (e.key === 'Escape') onClose(); }} aria-label="Search commands" />
      </div>
      <div class="p-list" ref=${listRef}>
        ${f.map((x, k) => {
          const head = x.group !== lastGroup ? html`<div class="p-group">${x.group}</div>` : null; lastGroup = x.group;
          return html`${head}<div class=${`p-item ${k === i ? 'sel' : ''}`} onMouseEnter=${() => setI(k)} onClick=${() => pick(x)}>
            ${x.agent ? html`<${Avatar} agent=${x.agent} size=${24} radius=${7} />` : html`<${Icon} name=${x.icon || 'arrowRight'} size=${16} />`}
            <span class="grow">${x.label}</span>${x.sub ? html`<span class="muted small">${x.sub}</span>` : null}
          </div>`;
        })}
        ${!f.length ? html`<div class="muted small" style="padding:14px">No matches.</div>` : null}
      </div>
    </div>
  </div>`;
}

function App() {
  const ready = useStore((s) => s.ready);
  const error = useStore((s) => s.error);
  const busy = useStore((s) => s.busy);
  const live = useStore((s) => s.live);
  const { page, parts } = useRoute();
  const [palette, setPalette] = useState(false);

  useEffect(() => {
    loadState();
    const stop = startLive();
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); return; }
      if (e.target.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('.overlay')) return; // a dialog or the palette is open
      const n = NAV.find((x) => x.key === e.key);
      if (n) go(`/${n.id}`);
      if (e.key === 'n' && !document.querySelector('.overlay')) { e.preventDefault(); openBuilder(); }
    };
    addEventListener('keydown', onKey);
    return () => { stop(); removeEventListener('keydown', onKey); };
  }, []);

  const anyBusy = Object.values(busy).some((n) => n > 0);
  const planetId = useStore((s) => s.settings?.world?.planet) || 'terra';
  const [title, sub] = page === 'world' || !TITLES[page] ? ['Colony', `Your agents at work on ${PLANETS[planetId]?.name || 'Terra'}`] : TITLES[page];

  return html`<div class="app">
    <nav class="rail" aria-label="Main">
      <div class="brand" title="Atrium"><${Icon} name="logo" size=${20} stroke=${2.2} /></div>
      ${NAV.map((n) => html`<button class=${`rail-btn ${page === n.id ? 'active' : ''}`} onClick=${() => go(`/${n.id}`)} aria-label=${n.label} aria-current=${page === n.id ? 'page' : undefined} data-testid=${`nav-${n.id}`}>
        <${Icon} name=${n.icon} size=${20} />
        ${n.id === 'world' && anyBusy ? html`<span class="dot"></span>` : null}
        <span class="tip">${n.label} <span class="kbd" style="margin-left:4px">${n.key}</span></span>
      </button>`)}
      <div class="rail-spacer"></div>
      <button class="rail-btn" onClick=${() => setPalette(true)} aria-label="Command palette"><${Icon} name="search" size=${19} /><span class="tip">Search <span class="kbd">⌘K</span></span></button>
      <button class=${`rail-btn ${page === 'settings' ? 'active' : ''}`} onClick=${() => go('/settings')} aria-label="Settings" data-testid="nav-settings"><${Icon} name="settings" size=${20} /><span class="tip">Settings</span></button>
    </nav>
    <main class="main">
      <header class="topbar">
        <h1>${title}${sub ? html`<span class="sub">${sub}</span>` : null}</h1>
        <div class="grow"></div>
        ${live !== 'live' && ready ? html`<span class="badge amber"><span class="spinner" style="width:10px;height:10px;border-width:1.5px"></span>Reconnecting</span>` : null}
        <button class="search-btn" onClick=${() => setPalette(true)} aria-label="Search and commands"><${Icon} name="search" size=${15} /><span class="grow">Search or jump to…</span><span class="kbd">⌘K</span></button>
      </header>
      <div class="page">
        ${error && !ready ? html`<div class="empty" style="height:100%"><div class="icon-wrap" style="background:var(--red-soft);color:var(--red)"><${Icon} name="alert" size=${24} /></div><h3>Can’t reach Atrium</h3><p>${error}</p><button class="btn" onClick=${loadState}>Try again</button></div>`
          : !ready ? html`<div class="empty" style="height:100%"><span class="spinner" style="width:22px;height:22px;color:var(--accent)"></span></div>`
          : page === 'agents' ? html`<${AgentsPage} />`
          : page === 'workflows' ? html`<${WorkflowsPage} id=${parts[1]} />`
          : page === 'connectors' ? html`<${ConnectorsPage} />`
          : page === 'activity' ? html`<${ActivityPage} />`
          : page === 'settings' ? html`<${SettingsPage} />`
          : html`<${WorldPage} selectedId=${parts[1]} />`}
      </div>
    </main>
    ${ready ? html`<${BuilderHost} />` : null}
    <${ConfirmHost} />
    ${palette ? html`<${Palette} onClose=${() => setPalette(false)} />` : null}
    <${Toasts} />
  </div>`;
}

render(html`<${App} />`, document.getElementById('root'));
