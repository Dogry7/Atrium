import * as THREE from 'three';

/**
 * Particles in flat typed arrays (sparks, confetti, beam pulses, dust), drawn as one Points
 * object with round soft sprites. Dead particles are swap-removed.
 */
const MAX = 4000;
const VERT = /* glsl */`
attribute float aSize; attribute vec3 aColor; attribute float aAlpha;
varying vec3 vColor; varying float vAlpha;
void main() {
  vColor = aColor; vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (300.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = /* glsl */`
varying vec3 vColor; varying float vAlpha; uniform float uSquare;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a = uSquare > 0.5 ? step(max(abs(c.x), abs(c.y)), 0.42) : smoothstep(0.5, 0.1, d);
  if (a < 0.02) discard;
  gl_FragColor = vec4(vColor, a * vAlpha);
}`;

class Pool {
  constructor(scene, { additive = true, square = false } = {}) {
    this.n = 0;
    this.pos = new Float32Array(MAX * 3); this.vel = new Float32Array(MAX * 3); this.col = new Float32Array(MAX * 3);
    this.size = new Float32Array(MAX); this.alpha = new Float32Array(MAX); this.life = new Float32Array(MAX); this.max = new Float32Array(MAX);
    this.grav = new Float32Array(MAX); this.drag = new Float32Array(MAX); this.size0 = new Float32Array(MAX);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos); g.setAttribute('aColor', this.aCol); g.setAttribute('aSize', this.aSize); g.setAttribute('aAlpha', this.aAlpha);
    g.setDrawRange(0, 0);
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: { uSquare: { value: square ? 1 : 0 } },
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);
  }
  spawn(x, y, z, vx, vy, vz, color, size, life, grav = 0, drag = 0) {
    if (this.n >= MAX) return;
    const i = this.n++;
    this.pos.set([x, y, z], i * 3); this.vel.set([vx, vy, vz], i * 3);
    const c = color.isColor ? color : new THREE.Color(color); this.col.set([c.r, c.g, c.b], i * 3);
    this.size[i] = this.size0[i] = size; this.alpha[i] = 1; this.life[i] = 0; this.max[i] = life; this.grav[i] = grav; this.drag[i] = drag;
  }
  update(dt) {
    let i = 0;
    while (i < this.n) {
      this.life[i] += dt;
      if (this.life[i] >= this.max[i]) { this.#kill(i); continue; }
      const k = i * 3, d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[k] *= d; this.vel[k + 1] = this.vel[k + 1] * d - this.grav[i] * dt; this.vel[k + 2] *= d;
      this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
      if (this.pos[k + 1] < 0.05 && this.grav[i] > 0) { this.pos[k + 1] = 0.05; this.vel[k + 1] *= -0.3; this.vel[k] *= 0.6; this.vel[k + 2] *= 0.6; }
      const t = this.life[i] / this.max[i];
      this.alpha[i] = t < 0.1 ? t * 10 : 1 - Math.max(0, (t - 0.6) / 0.4);
      i++;
    }
    for (const a of [this.aPos, this.aCol, this.aSize, this.aAlpha]) a.needsUpdate = true;
    this.points.geometry.setDrawRange(0, this.n);
  }
  #kill(i) {
    const j = --this.n; if (i === j) return;
    for (const [arr, w] of [[this.pos, 3], [this.vel, 3], [this.col, 3]]) for (let c = 0; c < w; c++) arr[i * w + c] = arr[j * w + c];
    for (const arr of [this.size, this.alpha, this.life, this.max, this.grav, this.drag, this.size0]) arr[i] = arr[j];
  }
}

const CONFETTI = ['#ff5e7e', '#ffd166', '#7ff3ff', '#9dff9d', '#b18cff', '#ff9f43'];

export class Effects {
  constructor(scene) {
    this.glow = new Pool(scene, { additive: true });
    this.paper = new Pool(scene, { additive: false, square: true });
    this.beams = [];   // {from: () => Vector3, to: () => Vector3, t, dur, color, kind}
    this.list = [];    // public record of what's playing (tests & debugging): {kind, t}
    this.tmpA = new THREE.Vector3(); this.tmpB = new THREE.Vector3();
  }
  sparks(p, n = 10, color = '#ffc76a') {
    for (let i = 0; i < n; i++) this.glow.spawn(p.x, p.y, p.z, (Math.random() - 0.5) * 3, Math.random() * 2.6 + 0.6, (Math.random() - 0.5) * 3, color, 0.09 + Math.random() * 0.07, 0.35 + Math.random() * 0.35, 7, 1.5);
  }
  confetti(p, n = 70) {
    for (let i = 0; i < n; i++) this.paper.spawn(p.x, p.y, p.z, (Math.random() - 0.5) * 4, 3 + Math.random() * 3, (Math.random() - 0.5) * 4, CONFETTI[i % CONFETTI.length], 0.12 + Math.random() * 0.08, 1.6 + Math.random() * 0.8, 6, 1.2);
    this.#note('confetti');
  }
  ring(p, color = '#2fd18b', n = 36, r = 0.6) {
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; this.glow.spawn(p.x + Math.cos(a) * r, p.y, p.z + Math.sin(a) * r, Math.cos(a) * 1.6, 0.5, Math.sin(a) * 1.6, color, 0.16, 0.7, 0, 2); }
    this.#note('ring');
  }
  poof(p, color = '#c9d2e8', n = 30) {
    for (let i = 0; i < n; i++) this.glow.spawn(p.x + (Math.random() - 0.5) * 0.6, p.y + Math.random() * 1.2, p.z + (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 1.4, Math.random() * 1.5, (Math.random() - 0.5) * 1.4, color, 0.25, 0.9, -0.5, 1.5);
    this.#note('poof');
  }
  zzz(p) { this.glow.spawn(p.x, p.y, p.z, 0.25, 0.45, 0.05, '#b8c6ff', 0.18, 2.2, 0, 0.2); }
  /** A travelling beam of light from one moving point to another (A2A handoff, tool call, Laya). */
  beam(from, to, { color = '#7c5cff', dur = 1.4, kind = 'beam', arc = 2.2 } = {}) {
    this.beams.push({ from, to, t: 0, dur, color: new THREE.Color(color), arc, acc: 0 });
    this.#note(kind, dur + 0.6);
  }
  #note(kind, dur = 1.5) { this.list.push({ kind, t: 0, dur }); }

  update(dt) {
    this.beams = this.beams.filter((b) => {
      b.t += dt; if (b.t > b.dur) return false;
      const A = b.from(this.tmpA), B = b.to(this.tmpB); if (!A || !B) return false;
      b.acc += dt;
      const head = Math.min(1, b.t / (b.dur * 0.55));
      const spawnEvery = 1 / 90;
      while (b.acc > spawnEvery) {
        b.acc -= spawnEvery;
        const u = Math.random() * head;
        const x = A.x + (B.x - A.x) * u, z = A.z + (B.z - A.z) * u;
        const y = A.y + (B.y - A.y) * u + Math.sin(u * Math.PI) * b.arc;
        this.glow.spawn(x, y, z, 0, 0.15, 0, b.color, 0.2 + (u > head - 0.06 ? 0.2 : 0), 0.5, 0, 0);
      }
      return true;
    });
    this.glow.update(dt); this.paper.update(dt);
    this.list = this.list.filter((f) => (f.t += dt) < f.dur);
  }
}
