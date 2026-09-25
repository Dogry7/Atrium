import { html, useEffect, useRef, useState } from '../../lib/preact-htm.js';
import { useStore, state, onEvent, go, timeAgo, providerName, toastError, worldPrefs, setWorldPref } from '../state.js';
import { PLANETS, PLANET_IDS, TIMES, levelFor, nextLevelAt } from '../world/colony.js';
import { api } from '../api.js';
import { Icon } from '../icons.js';
import { Avatar, Tabs, Empty, StatusBadge, confirmDialog } from '../ui.js';
import { ChatPanel } from './chat.js';
import { openBuilder } from './agents.js';
import { markdown } from '../markdown.js';
import { WorldEngine } from '../world/engine.js';

const plain = (t) => String(t || '').replace(/\*\*|[*`]|^#+\s|^>\s?/gm, '').replace(/(^|\s)_([^_]+)_(?=\s|$|[.,!?])/g, '$1$2').replace(/\s+/g, ' ').trim();
function feedText(e) {
  const r = feedText0(e);
  return r ? { ...r, what: plain(r.what) } : r;
}
function feedText0(e) {
  switch (e.type) {
    case 'a2a.message': return e.kind === 'request' ? { who: `${e.fromName} → ${e.toName}`, what: e.text, color: 'var(--accent-text)' } : { who: `${e.fromName} ↩ ${e.toName}`, what: e.text, color: 'var(--green)' };
    case 'agent.tool': if (e.phase !== 'start' || e.tool === 'message_agent') return null;
      return { who: state.agents.find((a) => a.id === e.agentId)?.name || 'Agent', what: `used ${e.connectorName ? e.connectorName + ' · ' : ''}${e.tool.split('__').pop()}`, color: 'var(--blue)' };
    case 'agent.reply': if (e.from?.type === 'agent') return null; return { who: e.agentName, what: e.text, color: 'var(--green)' };
    case 'agent.error': return { who: e.agentName, what: e.error, color: 'var(--red)' };
    case 'run.started': return { who: 'Workflow', what: `“${e.run.workflowName}” started`, color: 'var(--amber)' };
    case 'run.finished': return { who: 'Workflow', what: `“${e.run.workflowName}” ${e.run.status}`, color: e.run.status === 'completed' ? 'var(--green)' : 'var(--red)' };
    case 'agent.created': return { who: e.agent.name, what: 'landed in the colony', color: 'var(--accent-text)' };
    case 'connector.result': if (!/decide/.test(e.tool)) return null; return { who: 'Laya', what: `decided: ${e.preview || ''}`, color: 'var(--amber)' };
    default: return null;
  }
}

const TIME_LABEL = { live: 'Live', dawn: 'Dawn', day: 'Day', dusk: 'Dusk', night: 'Night' };
const TIME_ICON = { live: 'clock', dawn: 'sun', day: 'sun', dusk: 'moon', night: 'moon' };
const cycle = (list, v) => list[(list.indexOf(v) + 1) % list.length];

export function WorldPage({ selectedId }) {
  const stageRef = useRef(); const canvasRef = useRef(); const engRef = useRef(); const cardRef = useRef();
  const agents = useStore((s) => s.agents);
  const busy = useStore((s) => s.busy);
  const connectors = useStore((s) => s.connectors);
  const live = useStore((s) => s.live);
  const worldSettings = useStore((s) => s.settings?.world);
  const prefs = worldPrefs({ settings: { world: worldSettings } });
  const [hover, setHover] = useState(null);
  const [feed, setFeed] = useState([]);
  const [names, setNames] = useState(true);
  const [panel, setPanel] = useState(true);
  const [hud, setHud] = useState(true);
  const [load, setLoad] = useState({ ready: false, progress: 0, error: null });
  const [orbit, setOrbit] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    let eng;
    const q = new URLSearchParams(location.search).get('quality');
    try {
      eng = new WorldEngine(canvasRef.current, {
        onSelect: (id, extra) => { if (id) go(`/world/${id}`); else if (extra?.connectorId) go('/connectors'); else go('/world'); },
        onHover: setHover,
        onOpen: (id) => { go(`/world/${id}`); setTimeout(() => document.querySelector('.inspector textarea')?.focus(), 60); },
        onVacant: () => openBuilder(),
        planet: worldPrefs().planet, time: worldPrefs().time, quality: q || worldPrefs().quality,
        overlayParent: stageRef.current,
      });
    } catch (e) {
      setLoad({ ready: false, progress: 0, error: 'Your browser could not start 3D graphics (WebGL). Try another browser, or turn on hardware acceleration.' });
      return undefined;
    }
    engRef.current = eng;
    eng.cardEl = cardRef.current;
    eng.sync(state.agents, state.busy, state.connectors);
    const poll = setInterval(() => {
      setLoad((l) => (l.ready === eng.loaded && l.progress === eng.progress && l.error === eng.error ? l : { ready: eng.loaded, progress: eng.progress, error: eng.error }));
      tick((n) => n + 1); // refresh the follow card's words
    }, 400);
    setFeed(state.events.map((e) => ({ e, f: feedText(e) })).filter((x) => x.f).slice(-3).map((x) => ({ id: x.e.seq, at: Date.now(), ...x.f })));
    const prune = setInterval(() => setFeed((list) => { const keep = list.filter((x) => Date.now() - x.at < 20000); return keep.length === list.length ? list : keep; }), 2000);
    const off = onEvent((e) => {
      eng.handle(e);
      const f = feedText(e);
      if (f) setFeed((list) => [...list.filter((x) => Date.now() - x.at < 20000).slice(-2), { id: e.seq, at: Date.now(), ...f }]);
    });
    window.__atriumWorld = eng; // handy for debugging & tests
    return () => { off(); clearInterval(prune); clearInterval(poll); eng.destroy(); if (window.__atriumWorld === eng) window.__atriumWorld = null; };
  }, []);

  useEffect(() => { engRef.current?.sync(agents, busy, connectors); }, [agents, busy, connectors]);
  useEffect(() => { const e = engRef.current; if (!e) return; e.select(selectedId || null); if (selectedId) e.focusOn(selectedId); }, [selectedId]);
  useEffect(() => { if (engRef.current) engRef.current.showNames = names; }, [names]);
  useEffect(() => { engRef.current?.setPlanet(prefs.planet); }, [prefs.planet]);
  useEffect(() => { engRef.current?.setTime(prefs.time); }, [prefs.time]);

  const setPlanet = (id) => setWorldPref({ planet: id }, { toast: `Welcome to ${PLANETS[id].name}` });
  // read the live store (not this render's copy) so quick repeated presses always advance
  const nextTime = () => setWorldPref({ time: cycle(TIMES, worldPrefs().time) });
  const needYou = agents.filter((a) => { const m = engRef.current?.agents.get(a.id)?.mode; return m === 'waiting' || m === 'error'; });
  const jumpNeed = () => { if (!needYou.length) return; const i = needYou.findIndex((a) => a.id === selectedId); go(`/world/${needYou[(i + 1) % needYou.length].id}`); };

  useEffect(() => {
    const onKey = (ev) => {
      if (ev.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('.overlay') || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const e = engRef.current; if (!e) return;
      const k = ev.key.toLowerCase();
      if (ev.key === '=' || ev.key === '+') e.zoomBy(1.2);
      else if (ev.key === '-') e.zoomBy(1 / 1.2);
      else if (ev.key === '0') e.home();
      else if (k === 'o') setOrbit(e.toggleOrbit());
      else if (k === 'l') nextTime();
      else if (k === 'g') setPlanet(cycle(PLANET_IDS, worldPrefs().planet));
      else if (k === 'h') setHud((h) => !h);
      else if (k === 'j') jumpNeed();
      else if (ev.key === 'Escape' && selectedId) go('/world');
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [selectedId, prefs.planet, prefs.time, needYou.length]);

  const working = agents.filter((a) => busy[a.id] > 0).length;
  const planet = PLANETS[prefs.planet] || PLANETS.terra;
  const sel = selectedId && agents.find((a) => a.id === selectedId);
  const info = sel && engRef.current?.describe(sel.id);

  return html`<div class=${`world-wrap ${hud ? '' : 'hud-hidden'}`}>
    <div class="world-stage" ref=${stageRef}>
      <canvas ref=${canvasRef} aria-label=${`The Atrium colony on ${planet.name}. Each agent is a robot with its own plot; click one to open it.`} role="img" data-planet=${prefs.planet} tabindex="0"></canvas>
      ${!load.ready ? html`<div class="world-loading" role="status">
        ${load.error ? html`<div class="callout red"><${Icon} name="alert" size=${16} /><div>${load.error}</div></div>`
          : html`<div class="wl-planet"></div><div class="wl-text">Landing on ${planet.name}…</div><div class="wl-bar"><span style=${{ width: `${Math.round(10 + load.progress * 90)}%` }}></span></div>`}
      </div>` : null}
      <div class="world-hud hud-tl">
        <div class="glass hud-pill">
          <span class=${`status-dot ${live === 'live' ? 'green' : 'amber'}`} title=${live === 'live' ? 'Live' : 'Reconnecting…'}></span>
          <b>Atrium Colony</b><span class="dim">· ${planet.name}</span><span class="sep"></span>
          <span class="dim">${agents.length} agent${agents.length === 1 ? '' : 's'}</span>
          ${working ? html`<span class="badge accent">${working} working</span>` : html`<span class="muted small">all idle</span>`}
        </div>
        ${needYou.length ? html`<button class="glass hud-pill need-you" onClick=${jumpNeed} title="Jump to the next agent that needs you (J)" data-testid="need-you"><span class="status-dot amber"></span>${needYou.length} need${needYou.length === 1 ? 's' : ''} you</button>` : null}
      </div>
      <div class="world-hud hud-tr">
        <button class="btn glass" onClick=${() => setNames(!names)} title="Toggle name tags" aria-pressed=${names}><${Icon} name="eye" size=${15} />${names ? 'Names on' : 'Names off'}</button>
        <button class="btn primary" onClick=${() => openBuilder()} data-testid="world-new-agent"><${Icon} name="plus" size=${15} />New agent</button>
        <button class="btn glass icon" onClick=${() => setPanel(!panel)} title=${panel ? 'Hide panel' : 'Show panel'} aria-label="Toggle side panel"><${Icon} name="panel" size=${16} /></button>
      </div>
      <div class="world-hud hud-bl">
        <div class="feed" aria-label="Live activity">
          ${[...feed].reverse().map((f) => html`<div class="feed-item glass" key=${f.id}>
            <span class="status-dot" style=${{ background: f.color, marginTop: '5px' }}></span>
            <div style="min-width:0"><span class="who" style=${{ color: f.color }}>${f.who}</span> <span class="what">${f.what}</span></div>
          </div>`)}
        </div>
        <div class="glass zoom-ctl" style="width:max-content">
          <button onClick=${() => engRef.current?.zoomBy(1.25)} title="Zoom in (+)" aria-label="Zoom in"><${Icon} name="plus" size=${15} /></button>
          <button onClick=${() => engRef.current?.zoomBy(1 / 1.25)} title="Zoom out (−)" aria-label="Zoom out"><${Icon} name="minus" size=${15} /></button>
          <button onClick=${() => engRef.current?.home()} title="Reset view (0)" aria-label="Reset view"><${Icon} name="maximize" size=${14} /></button>
          <button class=${orbit ? 'on' : ''} onClick=${() => setOrbit(engRef.current?.toggleOrbit())} title="Orbit slowly (O)" aria-label="Orbit" aria-pressed=${orbit}><${Icon} name="refresh" size=${14} /></button>
        </div>
        <div class="world-hint muted tiny">Drag to move · right-drag or ⇧-drag to rotate · scroll to zoom</div>
      </div>
      <div class="world-hud hud-br">
        <div class="glass world-switch" role="radiogroup" aria-label="Planet" data-testid="planet-switch">
          ${PLANET_IDS.map((id) => html`<button type="button" role="radio" aria-checked=${prefs.planet === id ? 'true' : 'false'} class=${prefs.planet === id ? 'on' : ''} title=${`${PLANETS[id].name}: ${PLANETS[id].blurb} (G)`} onClick=${() => setPlanet(id)} data-testid=${`planet-${id}`}><span class=${`planet-dot ${id}`}></span>${PLANETS[id].name}</button>`)}
        </div>
        <button class="btn glass" onClick=${nextTime} title="Time of day (L). Live follows your clock." data-testid="time-btn"><${Icon} name=${TIME_ICON[prefs.time] || 'clock'} size=${15} />${TIME_LABEL[prefs.time] || 'Live'}</button>
      </div>
      <div class="bot-card glass" ref=${cardRef} style="visibility:hidden" aria-live="polite" data-testid="bot-card">
        ${sel && info ? html`<${BotCard} agent=${sel} info=${info} busy=${busy[sel.id] || 0} />` : null}
      </div>
      ${hover ? html`<div class="world-tooltip glass" style=${{ left: hover.x + 'px', top: hover.y + 'px' }}>
        <b>${hover.name}</b> <span class="muted">· ${hover.status}</span>
      </div>` : null}
    </div>
    <aside class=${`inspector ${panel ? '' : 'collapsed'}`} aria-label="Inspector">
      ${sel ? html`<${AgentInspector} id=${selectedId} key=${selectedId} />` : html`<${Overview} />`}
    </aside>
  </div>`;
}

function BotCard({ agent, info, busy }) {
  const tasks = agent.stats?.tasks || 0;
  const lvl = levelFor(tasks), next = nextLevelAt(tasks);
  const prevAt = [0, 1, 3, 6, 12, 25, 50][lvl];
  const pct = next ? Math.round(((tasks - prevAt) / (next - prevAt)) * 100) : 100;
  const stop = async () => {
    const t = state.tasks.filter((x) => x.agentId === agent.id && x.status.state === 'working');
    for (const x of t) await api.post(`/api/tasks/${x.id}/cancel`).catch(toastError);
  };
  return html`<div class="bc-head">
      <${Avatar} agent=${agent} size=${40} busy=${busy > 0} />
      <div class="grow" style="min-width:0"><div class="bc-name ellipsis">${agent.name}</div><div class="bc-role ellipsis">${agent.role}</div></div>
      ${info.badge ? html`<span class=${`bc-badge ${info.badge.tone}`} title=${info.badge.label}>${info.badge.icon}</span>` : null}
    </div>
    <div class="bc-status">${info.status}</div>
    <div class="bc-level" title=${next ? `${next - tasks} more task${next - tasks === 1 ? '' : 's'} to the next level` : 'Fully built'}>
      <div class="row between tiny"><span>Habitat level ${lvl}</span><span class="muted">${tasks} task${tasks === 1 ? '' : 's'} done${next ? ` · next at ${next}` : ''}</span></div>
      <div class="bc-bar"><span style=${{ width: `${pct}%` }}></span></div>
    </div>
    <div class="row" style="gap:6px;margin-top:10px">
      <button class="btn sm primary" onClick=${() => document.querySelector('.inspector textarea')?.focus()} data-testid="card-chat"><${Icon} name="chat" size=${14} />Chat</button>
      <button class="btn sm" onClick=${() => openBuilder(agent.id)}><${Icon} name="edit" size=${14} />Edit</button>
      ${busy > 0 ? html`<button class="btn sm" onClick=${stop} data-testid="card-stop"><${Icon} name="stop" size=${14} />Stop</button>` : null}
      <span class="grow"></span>
      <button class="btn sm ghost icon" onClick=${() => go('/world')} aria-label="Close card" title="Close (Esc)"><${Icon} name="x" size=${14} /></button>
    </div>`;
}

function Overview() {
  const agents = useStore((s) => s.agents);
  const busy = useStore((s) => s.busy);
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const sim = settings.defaultProvider === 'simulated' && !providers.some((p) => p.id !== 'simulated' && p.configured);
  return html`<div class="insp-body" style="padding:16px">
    <div class="section-title">Your team</div>
    ${agents.length ? agents.map((a) => html`<div class="roster-item" key=${a.id} onClick=${() => go(`/world/${a.id}`)} role="button" tabindex="0" onKeyDown=${(e) => e.key === 'Enter' && go(`/world/${a.id}`)}>
      <${Avatar} agent=${a} size=${38} busy=${busy[a.id] > 0} />
      <div class="grow"><div class="n">${a.name}</div><div class="r ellipsis">${a.role}</div></div>
      ${busy[a.id] > 0 ? html`<span class="badge accent">working</span>` : html`<span class="badge">${a.provider === 'simulated' ? 'sim' : providerName(a.provider).split(' ')[0]}</span>`}
    </div>`) : html`<${Empty} icon="users" title="No agents yet" action=${html`<button class="btn primary" onClick=${() => openBuilder()}><${Icon} name="plus" size=${15} />Create your first agent</button>`}>Agents live here. Give one a name and a job.<//>`}
    <div class="divider"></div>
    ${sim ? html`<div class="callout amber" style="margin-bottom:14px"><${Icon} name="key" size=${16} /><div><b>Running on the Simulated brain.</b> Everything works offline, but answers are canned. <a href="#/settings">Add your Claude or OpenAI key</a> to give agents real intelligence.</div></div>` : null}
    <div class="section-title">Try this</div>
    <div class="col small dim" style="gap:8px">
      <div class="row" style="gap:8px;align-items:flex-start"><${Icon} name="chat" size=${15} style="flex:none;margin-top:2px" /><span>Click a robot and ask: <i>“Ask Atlas and Quill what they think about launching a newsletter”</i>. Watch Nova run over to their plots.</span></div>
      <div class="row" style="gap:8px;align-items:flex-start"><${Icon} name="flow" size=${15} style="flex:none;margin-top:2px" /><span>Run the <a href="#/workflows">Research → Draft → Review</a> workflow.</span></div>
      <div class="row" style="gap:8px;align-items:flex-start"><${Icon} name="keyboard" size=${15} style="flex:none;margin-top:2px" /><span>Press <span class="kbd">⌘K</span> for everything. Drag to move, right-drag to rotate, scroll to zoom. <span class="kbd">G</span> planet, <span class="kbd">L</span> time of day, <span class="kbd">O</span> orbit.</span></div>
    </div>
  </div>`;
}

function AgentInspector({ id }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === id));
  const busy = useStore((s) => s.busy[id] || 0);
  const [tab, setTab] = useState('chat');
  if (!agent) return null;
  return html`<div style="display:flex;flex-direction:column;height:100%;min-height:0">
    <div class="insp-head">
      <${Avatar} agent=${agent} size=${46} busy=${busy > 0} />
      <div class="grow" style="min-width:0">
        <div class="name ellipsis">${agent.name}</div>
        <div class="role ellipsis">${agent.role}</div>
        <div class="row" style="gap:6px;margin-top:5px">
          ${busy > 0 ? html`<span class="badge accent"><span class="spinner" style="width:9px;height:9px;border-width:1.5px"></span>working</span>` : html`<span class="badge green">available</span>`}
          <span class="badge">${providerName(agent.provider).replace(' (Claude)', '')}${agent.model ? ` · ${agent.model}` : ''}</span>
        </div>
      </div>
      <div class="col" style="gap:4px">
        <button class="btn sm icon ghost" onClick=${() => openBuilder(agent.id)} title="Edit agent" aria-label="Edit agent"><${Icon} name="edit" size=${15} /></button>
        <button class="btn sm icon ghost" onClick=${() => go('/world')} title="Close" aria-label="Close"><${Icon} name="x" size=${15} /></button>
      </div>
    </div>
    <${Tabs} value=${tab} onChange=${setTab} tabs=${[{ value: 'chat', label: 'Chat', icon: 'chat' }, { value: 'activity', label: 'Activity', icon: 'activity' }, { value: 'memory', label: 'Memory', icon: 'memory' }]} />
    <div class="insp-body" style=${tab === 'chat' ? 'overflow:hidden' : ''}>
      ${tab === 'chat' ? html`<${ChatPanel} agentId=${id} />` : tab === 'activity' ? html`<${AgentActivity} id=${id} />` : html`<${AgentMemory} id=${id} />`}
    </div>
  </div>`;
}

function AgentActivity({ id }) {
  const tasks = useStore((s) => s.tasks);
  const list = tasks.filter((t) => t.agentId === id).slice(-40).reverse();
  if (!list.length) return html`<${Empty} icon="activity" title="Nothing yet">Tasks this agent works on will show up here, including messages from colleagues and workflows.<//>`;
  return html`<div style="padding:12px;display:flex;flex-direction:column;gap:8px">
    ${list.map((t) => html`<div class="card" style="padding:10px 12px" key=${t.id}>
      <div class="row small" style="gap:8px">
        <${StatusBadge} status=${t.status.state} />
        <span class="dim ellipsis grow">from ${t.from?.type === 'agent' ? t.from.name : t.from?.type === 'workflow' ? `workflow “${t.from.name}”` : t.from?.type === 'external' ? `A2A · ${t.from.name}` : 'you'}</span>
        <span class="muted tiny nowrap">${timeAgo(t.createdAt)}</span>
      </div>
      <div class="small" style="margin-top:6px;color:var(--text)">${t.input}</div>
      ${t.output ? html`<div class="small md dim" style="margin-top:6px;max-height:90px;overflow:hidden" dangerouslySetInnerHTML=${{ __html: markdown(t.output) }}></div>` : null}
      ${t.status.state === 'failed' ? html`<div class="small" style="margin-top:6px;color:var(--red)">${t.status.message}</div>` : null}
    </div>`)}
  </div>`;
}

function AgentMemory({ id }) {
  const [list, setList] = useState(null);
  const load = () => api.get(`/api/agents/${id}/memories`).then(setList).catch(toastError);
  useEffect(() => { load(); return onEvent((e) => { if (e.type === 'agent.memory' && e.agentId === id) load(); }); }, [id]);
  if (!list) return null;
  if (!list.length) return html`<${Empty} icon="memory" title="No memories yet">Tell this agent “remember that …” and it will keep the note across conversations.<//>`;
  return html`<div style="padding:12px;display:flex;flex-direction:column;gap:6px">
    ${list.slice().reverse().map((m) => html`<div class="card row" style="padding:10px 12px;align-items:flex-start" key=${m.id}>
      <${Icon} name="memory" size=${14} style="flex:none;margin-top:3px;color:var(--amber)" />
      <div class="grow small">${m.text}<div class="muted tiny">${timeAgo(m.createdAt)}</div></div>
      <button class="btn xs ghost icon" aria-label="Forget" title="Forget" onClick=${async () => { if (await confirmDialog({ title: 'Forget this?', message: m.text, confirm: 'Forget', danger: true })) { await api.del(`/api/agents/${id}/memories/${m.id}`); load(); } }}><${Icon} name="trash" size=${13} /></button>
    </div>`)}
  </div>`;
}
