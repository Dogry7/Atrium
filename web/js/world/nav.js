/**
 * Walking: a fine grid over the colony with round obstacles stamped in, A* over it, then
 * string-pulling so paths are straight lines between corners instead of grid staircases.
 * Pure (no three.js), unit-tested.
 */
export class NavGrid {
  /** @param {{radius:number, cell?:number, obstacles:{x:number,z:number,r:number}[], clearance?:number}} o */
  constructor({ radius, cell = 0.5, obstacles = [], clearance = 0.35 }) {
    this.cell = cell;
    this.radius = radius;
    this.n = Math.ceil((radius * 2) / cell);
    this.origin = -radius;
    this.blocked = new Uint8Array(this.n * this.n);
    const R2 = radius * radius;
    for (let j = 0; j < this.n; j++) for (let i = 0; i < this.n; i++) {
      const { x, z } = this.center(i, j);
      if (x * x + z * z > R2) this.blocked[j * this.n + i] = 1;
    }
    for (const o of obstacles) this.stamp(o.x, o.z, o.r + clearance);
  }
  center(i, j) { return { x: this.origin + (i + 0.5) * this.cell, z: this.origin + (j + 0.5) * this.cell }; }
  toCell(x, z) { return { i: Math.floor((x - this.origin) / this.cell), j: Math.floor((z - this.origin) / this.cell) }; }
  inside(i, j) { return i >= 0 && j >= 0 && i < this.n && j < this.n; }
  isFree(i, j) { return this.inside(i, j) && !this.blocked[j * this.n + i]; }
  freeAt(x, z) { const { i, j } = this.toCell(x, z); return this.isFree(i, j); }
  stamp(x, z, r) {
    const a = this.toCell(x - r, z - r), b = this.toCell(x + r, z + r);
    for (let j = Math.max(0, a.j); j <= Math.min(this.n - 1, b.j); j++) for (let i = Math.max(0, a.i); i <= Math.min(this.n - 1, b.i); i++) {
      const c = this.center(i, j);
      if ((c.x - x) ** 2 + (c.z - z) ** 2 <= r * r) this.blocked[j * this.n + i] = 1;
    }
  }
  /** The nearest free cell centre to a point (spiral search), or null. */
  nearestFree(x, z, maxR = 24) {
    const { i, j } = this.toCell(x, z);
    if (this.isFree(i, j)) return { x, z };
    for (let r = 1; r <= maxR; r++) {
      let best = null, bd = Infinity;
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r || !this.isFree(i + di, j + dj)) continue;
        const c = this.center(i + di, j + dj); const d = (c.x - x) ** 2 + (c.z - z) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      if (best) return best;
    }
    return null;
  }
  /** Is the straight segment a→b clear (sampled at a third of a cell)? */
  clear(ax, az, bx, bz) {
    const d = Math.hypot(bx - ax, bz - az), steps = Math.max(1, Math.ceil(d / (this.cell / 3)));
    for (let k = 0; k <= steps; k++) { const t = k / steps; if (!this.freeAt(ax + (bx - ax) * t, az + (bz - az) * t)) return false; }
    return true;
  }
  /** A* from a to b. Returns [{x,z}, …] ending at b (snapped to free space), [] if already there, or null. */
  path(ax, az, bx, bz) {
    const s0 = this.nearestFree(ax, az), g0 = this.nearestFree(bx, bz);
    if (!s0 || !g0) return null;
    const S = this.toCell(s0.x, s0.z), G = this.toCell(g0.x, g0.z);
    const n = this.n, start = S.j * n + S.i, goal = G.j * n + G.i;
    if (start === goal) return Math.hypot(bx - ax, bz - az) < 0.05 ? [] : [g0];
    const gScore = new Float32Array(n * n).fill(Infinity), came = new Int32Array(n * n).fill(-1), closed = new Uint8Array(n * n);
    const heap = new Heap();
    const h = (k) => { const i = k % n, j = (k / n) | 0; const dx = Math.abs(i - G.i), dz = Math.abs(j - G.j); return (dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz)); };
    gScore[start] = 0; heap.push(start, h(start));
    const N8 = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
    let found = false, iter = 0;
    while (heap.size && iter++ < 200000) {
      const k = heap.pop();
      if (k === goal) { found = true; break; }
      if (closed[k]) continue; closed[k] = 1;
      const i = k % n, j = (k / n) | 0;
      for (const [di, dj, cost] of N8) {
        const ni = i + di, nj = j + dj;
        if (!this.isFree(ni, nj)) continue;
        if (di && dj && (!this.isFree(i + di, j) || !this.isFree(i, j + dj))) continue; // no corner cutting
        const nk = nj * n + ni, g = gScore[k] + cost;
        if (g < gScore[nk]) { gScore[nk] = g; came[nk] = k; heap.push(nk, g + h(nk)); }
      }
    }
    if (!found) return null;
    const cells = [];
    for (let k = goal; k !== -1 && k !== start; k = came[k]) cells.push(this.center(k % n, (k / n) | 0));
    cells.reverse();
    // end exactly at the requested point when it is free
    const end = this.freeAt(bx, bz) ? { x: bx, z: bz } : g0;
    cells[cells.length - 1] = end;
    return this.smooth({ x: ax, z: az }, cells);
  }
  /** String-pull: keep only the corners you can't see past. */
  smooth(from, pts) {
    const out = [];
    let a = from, k = 0;
    while (k < pts.length) {
      let far = k;
      for (let t = pts.length - 1; t > k; t--) if (this.clear(a.x, a.z, pts[t].x, pts[t].z)) { far = t; break; }
      out.push(pts[far]); a = pts[far]; k = far + 1;
    }
    return out;
  }
}

class Heap {
  constructor() { this.k = []; this.p = []; }
  get size() { return this.k.length; }
  push(key, pri) {
    const { k, p } = this; k.push(key); p.push(pri);
    let i = k.length - 1;
    while (i > 0) { const up = (i - 1) >> 1; if (p[up] <= p[i]) break; [k[up], k[i]] = [k[i], k[up]]; [p[up], p[i]] = [p[i], p[up]]; i = up; }
  }
  pop() {
    const { k, p } = this; const top = k[0]; const lk = k.pop(), lp = p.pop();
    if (k.length) {
      k[0] = lk; p[0] = lp; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < k.length && p[l] < p[m]) m = l; if (r < k.length && p[r] < p[m]) m = r;
        if (m === i) break; [k[m], k[i]] = [k[i], k[m]]; [p[m], p[i]] = [p[i], p[m]]; i = m;
      }
    }
    return top;
  }
}
