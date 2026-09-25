/** Agent looks (colour, antenna, accessory) and the 2D robot portraits used across the UI. The 3D bots in the colony read the same looks. */
export const SKINS = ['#F2C9A4', '#E0AC83', '#C68A62', '#9C6644', '#6F4A33', '#FAD7BD'];
export const HAIR_COLORS = ['#2A1E1A', '#5A3825', '#8C5A2B', '#D9A84E', '#B8452F', '#E8E3DA', '#3A3F58'];
export const HAIR_STYLES = ['short', 'long', 'bun', 'buzz', 'curly', 'none'];
export const ACCESSORIES = ['none', 'glasses', 'headset', 'cap', 'beanie'];

export function hashCode(s = '') { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

export function shade(hex, amt) {
  const c = hex.replace('#', '');
  const n = parseInt(c.length === 3 ? c.split('').map((x) => x + x).join('') : c, 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.max(0, Math.min(255, Math.round(r + (amt > 0 ? (255 - r) * amt : r * amt))));
  g = Math.max(0, Math.min(255, Math.round(g + (amt > 0 ? (255 - g) * amt : g * amt))));
  b = Math.max(0, Math.min(255, Math.round(b + (amt > 0 ? (255 - b) * amt : b * amt))));
  return `rgb(${r},${g},${b})`;
}

export function looks(agent) {
  const a = agent.avatar || {};
  const h = hashCode(agent.id || agent.name || '');
  return {
    color: a.color || '#7C5CFF',
    skin: a.skin || SKINS[h % SKINS.length],
    hairColor: a.hairColor || HAIR_COLORS[(h >> 3) % HAIR_COLORS.length],
    hair: a.hair || 'short',
    accessory: a.accessory || 'none',
  };
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Robot citizen of Planet Atrium. Feet (hover point) at (x, y).
 * Agent colour → chassis. Hair style → head/antenna variant. Accessory → visor, ear discs, fin or dish.
 */
export function drawRobot(ctx, L, x, y, opts = {}) {
  const s = opts.s || 1;
  const f = opts.facing || 1;
  const moving = !!opts.moving;
  const sitting = !!opts.sitting;
  const now = opts.now ?? performance.now();
  const ph = opts.walk || 0;
  const hover = Math.sin(now / 420 + (x + y) * 0.05) * 1.3;
  const tilt = moving ? f * 0.07 : 0;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  if (opts.alpha != null) ctx.globalAlpha = opts.alpha;

  // shadow + thruster glow on the ground
  if (!sitting) {
    ctx.fillStyle = 'rgba(0,0,0,0.26)';
    ctx.beginPath(); ctx.ellipse(0, 0, 9 - hover * 0.4, 3.8, 0, 0, Math.PI * 2); ctx.fill();
    const gl = ctx.createRadialGradient(0, 0, 0, 0, 0, 10);
    gl.addColorStop(0, 'rgba(120,230,255,0.55)'); gl.addColorStop(1, 'rgba(120,230,255,0)');
    ctx.fillStyle = gl; ctx.beginPath(); ctx.ellipse(0, -0.5, 10, 4.4, 0, 0, Math.PI * 2); ctx.fill();
  }
  if (opts.highlight) {
    ctx.strokeStyle = opts.highlight; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(0, 0, 13, 5.6, 0, 0, Math.PI * 2); ctx.stroke();
  }
  const lift = sitting ? 4 : -4 - hover - (moving ? Math.abs(Math.sin(ph)) * 0.8 : 0);
  ctx.translate(0, lift);
  ctx.rotate(tilt);

  // thruster cone
  if (!sitting) {
    const flick = 0.75 + Math.sin(now / 45) * 0.15 + (moving ? 0.25 : 0);
    const tg = ctx.createLinearGradient(0, -9, 0, 4 * flick);
    tg.addColorStop(0, 'rgba(180,245,255,0.95)'); tg.addColorStop(1, 'rgba(90,200,255,0)');
    ctx.fillStyle = tg;
    ctx.beginPath(); ctx.moveTo(-3.6, -9); ctx.lineTo(3.6, -9); ctx.lineTo(0, 4 * flick + 2); ctx.closePath(); ctx.fill();
  }
  // hover base
  ctx.fillStyle = '#2a3142';
  rr(ctx, -5.5, -11.5, 11, 3.6, 1.8); ctx.fill();
  ctx.fillStyle = 'rgba(140,235,255,0.9)';
  rr(ctx, -3.5, -9.2, 7, 1.2, 0.6); ctx.fill();

  // chassis
  const c = L.color;
  const g = ctx.createLinearGradient(-9, 0, 9, 0);
  g.addColorStop(0, shade(c, 0.35)); g.addColorStop(0.45, c); g.addColorStop(1, shade(c, -0.3));
  ctx.fillStyle = g;
  rr(ctx, -8, -24, 16, 13.5, 5); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  rr(ctx, -6.5, -23, 4, 11, 2); ctx.fill();
  // chest core
  const pulse = 0.55 + 0.45 * Math.sin(now / (opts.bob ? 160 : 600));
  ctx.fillStyle = `rgba(210,250,255,${0.55 + pulse * 0.45})`;
  ctx.beginPath(); ctx.arc(f * 1.4, -17.5, 2.1, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = shade(c, -0.45); ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.arc(f * 1.4, -17.5, 3.1, 0, Math.PI * 2); ctx.stroke();

  // arms
  const sw = moving ? Math.sin(ph) * 2.4 : Math.sin(now / 700) * 0.6;
  ctx.fillStyle = shade(c, -0.15);
  rr(ctx, -11, -22 + sw, 3, 9, 1.5); ctx.fill();
  rr(ctx, 8, -22 - sw, 3, 9, 1.5); ctx.fill();
  ctx.fillStyle = '#d7dde9';
  ctx.beginPath(); ctx.arc(-9.5, -12.5 + sw, 1.9, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(9.5, -12.5 - sw, 1.9, 0, Math.PI * 2); ctx.fill();

  // neck + head
  ctx.fillStyle = '#586074';
  ctx.fillRect(-1.6, -26.5, 3.2, 3);
  const hy = -34;
  const shell = shade(L.skin || '#dfe4ee', 0.55);
  const hg = ctx.createLinearGradient(-8, hy - 7, 8, hy + 7);
  hg.addColorStop(0, '#ffffff'); hg.addColorStop(0.5, shell); hg.addColorStop(1, shade(shell, -0.28));
  ctx.fillStyle = hg;
  const variant = L.hair || 'short';
  if (variant === 'buzz') { ctx.beginPath(); ctx.arc(0, hy, 8, 0, Math.PI * 2); ctx.fill(); }
  else if (variant === 'long') { rr(ctx, -7.5, hy - 9, 15, 16, 5); ctx.fill(); }
  else { rr(ctx, -8.5, hy - 7, 17, 13.5, 5); ctx.fill(); }
  if (variant === 'bun') {
    ctx.fillStyle = shade(c, 0.2);
    ctx.beginPath(); ctx.arc(0, hy - 6.5, 5.2, Math.PI, 0); ctx.fill();
  }
  // face screen
  ctx.fillStyle = '#131826';
  rr(ctx, -6.4, hy - 3.8, 12.8, 8, 3); ctx.fill();
  const blink = (Math.floor(now / 90) + Math.floor(x)) % 47 === 0;
  const eye = L.accessory === 'glasses' ? '#ff7ad9' : '#7ff3ff';
  ctx.fillStyle = eye;
  ctx.shadowColor = eye; ctx.shadowBlur = 4;
  if (L.accessory === 'glasses') { rr(ctx, -5.2 + f, hy - 1.4, 10.4, 2.6, 1.3); ctx.fill(); }
  else if (blink) { ctx.fillRect(-3.8 + f * 1.4, hy, 2.6, 0.8); ctx.fillRect(1.2 + f * 1.4, hy, 2.6, 0.8); }
  else {
    rr(ctx, -3.9 + f * 1.4, hy - 1.6, 2.6, 3.4, 1.2); ctx.fill();
    rr(ctx, 1.3 + f * 1.4, hy - 1.6, 2.6, 3.4, 1.2); ctx.fill();
  }
  ctx.shadowBlur = 0;
  if (opts.bob) { // "talking/typing" mouth flicker
    ctx.fillStyle = eye; ctx.globalAlpha *= 0.8;
    ctx.fillRect(-1.6 + f * 1.4, hy + 2.6, 3.2, 0.8);
    ctx.globalAlpha = opts.alpha ?? 1;
  }

  // antennae / variants
  const tip = (ax, ay) => {
    ctx.strokeStyle = '#8a93a8'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(ax, hy - 6.5); ctx.lineTo(ax, ay); ctx.stroke();
    const on = Math.sin(now / 300 + ax) > 0;
    ctx.fillStyle = on ? shade(c, 0.4) : shade(c, -0.1);
    ctx.shadowColor = c; ctx.shadowBlur = on ? 6 : 0;
    ctx.beginPath(); ctx.arc(ax, ay, 1.9, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
  };
  if (variant === 'short') tip(f * 2, hy - 13);
  else if (variant === 'long') { tip(-4, hy - 14); tip(4, hy - 14); }
  else if (variant === 'curly') {
    ctx.strokeStyle = '#8a93a8'; ctx.lineWidth = 1.1; ctx.beginPath();
    for (let i = 0; i <= 12; i++) { const yy = hy - 6.5 - i * 0.7; const xx = Math.sin(i * 1.4) * 1.8; i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); }
    ctx.stroke(); tip(0, hy - 16);
  } else if (variant === 'buzz') {
    ctx.fillStyle = '#8a93a8';
    ctx.beginPath(); ctx.arc(-8, hy, 1.4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(8, hy, 1.4, 0, Math.PI * 2); ctx.fill();
  }
  // accessories
  if (L.accessory === 'headset') {
    ctx.fillStyle = shade(c, -0.25);
    ctx.beginPath(); ctx.ellipse(-8.8, hy, 2.2, 3.6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(8.8, hy, 2.2, 3.6, 0, 0, Math.PI * 2); ctx.fill();
  } else if (L.accessory === 'cap') {
    ctx.fillStyle = shade(c, -0.2);
    ctx.beginPath(); ctx.moveTo(-2, hy - 6.8); ctx.lineTo(0, hy - 13); ctx.lineTo(2, hy - 6.8); ctx.closePath(); ctx.fill();
  } else if (L.accessory === 'beanie') {
    ctx.strokeStyle = '#8a93a8'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-5, hy - 6.5); ctx.lineTo(-7, hy - 11); ctx.stroke();
    ctx.fillStyle = '#d7dde9';
    ctx.beginPath(); ctx.ellipse(-7.5, hy - 12, 3.8, 1.8, -0.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

/** Portrait avatar used across the UI. */
export function drawPortrait(canvas, agent, size = 48, { ring = false } = {}) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr; canvas.height = size * dpr;
  canvas.style.width = `${size}px`; canvas.style.height = `${size}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const L = looks(agent);
  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, '#1b1446'); g.addColorStop(1, shade(L.color, -0.35));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  for (let i = 0; i < 6; i++) { const h = hashCode(`${agent.id}${i}`); ctx.fillRect((h % 97) / 97 * size, ((h >> 7) % 61) / 61 * size * 0.5, 1, 1); }
  ctx.fillStyle = 'rgba(127,243,255,0.18)';
  ctx.beginPath(); ctx.arc(size * 0.5, size * 1.05, size * 0.62, 0, Math.PI * 2); ctx.fill();
  drawRobot(ctx, L, size / 2, size * 1.36, { s: size / 30, facing: 1, sitting: true, now: 0 });
  if (ring) { ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 2; ctx.strokeRect(1, 1, size - 2, size - 2); }
}
