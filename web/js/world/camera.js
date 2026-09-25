import * as THREE from 'three';

/**
 * A map-style camera: drag to pan (the point under the cursor stays under the cursor),
 * right-drag / shift-drag / ctrl-drag to rotate and tilt, wheel or pinch to zoom at the cursor,
 * arrows and +/− on the keyboard, and a slow orbit mode. Everything eases.
 */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));

export class CameraRig {
  constructor(camera, dom) {
    this.camera = camera; this.dom = dom;
    this.target = new THREE.Vector3(0, 0, 0);
    this.want = { target: new THREE.Vector3(), dist: 60, az: Math.PI / 4, tilt: 0.95 };
    this.dist = 60; this.az = Math.PI / 4; this.tilt = 0.95; // tilt: angle down from horizontal (radians)
    this.limits = { dist: [7, 190], tilt: [0.32, 1.45], radius: 120 };
    this.orbit = false; this.moved = false;
    this.ray = new THREE.Raycaster(); this.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.keys = new Set();
    this.#bind();
  }

  /** Ground point under a client position (or null). */
  ground(cx, cy, out = new THREE.Vector3()) {
    const r = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hit = this.ray.ray.intersectPlane(this.plane, out);
    if (!hit || hit.distanceTo(this.camera.position) > 900) return null;
    return hit;
  }

  set(target, dist, { az, tilt, instant = false } = {}) {
    this.want.target.copy(target); this.want.dist = clamp(dist, ...this.limits.dist);
    if (az != null) this.want.az = az; if (tilt != null) this.want.tilt = tilt;
    if (instant) { this.target.copy(this.want.target); this.dist = this.want.dist; this.az = this.want.az; this.tilt = this.want.tilt; this.apply(); }
  }
  zoomBy(f, cx, cy) {
    const nd = clamp(this.want.dist / f, ...this.limits.dist);
    const k = 1 - nd / this.want.dist;
    if (cx != null) { const g = this.ground(cx, cy); if (g) this.want.target.lerp(g, k * 0.9); }
    this.want.dist = nd; this.moved = true;
  }
  pan(dx, dz) { this.want.target.x += dx; this.want.target.z += dz; this.moved = true; }

  apply() {
    const c = Math.cos(this.tilt), s = Math.sin(this.tilt);
    const p = new THREE.Vector3(Math.sin(this.az) * c, s, Math.cos(this.az) * c).multiplyScalar(this.dist).add(this.target);
    this.camera.position.copy(p); this.camera.lookAt(this.target);
  }

  update(dt) {
    if (this.orbit) this.want.az += dt * 0.12;
    // keyboard
    const k = this.keys; const sp = this.want.dist * 0.9 * dt;
    if (k.size) {
      const fx = -Math.sin(this.az), fz = -Math.cos(this.az), rx = Math.cos(this.az), rz = -Math.sin(this.az);
      if (k.has('ArrowUp')) this.pan(fx * sp, fz * sp); if (k.has('ArrowDown')) this.pan(-fx * sp, -fz * sp);
      if (k.has('ArrowRight')) this.pan(rx * sp, rz * sp); if (k.has('ArrowLeft')) this.pan(-rx * sp, -rz * sp);
    }
    const R = this.limits.radius, t = this.want.target, d = Math.hypot(t.x, t.z);
    if (d > R) { t.x *= R / d; t.z *= R / d; }
    this.want.tilt = clamp(this.want.tilt, ...this.limits.tilt);
    const kk = this.dragging ? 40 : 9;
    this.target.x = damp(this.target.x, t.x, kk, dt); this.target.z = damp(this.target.z, t.z, kk, dt);
    this.dist = damp(this.dist, this.want.dist, 10, dt);
    this.az = damp(this.az, this.want.az, 10, dt); this.tilt = damp(this.tilt, this.want.tilt, 10, dt);
    this.apply();
  }

  #bind() {
    const el = this.dom;
    const pointers = new Map();
    let mode = null, last = null, anchor = null, pinch = null;
    const down = (e) => {
      el.setPointerCapture?.(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.downAt = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) }; mode = 'pinch'; return; }
      mode = e.button === 2 || e.shiftKey || e.ctrlKey || e.button === 1 ? 'rotate' : 'pan';
      last = { x: e.clientX, y: e.clientY };
      anchor = mode === 'pan' ? this.ground(e.clientX, e.clientY) : null;
      this.orbit = false;
    };
    const move = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (mode === 'pinch' && pointers.size === 2) {
        const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.zoomBy(d / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2); pinch.d = d; return;
      }
      if (!last) return;
      const dx = e.clientX - last.x, dy = e.clientY - last.y; last = { x: e.clientX, y: e.clientY };
      if (Math.abs(e.clientX - this.downAt.x) + Math.abs(e.clientY - this.downAt.y) > 4) { this.dragging = true; this.moved = true; }
      if (mode === 'rotate') { this.want.az -= dx * 0.006; this.want.tilt += dy * 0.004; }
      else if (mode === 'pan' && anchor) {
        // keep the grabbed ground point under the cursor: solve against the *current* camera
        this.target.copy(this.want.target); this.dist = this.want.dist; this.az = this.want.az; this.tilt = this.want.tilt; this.apply();
        const g = this.ground(e.clientX, e.clientY);
        if (g) { this.want.target.x += anchor.x - g.x; this.want.target.z += anchor.z - g.z; }
      }
    };
    const up = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2 && mode === 'pinch') mode = null;
      if (!pointers.size) { mode = null; last = null; anchor = null; setTimeout(() => { this.dragging = false; }, 0); }
    };
    const wheel = (e) => { e.preventDefault(); this.orbit = false; this.zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), e.clientX, e.clientY); };
    const ctx = (e) => e.preventDefault();
    el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false }); el.addEventListener('contextmenu', ctx);
    this.unbind = () => {
      el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up); el.removeEventListener('wheel', wheel); el.removeEventListener('contextmenu', ctx);
    };
  }

  /** Was the last pointer-up a click (not a drag)? */
  wasClick(e) { return this.downAt && Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) < 5 && e.timeStamp - this.downAt.t < 600; }
}
