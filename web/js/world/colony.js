/**
 * The colony's layout and rules: pure data and maths, no three.js, so it is unit-tested in Node.
 *
 * The colony is a hex grid seen from above. The hub (0,0) holds the landing pad, the Laya beacon
 * and one relay tower per connector. Every agent owns one hex plot around it (`agent.plot` is an
 * index into the spiral below, assigned by the server so plots never move), and the habitat on
 * that plot grows as the agent finishes tasks.
 */

export const HEX = 7.4;          // centre → corner of a grid cell (world units; a bot is ~1.2 tall)
export const DECK = 6.05;        // centre → corner of a plot deck (the gap between decks is the street)
export const DECK_H = 0.28;      // deck height
export const BOT_SCALE = 0.56;   // the KayKit mannequin is 2.2 units tall
export const BUILD_SCALE = 1.5;  // Space Base Bits modules are 2×1×2
export const MAX_RINGS = 4;      // 6 + 12 + 18 + 24 = 60 plots
const SQ3 = Math.sqrt(3);

// ------------------------------------------------------------------ hex maths (pointy-top axial)
export const HEX_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
export const hexToWorld = (q, r, size = HEX) => ({ x: size * SQ3 * (q + r / 2), z: size * 1.5 * r });
export function worldToHex(x, z, size = HEX) {
  const q = (SQ3 / 3 * x - z / 3) / size, r = (2 / 3 * z) / size;
  return hexRound(q, r);
}
export function hexRound(q, r) {
  let s = -q - r;
  let rq = Math.round(q), rr = Math.round(r); const rs = Math.round(s);
  const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs; else if (dr > ds) rr = -rq - rs;
  return { q: rq + 0, r: rr + 0 };
}
export const hexDistance = (a, b = { q: 0, r: 0 }) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
/** Corner k (0..5) of a pointy-top hex. */
export const hexCorner = (cx, cz, size, k) => { const a = Math.PI / 180 * (60 * k - 30); return { x: cx + size * Math.cos(a), z: cz + size * Math.sin(a) }; };
/** Is (x,z) inside a pointy-top hex of this size centred at (cx,cz)? */
export function inHex(x, z, cx, cz, size) {
  const dx = Math.abs(x - cx), dz = Math.abs(z - cz);
  const h = size * SQ3 / 2; // centre → flat side
  return dx <= h && dx * 0.5 + dz * (SQ3 / 2) <= h;
}

/** The ring of cells at distance `radius`, walking round from the south-east so plot 0 faces the camera. */
export function hexRing(radius) {
  if (radius === 0) return [{ q: 0, r: 0 }];
  const out = [];
  let q = HEX_DIRS[4][0] * radius, r = HEX_DIRS[4][1] * radius;
  for (let side = 0; side < 6; side++) for (let step = 0; step < radius; step++) {
    out.push({ q, r });
    q += HEX_DIRS[side][0]; r += HEX_DIRS[side][1];
  }
  return out;
}
/** Every plot cell in order: ring 1, then ring 2, … (the hub, ring 0, is not a plot). */
export const PLOT_CELLS = (() => { const c = []; for (let k = 1; k <= MAX_RINGS; k++) c.push(...hexRing(k)); return c; })();
export const MAX_PLOTS = PLOT_CELLS.length;

/** The first plot index nobody holds. Used by the server when an agent is created. */
export function nextPlot(taken) {
  const t = new Set(taken.filter((n) => Number.isInteger(n)));
  for (let i = 0; i < MAX_PLOTS; i++) if (!t.has(i)) return i;
  return t.size; // past the edge: still unique, laid out on the outer ring by plotCell()
}
/** The cell for a plot index (wraps onto further rings if a team ever outgrows 60 plots). */
export function plotCell(index) {
  if (index < MAX_PLOTS) return PLOT_CELLS[index];
  let i = index - MAX_PLOTS, k = MAX_RINGS + 1;
  for (;;) { const ring = hexRing(k); if (i < ring.length) return ring[i]; i -= ring.length; k++; }
}

// ------------------------------------------------------------------ a plot's furniture
/**
 * Where things sit on a plot. The front of the plot faces the hub, the habitat sits at the back,
 * the bot works in front of it, and its bench is off to one side.
 */
