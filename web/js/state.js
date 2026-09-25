import { useState, useEffect, useRef } from '../lib/preact-htm.js';
import { api, connectEvents } from './api.js';

/** Minimal global store + event fan-out. */
export const state = {
  ready: false, error: null, live: 'connecting',
  agents: [], workflows: [], connectors: [], pluginTypes: [], pluginErrors: [], providers: [], settings: {},
  tasks: [], runs: [], events: [], seq: 0, streams: {}, busy: {}, toasts: [], colors: [],
};
const listeners = new Set();
const eventListeners = new Set();
let scheduled = false;

export function setState(patch) {
  Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  if (!scheduled) {
    // batch on a short timer, not rAF: the UI stays snappy even when the 3D world is busy drawing
    scheduled = true;
    setTimeout(() => { scheduled = false; for (const l of listeners) l(); }, 16);
  }
}

export function useStore(selector = (s) => s) {
  const [, force] = useState(0);
  const sel = useRef(selector); sel.current = selector;
  const last = useRef(selector(state));
  useEffect(() => {
    const fn = () => {
      const next = sel.current(state);
      if (next !== last.current || (typeof next === 'object' && next === state)) { last.current = next; force((x) => x + 1); }
    };
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  last.current = selector(state);
  return last.current;
}

export function onEvent(fn) { eventListeners.add(fn); return () => eventListeners.delete(fn); }

const upsert = (list, item, key = 'id') => {
  const i = list.findIndex((x) => x[key] === item[key]);
  if (i === -1) return [...list, item];
  const copy = list.slice(); copy[i] = { ...list[i], ...item }; return copy;
};

export async function loadState() {
  try {
    const s = await api.get('/api/state');
    const busy = {};
    for (const a of s.agents) busy[a.id] = a.busy || 0;
    setState({ ...s, busy, ready: true, error: null, events: s.events.filter((e) => e.type !== 'agent.delta') });
    applyTheme(s.settings.theme);
  } catch (e) {
    setState({ error: e.message });
  }
}

/** The colony's view settings: planet, time of day, graphics quality. */
export const worldPrefs = (s = state) => ({ planet: 'terra', time: 'live', quality: 'auto', ...(s.settings?.world || {}) });

/** Change colony settings (optimistic, then saved on the server). */
export async function setWorldPref(patch, { toast: msg } = {}) {
  const prev = state.settings.world || {};
  setState({ settings: { ...state.settings, world: { ...prev, ...patch } } });
  try {
    await api.patch('/api/settings', { world: patch });
    if (msg) toast(msg, 'success', 2200);
  } catch (e) {
    setState({ settings: { ...state.settings, world: prev } });
    toastError(e);
  }
}

export function applyTheme(t) {
  let theme = t;
  try { localStorage.setItem('atrium.theme', t || 'dark'); } catch {}
  if (t === 'system' || !t) theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
}

function apply(e) {
  const s = state;
  const patch = {};
  if (e.type !== 'agent.delta') {
    patch.events = s.events.length > 500 ? [...s.events.slice(-400), e] : [...s.events, e];
  }
  switch (e.type) {
    case 'agent.created': case 'agent.updated': patch.agents = upsert(s.agents, e.agent); break;
    case 'agent.reply': if (e.stats) patch.agents = s.agents.map((a) => (a.id === e.agentId ? { ...a, stats: { ...a.stats, ...e.stats } } : a)); break;
    case 'agent.deleted': patch.agents = s.agents.filter((a) => a.id !== e.id); break;
    case 'agent.status': patch.busy = { ...s.busy, [e.agentId]: e.active || 0 }; break;
    case 'task.created': case 'task.updated': {
      patch.tasks = upsert(s.tasks, e.task);
      if (patch.tasks.length > 400) patch.tasks = patch.tasks.slice(-300);
      if (e.type === 'task.updated' && e.task.status.state !== 'working') {
        const streams = { ...s.streams }; delete streams[e.task.id]; patch.streams = streams;
      }
      break;
    }
    case 'agent.delta': patch.streams = { ...s.streams, [e.taskId]: (s.streams[e.taskId] || '') + e.text }; break;
    case 'agent.note': patch.streams = { ...s.streams, [e.taskId]: '' }; break;
    case 'run.started': patch.runs = upsert(s.runs, e.run); break;
    case 'run.finished': patch.runs = upsert(s.runs, e.run); break;
    case 'run.node': {
      const r = s.runs.find((x) => x.id === e.runId);
      if (r) {
        const { type, seq, ts, runId, workflowId, nodeId, ...rest } = e;
        patch.runs = upsert(s.runs, { id: r.id, nodes: { ...r.nodes, [nodeId]: { ...(r.nodes?.[nodeId] || {}), ...rest } } });
      }
      break;
    }
    case 'workflow.created': case 'workflow.updated': patch.workflows = upsert(s.workflows, e.workflow); break;
    case 'workflow.deleted': patch.workflows = s.workflows.filter((w) => w.id !== e.id); break;
    case 'connector.created': case 'connector.updated': patch.connectors = upsert(s.connectors, e.connector); break;
    case 'connector.deleted': patch.connectors = s.connectors.filter((c) => c.id !== e.id); break;
    case 'connector.status': {
      const c = s.connectors.find((x) => x.id === e.id);
      if (c) patch.connectors = upsert(s.connectors, { id: e.id, status: e.status, error: e.error, ...(e.tools ? { toolNames: e.tools } : {}), ...(e.info ? { info: e.info } : {}) });
      break;
    }
    case 'settings.updated': case 'state.imported': case 'plugins.reloaded': loadState(); break;
    default: break;
  }
  patch.seq = e.seq;
  setState(patch);
  for (const l of eventListeners) { try { l(e); } catch (err) { console.error(err); } }
}

export function startLive() {
  return connectEvents({
    onEvent: apply,
    getSeq: () => state.seq,
    onStatus: (live) => {
      const was = state.live;
      setState({ live });
      if (live === 'live' && was === 'reconnecting') loadState();
    },
  });
}

// ---------------------------------------------------------------- toasts
let toastId = 0;
export function toast(message, type = 'info', ms = 4200) {
  const id = ++toastId;
  setState({ toasts: [...state.toasts, { id, message, type }] });
  setTimeout(() => setState({ toasts: state.toasts.filter((t) => t.id !== id) }), ms);
}
export const toastError = (e) => toast(e?.message || String(e), 'error', 6500);

// ---------------------------------------------------------------- routing
export function useRoute() {
  const [hash, setHash] = useState(location.hash || '#/world');
  useEffect(() => {
    const fn = () => setHash(location.hash || '#/world');
    addEventListener('hashchange', fn);
    return () => removeEventListener('hashchange', fn);
  }, []);
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { page: parts[0] || 'world', parts };
}
export const go = (path) => { location.hash = path.startsWith('#') ? path : `#${path}`; };

// helpers
export const agentById = (id) => state.agents.find((a) => a.id === id);
export const providerName = (id) => state.providers.find((p) => p.id === id)?.name || id;
export function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
