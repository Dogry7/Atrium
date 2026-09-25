/**
 * Crisp HTML labels over the 3D world: name plates with a status dot, action badges
 * (! ⚒ ✓ ?), speech bubbles, and small labels for the hub's relays and the Laya beacon.
 * Positions are written straight to `transform` every frame; nothing here re-renders Preact.
 */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class Overlay {
  constructor(parent) {
    this.el = document.createElement('div');
    this.el.className = 'world-overlay';
    this.el.setAttribute('aria-hidden', 'true');
    parent.appendChild(this.el);
    this.items = new Map(); // id → { tag, badge, bubbles: [], dot }
    this.labels = new Map();
  }

  #item(id) {
    let it = this.items.get(id);
    if (!it) {
      const wrap = document.createElement('div'); wrap.className = 'wo-bot'; wrap.dataset.id = id;
      wrap.innerHTML = '<div class="wo-stack"></div><div class="wo-badge" hidden></div><div class="wo-tag"><span class="wo-dot"></span><span class="wo-name"></span></div>';
      this.el.appendChild(wrap);
      it = { wrap, stack: wrap.children[0], badge: wrap.children[1], tag: wrap.children[2], dot: wrap.querySelector('.wo-dot'), name: wrap.querySelector('.wo-name'), bubbles: [], last: {} };
      this.items.set(id, it);
    }
    return it;
  }

  /** Update a bot's plate. */
  set(id, { name, tone, badge, showName, selected, hovered, visitor, sleeping }) {
    const it = this.#item(id), L = it.last;
    if (L.name !== name) { it.name.textContent = name; L.name = name; }
    if (L.tone !== tone) { it.dot.dataset.tone = tone; L.tone = tone; }
    const b = badge ? `${badge.icon}|${badge.tone}|${badge.label}` : '';
    if (L.badge !== b) {
      L.badge = b; it.badge.hidden = !badge;
      if (badge) { it.badge.textContent = badge.icon; it.badge.dataset.tone = badge.tone; it.badge.title = badge.label; }
    }
    const cls = `wo-bot${selected ? ' sel' : ''}${hovered ? ' hov' : ''}${showName ? '' : ' no-name'}${visitor ? ' visitor' : ''}${sleeping ? ' sleeping' : ''}`;
    if (L.cls !== cls) { it.wrap.className = cls; L.cls = cls; }
  }

  /** Put a bot's plate at a screen point (x, y = top of head) or hide it. `k` scales with distance. */
  place(id, x, y, visible, k = 1, z = 0) {
    const it = this.items.get(id); if (!it) return;
    if (!visible) { if (!it.hidden) { it.wrap.style.display = 'none'; it.hidden = true; } return; }
    if (it.hidden) { it.wrap.style.display = ''; it.hidden = false; }
    it.wrap.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${k.toFixed(3)})`;
    it.wrap.style.zIndex = String(1000 + Math.round(z));
    it.x = x; it.y = y; it.k = k;
  }

  say(id, text, { kind = 'speech', ms = 4200 } = {}) {
    const it = this.#item(id);
    const clean = String(text ?? '').replace(/\*\*|[*`]|^#+\s|^>\s?/gm, '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    it.bubbles = it.bubbles.filter((b) => { const drop = b.kind === kind || (kind === 'speech' && b.kind === 'think'); if (drop) b.el.remove(); return !drop; });
    const el = document.createElement('div');
    el.className = `wo-bubble ${kind}`;
    const shown = clean.length > 120 ? clean.slice(0, 118) + '…' : clean;
    el.innerHTML = kind === 'think' ? '<span></span><span></span><span></span>' : `${kind === 'tool' ? '<b>⚙</b> ' : kind === 'error' ? '<b>⚠</b> ' : ''}${esc(shown)}`;
    it.stack.appendChild(el);
    const b = { el, kind, until: performance.now() + ms, text: shown };
    it.bubbles.push(b);
    while (it.bubbles.length > 2) it.bubbles.shift().el.remove();
  }
  clear(id, kind) { const it = this.items.get(id); if (!it) return; it.bubbles = it.bubbles.filter((b) => { if (!kind || b.kind === kind) { b.el.remove(); return false; } return true; }); }
  bubbles(id) { return this.items.get(id)?.bubbles || []; }

  /** Expire bubbles and fade them near the end. */
  tick(now) {
    for (const it of this.items.values()) {
      it.bubbles = it.bubbles.filter((b) => {
        const left = b.until - now;
        if (left <= 0) { b.el.remove(); return false; }
        b.el.style.opacity = left < 400 ? String(left / 400) : '';
        return true;
      });
    }
  }

  remove(id) { const it = this.items.get(id); if (it) { it.wrap.remove(); this.items.delete(id); } }

  // ------------------------------------------------------------------ small labels (relays, Laya, vacant lots)
  label(key, text, cls = '') {
    let l = this.labels.get(key);
    if (!l) { l = document.createElement('div'); l.className = `wo-label ${cls}`; this.el.appendChild(l); this.labels.set(key, l); }
    if (l.textContent !== text) l.textContent = text;
    if (l.dataset.cls !== cls) { l.className = `wo-label ${cls}`; l.dataset.cls = cls; }
    return l;
  }
  placeLabel(key, x, y, visible) {
    const l = this.labels.get(key); if (!l) return;
    l.style.display = visible ? '' : 'none';
    if (visible) l.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  }
  dropLabel(key) { const l = this.labels.get(key); if (l) { l.remove(); this.labels.delete(key); } }
  labelKeys() { return [...this.labels.keys()]; }

  destroy() { this.el.remove(); }
}