export function plotLayout(index) {
  const cell = plotCell(index);
  const c = hexToWorld(cell.q, cell.r);
  const len = Math.hypot(c.x, c.z) || 1;
  const fx = -c.x / len, fz = -c.z / len;       // unit vector towards the hub
  const sx = -fz, sz = fx;                        // unit vector along the plot's front edge
  const at = (f, s) => ({ x: c.x + fx * f + sx * s, z: c.z + fz * f + sz * s });
  const facing = Math.atan2(fx, fz);             // a model's +z turned towards the hub
  return {
    index, cell, center: { x: c.x, z: c.z }, facing,
    building: at(-1.7, 0.2),                      // habitat anchor (back of the plot)
    work: at(0.9, 0.2),                           // where the bot hammers / types
    bench: at(1.0, 2.8),                          // where it sits and naps
    flag: at(3.6, 2.4),                           // flag pole at the front corner
    lamp: at(3.6, -3.5),
    wander: [at(3.0, 0.8), at(2.4, -1.2), at(1.9, 1.6), at(2.6, 2.6), at(1.9, -2.8)],
  };
}

// ------------------------------------------------------------------ habitat growth
/** Tasks completed → habitat level (0..6). Log-ish, so early work shows quickly. */
export const LEVELS = [0, 1, 3, 6, 12, 25, 50];
export function levelFor(tasks = 0) {
  let l = 0;
  for (let i = 0; i < LEVELS.length; i++) if (tasks >= LEVELS[i]) l = i;
  return l;
}
export const nextLevelAt = (tasks = 0) => LEVELS.find((n) => n > tasks) ?? null;

/**
 * The pieces of a habitat at each level, in plot-local space (x along the front edge, z towards
 * the hub, both in units of the module grid before BUILD_SCALE; y is the stacking height).
 * Each level keeps everything below it and adds its own pieces, so growth is additive.
 */
export const PIECES = [
  // level 0: a starter pod and a crate
  [{ part: 'basemodule_A', x: 0, z: 0 }, { part: 'cargo_A', x: 1.1, z: 0.95, s: 0.8 }],
  // 1: solar panels behind the pod
  [{ part: 'solarpanel', x: -0.4, z: -1.5 }, { part: 'solarpanel', x: 0.45, z: -1.5 }],
  // 2: a solar roof
  [{ part: 'roofmodule_solarpanels', x: 0, z: 0, y: 1 }],
  // 3: a second module and a small turbine
  [{ part: 'basemodule_C', x: 2.05, z: 0.1 }, { part: 'windturbine_low', x: 1.5, z: -1.4 }],
  // 4: a garage with a rover
  [{ part: 'basemodule_garage', x: -2.05, z: -0.35 }, { part: 'spacetruck', x: -2.6, z: 1.3, rot: 0.35 }],
  // 5: cargo on the roof, a tall turbine out front, a stack of crates
  [{ part: 'roofmodule_cargo_A', x: 2.05, z: 0.1, y: 1 }, { part: 'windturbine_tall', x: -1.2, z: 1.6 }, { part: 'cargo_B_stacked', x: 2.4, z: 1.35 }],
  // 6: a dome on the garage
  [{ part: 'basemodule_E', x: -2.05, z: -0.35, y: 1 }],
];
export function piecesFor(level) {
  const out = [];
  for (let l = 0; l <= Math.min(level, PIECES.length - 1); l++) for (const p of PIECES[l]) out.push({ ...p, level: l });
  return out;
}
/** Footprint radius of the habitat (for walking round it), in world units. */
export const habitatRadius = (level) => (level >= 3 ? 3.6 : level >= 1 ? 2.3 : 1.9) * (BUILD_SCALE / 1.5);

