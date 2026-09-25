import { html, useEffect, useLayoutEffect, useRef, useState } from '../lib/preact-htm.js';
import { Icon } from './icons.js';
import { drawPortrait } from './world/character.js';
import { toast, useStore } from './state.js';

export function Avatar({ agent, size = 40, busy, radius }) {
  const ref = useRef();
  const key = JSON.stringify([agent?.id, agent?.name, agent?.avatar, size]);
  useEffect(() => { if (ref.current && agent) drawPortrait(ref.current, agent, size); }, [key]);
  return html`<div class="avatar" style=${{ width: size, height: size, borderRadius: radius ?? Math.round(size * 0.3) }}>
    <canvas ref=${ref} aria-hidden="true"></canvas>
    ${busy ? html`<span class="busy status-dot accent"></span>` : null}
  </div>`;
}

export function Modal({ title, onClose, children, footer, wide, icon, labelledBy = 'modal-title', class: cls = '' }) {
  const ref = useRef();
  useLayoutEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } };
    addEventListener('keydown', onKey);
    const prev = document.activeElement;
    ref.current?.querySelector('[autofocus], input, textarea, select, button.primary')?.focus();
    return () => { removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, []);
  return html`<div class="overlay" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
    <div class=${`modal ${wide ? 'wide' : ''} ${cls}`} role="dialog" aria-modal="true" aria-labelledby=${labelledBy} ref=${ref}>
      <div class="modal-head">
        ${icon ? html`<${Icon} name=${icon} size=${18} />` : null}
        <h3 id=${labelledBy}>${title}</h3>
        <button class="btn ghost icon sm" onClick=${onClose} aria-label="Close"><${Icon} name="x" size=${16} /></button>
      </div>
      ${children}
      ${footer ? html`<div class="modal-foot">${footer}</div>` : null}
    </div>
  </div>`;
}

let confirmResolver = null;
export function confirmDialog(opts) {
  return new Promise((resolve) => { confirmResolver = resolve; window.dispatchEvent(new CustomEvent('atrium:confirm', { detail: opts })); });
}
export function ConfirmHost() {
  const [opts, setOpts] = useState(null);
  useEffect(() => { const fn = (e) => setOpts(e.detail); addEventListener('atrium:confirm', fn); return () => removeEventListener('atrium:confirm', fn); }, []);
  if (!opts) return null;
  const close = (v) => { setOpts(null); confirmResolver?.(v); };
  return html`<${Modal} title=${opts.title || 'Are you sure?'} onClose=${() => close(false)} footer=${html`
      <button class="btn ghost" onClick=${() => close(false)}>Cancel</button>
      <button class=${`btn ${opts.danger ? 'danger-solid' : 'primary'}`} onClick=${() => close(true)} autofocus>${opts.confirm || 'Confirm'}</button>`}>
    <div class="modal-body"><p style="margin:0;color:var(--text-2)">${opts.message}</p></div>
  <//>`;
}

export function Field({ label, help, error, children, htmlFor, right }) {
  return html`<div class="field">
    ${label ? html`<label for=${htmlFor}>${label}${right ? html`<span class="spacer"></span>${right}` : null}</label>` : null}
    ${children}
    ${error ? html`<div class="err" role="alert">${error}</div>` : help ? html`<div class="help">${help}</div>` : null}
  </div>`;
}

export function Toggle({ on, onChange, label, id }) {
  return html`<button type="button" id=${id} role="switch" aria-checked=${on ? 'true' : 'false'} aria-label=${label} class=${`toggle ${on ? 'on' : ''}`} onClick=${() => onChange(!on)}></button>`;
}

export function Seg({ value, options, onChange, label }) {
  return html`<div class="seg" role="radiogroup" aria-label=${label}>
    ${options.map((o) => html`<button type="button" role="radio" aria-checked=${value === o.value ? 'true' : 'false'} class=${value === o.value ? 'on' : ''} onClick=${() => onChange(o.value)}>${o.icon ? html`<${Icon} name=${o.icon} size=${14} />` : null}${o.label}</button>`)}
  </div>`;
}

