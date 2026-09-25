import { html, useEffect, useRef, useState, useMemo } from '../../lib/preact-htm.js';
import { api } from '../api.js';
import { useStore, onEvent, toastError, go, timeAgo, agentById } from '../state.js';
import { Icon, PLUGIN_ICON } from '../icons.js';
import { markdown } from '../markdown.js';
import { useAutosize, confirmDialog } from '../ui.js';

function stepLabel(s) {
  if (s.tool === 'message_agent') return { icon: 'chat', text: `Asked ${s.input?.agent}`, detail: s.input?.message };
  if (s.tool === 'list_agents') return { icon: 'users', text: 'Checked who’s around' };
  if (s.tool === 'remember') return { icon: 'memory', text: 'Saved to memory', detail: s.input?.note };
  if (s.tool === 'recall') return { icon: 'memory', text: 'Searched memory', detail: s.input?.query };
  const short = s.tool.split('__').pop();
  return { icon: 'tool', text: `${s.connectorName ? s.connectorName + ' · ' : ''}${short}`, detail: JSON.stringify(s.input) };
}

function Step({ s }) {
  const l = stepLabel(s);
  return html`<details class=${`step ${s.ok === false ? 'err' : ''}`}>
    <summary>
      ${s.running ? html`<span class="spinner" style="width:11px;height:11px"></span>` : html`<${Icon} name=${s.ok === false ? 'alert' : l.icon} size=${13} />`}
      <span class="grow ellipsis">${l.text}</span>
      ${s.ms != null ? html`<span class="muted tiny">${s.ms < 1000 ? `${s.ms}ms` : `${(s.ms / 1000).toFixed(1)}s`}</span>` : null}
      <${Icon} name="chevronDown" size=${12} />
    </summary>
    ${l.detail ? html`<pre><b>Input</b>\n${l.detail}</pre>` : null}
    ${s.output ? html`<pre><b>Result</b>\n${s.output}</pre>` : null}
  </details>`;
}

const SUGGEST = {
  default: ['Say hello and introduce yourself', 'What can you help me with?'],
  lead: ['Ask Atlas and Quill what they think about launching a newsletter', 'Plan a product launch with the team'],
  research: ['Research the pros and cons of remote work', 'Fetch https://example.com and summarise it'],
  write: ['Write a short welcome email for new customers', 'Draft a tweet announcing our new feature'],
  review: ['Review this: "Our app is fast, secure and easy to use."', 'What makes a good code review?'],
};