// ------------------------------------------------------------------ the hub
export const HUB = {
  pad: { x: 0, z: 0, r: 2.9 },
  lander: { x: 0, z: 0 },
  laya: { x: -3.6, z: 1.8 },
  relayRing: 5.0,                         // relay towers stand round the rim
  visitorSpots: [{ x: 2.7, z: 2.4 }, { x: 3.4, z: 0.6 }, { x: 1.2, z: 3.5 }, { x: 3.3, z: -1.3 }, { x: -0.8, z: 3.9 }, { x: 2.1, z: -2.9 }],
  spawn: { x: 1.4, z: 1.4 },
  hangouts: [{ x: 2.2, z: 3.6 }, { x: -2.6, z: -2.9 }, { x: 3.8, z: -0.4 }, { x: -3.9, z: -0.5 }],
};
/** Where relay tower k of n stands. Spread over the back of the hub, away from the Laya beacon. */
export function relaySpot(k, n) {
  const span = Math.min(Math.PI * 1.25, Math.max(0.6, n * 0.42));
  const a0 = -Math.PI / 2 - span / 2 - 0.35;
  const a = n <= 1 ? a0 + span / 2 : a0 + (span * k) / (n - 1);
  return { x: Math.cos(a) * HUB.relayRing, z: Math.sin(a) * HUB.relayRing };
}

// ------------------------------------------------------------------ planets & time
export const PLANETS = {
  terra: {
    id: 'terra', name: 'Terra', blurb: 'Green hills, forests and a blue sky',
    ground: ['#6ea35a', '#86b865', '#9cc27a'], far: '#5f8f52', deck: '#e4e7ee', kerb: '#9aa3b4', street: '#b9a784',
    sky: { day: ['#5fb0f0', '#cfe9ff'], dawn: ['#6f86c9', '#ffc59a'], dusk: ['#4a4f9c', '#ff9a7a'], night: ['#060b1f', '#1b2350'] },
    fog: { day: '#cfe3f5', night: '#0d1330' }, stars: 1, moon: 'moon', scatter: 'forest',
  },
  mars: {
    id: 'mars', name: 'Mars', blurb: 'Red dust, canyons and two small moons',
    ground: ['#b8643c', '#c97a4c', '#d99463'], far: '#9c5234', deck: '#e8e1da', kerb: '#8f7f78', street: '#a4583a',
    sky: { day: ['#d99a6c', '#f3d2b1'], dawn: ['#6c5a8f', '#f0a66e'], dusk: ['#3f3a6e', '#6fa6d8'], night: ['#0b0610', '#2a1624'] },
    fog: { day: '#f0cfae', night: '#1a0d16' }, stars: 1, moon: 'phobos', scatter: 'rocks',
  },
  luna: {
    id: 'luna', name: 'Luna', blurb: 'Grey regolith, craters and Earth overhead',
    ground: ['#8e9098', '#a3a5ad', '#b7b9c0'], far: '#7d7f87', deck: '#eceef3', kerb: '#8a8f9c', street: '#77797f',
    sky: { day: ['#02030a', '#11131f'], dawn: ['#02030a', '#161a2b'], dusk: ['#02030a', '#161a2b'], night: ['#000105', '#07091a'] },
    fog: { day: '#11131f', night: '#05060f' }, stars: 1, moon: 'earth', scatter: 'moon',
  },
};
export const PLANET_IDS = Object.keys(PLANETS);
export const TIMES = ['live', 'dawn', 'day', 'dusk', 'night'];
const FIXED = { dawn: 0.265, day: 0.47, dusk: 0.735, night: 0.02 };
/** 0..1 through the day (0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset). */
export function dayFraction(setting = 'live', date = new Date()) {
  if (FIXED[setting] != null) return FIXED[setting];
  return (date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds()) / 86400;
}
/** Sun elevation in -1..1 for a day fraction. */
export const sunHeight = (t) => Math.sin((t - 0.25) * Math.PI * 2);
export const isNight = (t) => sunHeight(t) < -0.05;