export function Tabs({ value, tabs, onChange }) {
  return html`<div class="tabs" role="tablist">
    ${tabs.map((t) => html`<button role="tab" aria-selected=${value === t.value ? 'true' : 'false'} class=${value === t.value ? 'on' : ''} onClick=${() => onChange(t.value)}>${t.icon ? html`<${Icon} name=${t.icon} size=${14} />` : null}${t.label}${t.count ? html`<span class="badge" style="height:18px;padding:0 6px">${t.count}</span>` : null}</button>`)}
  </div>`;
}

export function Empty({ icon = 'sparkles', title, children, action }) {
  return html`<div class="empty">
    <div class="icon-wrap"><${Icon} name=${icon} size=${24} /></div>
    <h3>${title}</h3>
    ${children ? html`<p>${children}</p>` : null}
    ${action || null}
  </div>`;
}

export function CopyField({ value, label = 'Copy' }) {
  return html`<div class="copy-field">
    <input class="input" readonly value=${value} onFocus=${(e) => e.target.select()} />
    <button class="btn icon" title=${label} aria-label=${label} onClick=${() => copy(value)}><${Icon} name="copy" size=${15} /></button>
  </div>`;
}

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard', 'success', 1800); }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied to clipboard', 'success', 1800); } catch { toast('Could not copy', 'error'); }
    ta.remove();
  }
}

export function StatusBadge({ status }) {
  const map = {
    ready: ['green', 'Connected'], starting: ['amber', 'Starting…'], error: ['red', 'Error'], idle: ['', 'Not started'], disabled: ['', 'Disabled'],
    running: ['accent', 'Running'], completed: ['green', 'Completed'], failed: ['red', 'Failed'], canceled: ['', 'Cancelled'], working: ['accent', 'Working'],
  };
  const [c, l] = map[status] || ['', status];
  return html`<span class=${`badge ${c}`}><span class=${`status-dot ${c}`} style="width:6px;height:6px;box-shadow:none"></span>${l}</span>`;
}

export function Toasts() {
  const list = useStore((s) => s.toasts);
  const icon = { success: 'ok', error: 'errc', info: 'info' };
  return html`<div class="toasts" role="status" aria-live="polite">
    ${list.map((t) => html`<div class=${`toast ${t.type}`} key=${t.id}><${Icon} class="t-icon" name=${icon[t.type] || 'info'} size=${17} /><div>${t.message}</div></div>`)}
  </div>`;
}

export function useAutosize(ref, value) {
  useEffect(() => {
    const el = ref.current; if (!el) return;
    el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, [value]);
}

export function Spinner() { return html`<span class="spinner" aria-label="Loading"></span>`; }

/** Render a dynamic config form from a plugin's configFields. */
export function ConfigForm({ fields, value, onChange, idPrefix = 'cfg' }) {
  const visible = (f) => {
    if (!f.showIf) return true;
    return Object.entries(f.showIf).every(([k, v]) => (Array.isArray(v) ? v.includes(value[k] ?? fields.find((x) => x.key === k)?.default) : (value[k] ?? fields.find((x) => x.key === k)?.default) === v));
  };
  const set = (k, v) => onChange({ ...value, [k]: v });
  return html`${fields.filter(visible).map((f) => {
    const id = `${idPrefix}-${f.key}`;
    const v = value[f.key] ?? '';
    let input;
    if (f.type === 'select') input = html`<select id=${id} class="select" value=${v || f.default || ''} onChange=${(e) => set(f.key, e.target.value)}>${f.options.map((o) => html`<option value=${o.value}>${o.label}</option>`)}</select>`;
    else if (f.type === 'json' || f.type === 'textarea') input = html`<textarea id=${id} class="textarea mono" rows="3" placeholder=${f.type === 'json' ? '{ }' : ''} value=${typeof v === 'object' ? JSON.stringify(v, null, 2) : v} onInput=${(e) => set(f.key, e.target.value)}></textarea>`;
    else input = html`<input id=${id} class=${`input ${f.type === 'password' ? 'mono' : ''}`} type=${f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'} autocomplete="off" spellcheck="false" placeholder=${f.default != null ? String(f.default) : ''} value=${v} onInput=${(e) => set(f.key, f.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} />`;
    return html`<${Field} label=${html`${f.label}${f.required ? html`<span style="color:var(--red)">*</span>` : null}`} help=${f.help} htmlFor=${id}>${input}<//>`;
  })}`;
}