export function ChatPanel({ agentId, compact }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const tasks = useStore((s) => s.tasks);
  const streams = useStore((s) => s.streams);
  const providers = useStore((s) => s.providers);
  const [turns, setTurns] = useState([]);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(null);
  const [live, setLive] = useState({}); // taskId → steps
  const [loading, setLoading] = useState(true);
  const logRef = useRef(); const taRef = useRef();
  useAutosize(taRef, text);

  const load = async () => {
    try { const r = await api.get(`/api/agents/${agentId}/thread`); setTurns(r.turns); }
    catch (e) { toastError(e); }
    finally { setLoading(false); }
  };
  useEffect(() => { setLoading(true); setTurns([]); setPending(null); setLive({}); load(); }, [agentId]);

  // live tool steps for this agent's tasks
  useEffect(() => onEvent((e) => {
    if (e.agentId !== agentId) return;
    if (e.type === 'agent.tool') {
      setLive((m) => {
        const steps = [...(m[e.taskId] || [])];
        if (e.phase === 'start') steps.push({ callId: e.callId, tool: e.tool, input: e.input, connectorName: e.connectorName, running: true });
        else { const i = steps.findIndex((s) => s.callId === e.callId); if (i !== -1) steps[i] = { ...steps[i], running: false, ok: e.ok, output: e.output, ms: e.ms }; }
        return { ...m, [e.taskId]: steps };
      });
    }
  }), [agentId]);

  const chatTasks = tasks.filter((t) => t.agentId === agentId && t.contextId === 'chat');
  const working = chatTasks.filter((t) => t.status.state === 'working');
  const lastDoneKey = chatTasks.filter((t) => t.status.state !== 'working').map((t) => t.id + t.status.state).join();
  useEffect(() => { if (!loading) load(); }, [lastDoneKey]);
  useEffect(() => { if (pending && working.some((t) => t.id === pending.taskId)) setPending(null); }, [working.length]);

  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [turns.length, working.length, pending, JSON.stringify(working.map((t) => (streams[t.id] || '').length)), JSON.stringify(live)]);

  const send = async (msg) => {
    const m = (msg ?? text).trim();
    if (!m) return;
    setText('');
    setPending({ input: m, at: new Date().toISOString() });
    try {
      const r = await api.post(`/api/agents/${agentId}/chat`, { message: m });
      setPending((p) => (p ? { ...p, taskId: r.taskId } : p));
    } catch (e) { toastError(e); setPending(null); setText(m); }
  };

  const stop = async () => { for (const t of working) await api.post(`/api/tasks/${t.id}/cancel`).catch(() => {}); };
  const reset = async () => {
    if (!(await confirmDialog({ title: 'Start a new conversation?', message: `${agent?.name} will forget this chat (saved memories are kept).`, confirm: 'New conversation' }))) return;
    await api.del(`/api/agents/${agentId}/thread`).catch(toastError);
    setTurns([]); setLive({});
  };

  if (!agent) return null;
  const role = (agent.role + ' ' + agent.instructions).toLowerCase();
  const sugg = /lead|coordinat/.test(role) ? SUGGEST.lead : /research/.test(role) ? SUGGEST.research : /writ/.test(role) ? SUGGEST.write : /review|qa/.test(role) ? SUGGEST.review : SUGGEST.default;
  const provider = providers.find((p) => p.id === agent.provider);
  const unconfigured = provider && !provider.configured;

  const turnView = (t, liveSteps, stream) => {
    const steps = t.steps?.length ? t.steps : liveSteps || [];
    const failed = t.status?.state === 'failed';
    const canceled = t.status?.state === 'canceled';
    return html`<div key=${t.taskId || t.id}>
      <div class="msg me"><div class="bubble md" dangerouslySetInnerHTML=${{ __html: markdown(t.input) }}></div></div>
      <div class="msg them" style="margin-top:10px">
        ${steps.length ? html`<div class="steps">${steps.map((s, i) => html`<${Step} key=${i} s=${s} />`)}</div>` : null}
        ${t.reply ? html`<div class="bubble md" dangerouslySetInnerHTML=${{ __html: markdown(t.reply) }}></div>`
          : failed ? html`<div class="msg error"><div class="bubble"><div class="row" style="gap:8px;align-items:flex-start"><${Icon} name="alert" size=${16} style="color:var(--red);flex:none;margin-top:2px" /><div>${t.status.message}${/Settings|API key/i.test(t.status.message || '') ? html`<div style="margin-top:8px"><button class="btn sm" onClick=${() => go('/settings')}>Open Settings</button></div>` : null}</div></div></div></div>`
          : canceled ? html`<div class="meta"><${Icon} name="stop" size=${12} /> Stopped</div>`
          : stream ? html`<div class="bubble md" dangerouslySetInnerHTML=${{ __html: markdown(stream) }}></div>`
          : html`<div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div>`}
        ${t.createdAt && !stream ? html`<div class="meta">${timeAgo(t.createdAt)}</div>` : null}
      </div>
    </div>`;
  };

  return html`<div class="chat">
    ${!compact ? null : null}
    <div class="chat-log" ref=${logRef} aria-live="polite">
      ${loading ? html`<div class="muted small" style="text-align:center;padding:20px">Loading…</div>` : null}
      ${!loading && !turns.length && !working.length && !pending ? html`<div class="empty" style="padding:28px 8px">
          <div class="icon-wrap"><${Icon} name="chat" size=${22} /></div>
          <h3>Chat with ${agent.name}</h3>
          <p>${agent.role}. ${agent.a2a?.enabled ? `${agent.name} can bring in colleagues when it helps.` : ''}</p>
        </div>` : null}
      ${turns.map((t) => turnView(t, live[t.taskId]))}
      ${working.filter((w) => !turns.some((t) => t.taskId === w.id)).map((w) => turnView({ ...w, input: w.input, reply: null }, live[w.id], streams[w.id]))}
      ${pending && !working.some((w) => w.id === pending.taskId) && !turns.some((t) => t.taskId === pending.taskId) ? turnView({ id: 'pending', input: pending.input }, [], '') : null}
    </div>
    ${!turns.length && !working.length && !pending && !loading ? html`<div class="suggestions">${sugg.map((s) => html`<button class="chip" onClick=${() => send(s)}>${s}</button>`)}</div>` : null}
    <div class="composer">
      ${unconfigured ? html`<div class="callout amber" style="margin-bottom:8px;font-size:12.5px"><${Icon} name="key" size=${15} /><div>${provider.name} has no API key yet. <a href="#/settings">Add one in Settings</a> or switch this agent to the Simulated brain.</div></div>` : null}
      <div class="composer-box">
        <textarea ref=${taRef} rows="1" placeholder=${`Message ${agent.name}…`} aria-label=${`Message ${agent.name}`} value=${text}
          onInput=${(e) => setText(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } else if (e.key === 'Escape') e.target.blur(); }}></textarea>
        ${working.length ? html`<button class="btn sm" onClick=${stop} title="Stop"><${Icon} name="stop" size=${13} />Stop</button>` : null}
        <button class="btn primary sm icon" onClick=${() => send()} disabled=${!text.trim()} aria-label="Send"><${Icon} name="send" size=${15} /></button>
      </div>
      <div class="hint">
        <span><span class="kbd">↵</span> send · <span class="kbd">⇧↵</span> new line</span>
        <span class="spacer"></span>
        ${turns.length ? html`<button class="btn xs ghost" onClick=${reset}><${Icon} name="refresh" size=${12} />New conversation</button>` : null}
      </div>
    </div>
  </div>`;
}