// ------------------------------------------------------------------ deterministic scatter
export function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const SCATTER_SETS = {
  forest: [
    { kit: 'forest', part: 'Tree_1_A_Color1', s: 0.55, w: 3, r: 1.0 }, { kit: 'forest', part: 'Tree_3_A_Color1', s: 0.6, w: 3, r: 1.0 },
    { kit: 'forest', part: 'Tree_4_A_Color1', s: 0.55, w: 2, r: 0.6 }, { kit: 'forest', part: 'Tree_1_C_Color1', s: 0.45, w: 1, r: 1.3, far: true },
    { kit: 'forest', part: 'Bush_1_E_Color1', s: 0.7, w: 4, r: 0.6 }, { kit: 'forest', part: 'Bush_3_B_Color1', s: 0.6, w: 3, r: 0.6 },
    { kit: 'forest', part: 'Grass_2_D_Color1', s: 0.7, w: 6, r: 0, deco: true }, { kit: 'forest', part: 'Rock_2_C_Color1', s: 0.6, w: 2, r: 0.5 },
    { kit: 'nature', part: 'tree_pineTallA', s: 2.6, w: 2, r: 0.6 }, { kit: 'nature', part: 'tree_pineRoundA', s: 2.4, w: 2, r: 0.7 },
    { kit: 'nature', part: 'flower_yellowA', s: 2.2, w: 4, r: 0, deco: true }, { kit: 'nature', part: 'flower_purpleA', s: 2.2, w: 3, r: 0, deco: true },
  ],
  rocks: [
    { kit: 'forest', part: 'Rock_1_D_Color1', s: 0.8, w: 4, r: 0.6, tint: '#c07048' }, { kit: 'forest', part: 'Rock_2_C_Color1', s: 0.8, w: 4, r: 0.6, tint: '#b86a44' },
    { kit: 'forest', part: 'Rock_3_E_Color1', s: 0.9, w: 3, r: 0.6, tint: '#a95e3c' }, { kit: 'forest', part: 'Rock_2_G_Color1', s: 0.55, w: 1, r: 1.4, tint: '#b36543', far: true },
    { kit: 'forest', part: 'Rock_3_Q_Color1', s: 0.5, w: 1, r: 1.6, tint: '#9e5536', far: true }, { kit: 'base', part: 'rocks_A', s: 1.4, w: 3, r: 0.8 },
    { kit: 'base', part: 'rock_B', s: 1.6, w: 4, r: 0.5 }, { kit: 'nature', part: 'rock_tallA', s: 2.0, w: 2, r: 0.7, tint: '#c47a52' },
  ],
  moon: [
    { kit: 'base', part: 'rocks_A', s: 1.5, w: 4, r: 0.8, tint: '#9ea1aa' }, { kit: 'base', part: 'rocks_B', s: 1.2, w: 2, r: 1.0, tint: '#8f929b' },
    { kit: 'base', part: 'rock_A', s: 1.8, w: 5, r: 0.4, tint: '#b3b5bc' }, { kit: 'base', part: 'rock_B', s: 1.6, w: 4, r: 0.5, tint: '#a0a3ab' },
    { kit: 'forest', part: 'Rock_1_J_Color1', s: 0.45, w: 1, r: 1.4, tint: '#a3a5ad', far: true },
  ],
};
/**
 * Seeded scatter for a planet: things between and around the plots, never on a deck or a street
 * line, and a denser belt outside the colony. `rings` is how many plot rings are in use.
 */
export function scatter(planetId, rings = 2, seed = 7) {
  const set = SCATTER_SETS[PLANETS[planetId]?.scatter || 'forest'];
  const rnd = mulberry32(seed * 131 + planetId.length * 7);
  const total = set.reduce((n, s) => n + s.w, 0);
  const pick = () => { let x = rnd() * total; for (const s of set) { x -= s.w; if (x <= 0) return s; } return set[0]; };
  const out = [];
  const colonyR = (rings + 0.55) * HEX * SQ3;
  const inner = colonyR, outer = colonyR + 48;
  const blocked = (x, z, pad) => {
    const h = worldToHex(x, z);
    const c = hexToWorld(h.q, h.r);
    if (hexDistance(h) <= rings && inHex(x, z, c.x, c.z, DECK + pad)) return true;   // on a deck
    return false;
  };
  // outer belt
  for (let i = 0; i < 280; i++) {
    const a = rnd() * Math.PI * 2, d = inner + 2 + Math.pow(rnd(), 0.8) * (outer - inner);
    const s = pick();
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (blocked(x, z, 1.5)) continue;
    out.push({ ...s, x, z, rot: rnd() * Math.PI * 2, scale: s.s * (0.75 + rnd() * 0.6) * (s.far && d > inner + 12 ? 1.4 : 1) });
  }
  // a few inside the colony, in the triangles where three plots meet (not on the streets)
  for (let q = -rings - 1; q <= rings + 1; q++) for (let r = -rings - 1; r <= rings + 1; r++) {
    if (hexDistance({ q, r }) > rings) continue;
    const c = hexToWorld(q, r);
    for (let k = 0; k < 6; k += 2) {
      if (rnd() < 0.45) continue;
      const corner = hexCorner(c.x, c.z, HEX, k);
      const s = pick();
      if (s.far || s.r > 1) continue;
      out.push({ ...s, x: corner.x + (rnd() - 0.5) * 0.4, z: corner.z + (rnd() - 0.5) * 0.4, rot: rnd() * Math.PI * 2, scale: s.s * (0.6 + rnd() * 0.3), inColony: true });
    }
  }
  return out;
}

/** How many plot rings a colony of n agents occupies. */
export const ringsFor = (maxPlotIndex) => { let n = 0, k = 0; while (n <= maxPlotIndex) { k++; n += 6 * k; } return Math.max(1, k); };

// ------------------------------------------------------------------ placing pieces & obstacles
const PIECE_R = {
  basemodule_A: 1.05, basemodule_B: 1.05, basemodule_C: 1.05, basemodule_D: 1.1, basemodule_E: 1.1, basemodule_garage: 1.1,
  cargo_A: 0.3, cargo_B_stacked: 0.55, solarpanel: 0.35, roofmodule_solarpanels: 0, roofmodule_cargo_A: 0,
  windturbine_low: 0.55, windturbine_tall: 0.6, spacetruck: 0.45, structure_tall: 0.9, structure_low: 0.9,
};
/** Plot-local piece coordinates (x along the front edge, z towards the hub) → world. */
export function pieceToWorld(layout, p) {
  const len = Math.hypot(layout.center.x, layout.center.z) || 1;
  const fx = -layout.center.x / len, fz = -layout.center.z / len, sx = -fz, sz = fx;
  const x = layout.building.x + (sx * p.x + fx * p.z) * BUILD_SCALE;
  const z = layout.building.z + (sz * p.x + fz * p.z) * BUILD_SCALE;
  return { x, z, y: (p.y || 0) * BUILD_SCALE, rot: layout.facing + (p.rot || 0), r: (PIECE_R[p.part] ?? 0.6) * BUILD_SCALE * (p.s || 1) };
}
/** Everything a bot must walk round. `plots` = [{index, level}], `relays` = number of relay towers. */
export function colonyObstacles({ plots = [], relays = 0, scatterList = [] } = {}) {
  const obs = [];
  for (const { index, level } of plots) {
    const L = plotLayout(index);
    for (const p of piecesFor(level)) { const w = pieceToWorld(L, p); if (w.r > 0 && !p.y) obs.push({ x: w.x, z: w.z, r: w.r, kind: 'habitat', plot: index }); }
    obs.push({ x: L.flag.x, z: L.flag.z, r: 0.15, kind: 'flag' }, { x: L.lamp.x, z: L.lamp.z, r: 0.25, kind: 'lamp' }, { x: L.bench.x, z: L.bench.z, r: 0.45, kind: 'bench' });
  }
  obs.push({ x: HUB.lander.x, z: HUB.lander.z, r: 1.55, kind: 'lander' }, { x: HUB.laya.x, z: HUB.laya.z, r: 0.85, kind: 'laya' });
  for (let k = 0; k < relays; k++) { const s = relaySpot(k, relays); obs.push({ x: s.x, z: s.z, r: 0.75, kind: 'relay' }); }
  for (const s of scatterList) if (s.r > 0 && !s.deco) obs.push({ x: s.x, z: s.z, r: s.r * Math.min(1.4, s.scale / s.s), kind: 'scatter' });
  return obs;
}
/** The walkable radius for a colony of `rings` plot rings (a little beyond the outer decks). */
export const walkRadius = (rings) => (rings + 0.62) * HEX * SQ3;
