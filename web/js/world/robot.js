import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { BOT_SCALE } from './colony.js';

/**
 * One robot: the KayKit mannequin rig and its 15 animation clips (CC0), dressed as an Atrium bot:
 * a chassis in the agent's colour, a rounded head with a screen face, and antennae / accessories
 * from the agent's avatar settings (the same ones the 2D portraits use).
 */
const CLIPS = {
  idle: 'Idle_A', idle2: 'Idle_B', walk: 'Walking_A', run: 'Running_A', hammer: 'Hammering', work: 'Working_A',
  wave: 'Waving', cheer: 'Cheering', jump: 'Jump_Full_Short', hit: 'Hit_A', sitDown: 'Sit_Floor_Down', sit: 'Sit_Floor_Idle',
  standUp: 'Sit_Floor_StandUp', spawn: 'Spawn_Ground', interact: 'Interact',
};
const ONCE = new Set(['jump', 'hit', 'sitDown', 'standUp', 'spawn']);

const shared = { geo: null };
function geos() {
  if (shared.geo) return shared.geo;
  shared.geo = {
    head: new RoundedBoxGeometry(0.98, 0.82, 0.9, 4, 0.22),
    face: new THREE.PlaneGeometry(0.8, 0.52),
    ear: new THREE.CylinderGeometry(0.15, 0.15, 0.1, 18).rotateZ(Math.PI / 2),
    stalk: new THREE.CylinderGeometry(0.03, 0.03, 0.42, 8),
    tip: new THREE.SphereGeometry(0.085, 14, 10),
    dome: new THREE.SphereGeometry(0.34, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    bolt: new THREE.CylinderGeometry(0.07, 0.07, 0.08, 10).rotateZ(Math.PI / 2),
    coil: new THREE.TorusGeometry(0.1, 0.028, 8, 20),
    visor: new RoundedBoxGeometry(1.02, 0.16, 0.2, 2, 0.06),
    band: new THREE.TorusGeometry(0.52, 0.035, 8, 28, Math.PI),
    fin: new RoundedBoxGeometry(0.1, 0.3, 0.55, 2, 0.04),
    dish: new THREE.ConeGeometry(0.2, 0.12, 20, 1, true),
    chest: new THREE.CircleGeometry(0.09, 20),
    ring: new THREE.RingGeometry(0.62, 0.8, 40).rotateX(-Math.PI / 2),
    pick: new THREE.CylinderGeometry(0.75, 0.75, 2.5, 8).translate(0, 1.25, 0),
  };
  return shared.geo;
}

const lighten = (hex, k) => new THREE.Color(hex).lerp(new THREE.Color('#ffffff'), k);

export class Robot {
  constructor(kits, L, { visitor = false } = {}) {
    const G = geos();
    this.L = L; this.visitor = visitor;
    this.root = new THREE.Group();
    this.model = SkeletonUtils.clone(kits.crew.scene);
    this.model.scale.setScalar(BOT_SCALE);
    this.root.add(this.model);

    // --- materials
    this.mat = {
      chassis: new THREE.MeshStandardMaterial({ color: visitor ? '#9aa3b8' : L.color, roughness: 0.42, metalness: 0.25 }),
      limb: new THREE.MeshStandardMaterial({ color: visitor ? '#5b6378' : '#4b5264', roughness: 0.5, metalness: 0.4 }),
      shell: new THREE.MeshStandardMaterial({ color: visitor ? '#e9edf5' : lighten(L.skin || '#f2c9a4', 0.62), roughness: 0.35, metalness: 0.1 }),
      accent: new THREE.MeshStandardMaterial({ color: L.color, roughness: 0.4, metalness: 0.3 }),
      glow: new THREE.MeshStandardMaterial({ color: '#000000', emissive: new THREE.Color(L.color).lerp(new THREE.Color('#ffffff'), 0.25), emissiveIntensity: 1.6 }),
      tip: new THREE.MeshStandardMaterial({ color: '#000000', emissive: new THREE.Color(L.hairColor && L.hairColor !== '#2A1E1A' ? L.hairColor : L.color), emissiveIntensity: 2.2 }),
    };
    let head = null;
    this.model.traverse((o) => {
      if (o.isSkinnedMesh) {
        o.castShadow = true; o.frustumCulled = false;
        if (/Head/.test(o.name)) { o.visible = false; return; }
        o.material = /Body/.test(o.name) ? this.mat.chassis : this.mat.limb;
      }
      if (o.isBone && o.name === 'head') head = o;
      if (o.isBone && o.name === 'handr') this.hand = o;
      if (o.isBone && o.name === 'chest') this.chestBone = o;
    });
    this.headBone = head;

    // --- head (built in head-bone space: the bone sits at the neck, +z is the face)
    const h = new THREE.Group(); h.position.set(0, 0.43, 0.03); head.add(h); this.head = h;
    const shell = new THREE.Mesh(G.head, this.mat.shell); shell.castShadow = true; h.add(shell);
    this.faceCanvas = document.createElement('canvas'); this.faceCanvas.width = 160; this.faceCanvas.height = 104;
    this.faceTex = new THREE.CanvasTexture(this.faceCanvas); this.faceTex.colorSpace = THREE.SRGBColorSpace; this.faceTex.anisotropy = 4;
    this.faceMat = new THREE.MeshBasicMaterial({ map: this.faceTex, transparent: true, toneMapped: false });
    const face = new THREE.Mesh(G.face, this.faceMat); face.position.set(0, -0.02, 0.452); h.add(face);
    for (const sx of [-1, 1]) { const e = new THREE.Mesh(G.ear, this.mat.accent); e.position.set(sx * 0.5, -0.02, 0); h.add(e); }
    this.#dress(h, G);
    // chest light
    this.chest = new THREE.Mesh(G.chest, this.mat.glow);
    this.model.updateMatrixWorld(true);
    if (this.chestBone) {
      const p = this.chestBone.worldToLocal(new THREE.Vector3(0, 0.98 * BOT_SCALE, 0.29 * BOT_SCALE).add(new THREE.Vector3()));
      this.chest.position.copy(p); this.chestBone.add(this.chest);
    }

    // --- selection ring, picking proxy
    this.ring = new THREE.Mesh(G.ring, new THREE.MeshBasicMaterial({ color: '#7c5cff', transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false }));
    this.ring.position.y = 0.04; this.ring.visible = false; this.root.add(this.ring);
    this.pick = new THREE.Mesh(G.pick, new THREE.MeshBasicMaterial({ visible: false }));
    this.root.add(this.pick);

    // --- animation
    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {};
    const byName = new Map(kits.crew.animations.map((a) => [a.name, a]));
    for (const [k, n] of Object.entries(CLIPS)) {
      const clip = byName.get(n); if (!clip) continue;
      const a = this.mixer.clipAction(clip);
      if (ONCE.has(k)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      this.actions[k] = a;
    }
    this.mixer.addEventListener('finished', (e) => { const cb = this.onceDone; if (cb && e.action === this.current) { this.onceDone = null; cb(); } });
    this.current = null; this.clip = null;
    this.face = null; this.blinkAt = performance.now() + 2000; this.blinking = 0;
    this.setFace('idle');
    this.play('idle');
  }

  #dress(h, G) {
    const L = this.L;
    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.castShadow = true; h.add(m); return m; };
    const antenna = (x, lean) => { add(G.stalk, this.mat.limb, x, 0.6, 0, 0, 0, lean); this.tips.push(add(G.tip, this.mat.tip, x - Math.sin(lean) * 0.2, 0.82, 0)); };
    this.tips = [];
    switch (this.visitor ? 'dome' : L.hair) {
      case 'short': antenna(0, 0); break;
      case 'long': antenna(-0.2, 0.35); antenna(0.2, -0.35); break;
      case 'bun': case 'dome': add(G.dome, this.visitor ? new THREE.MeshStandardMaterial({ color: '#bfe9ff', transparent: true, opacity: 0.55, roughness: 0.1 }) : this.mat.accent, 0, 0.38, 0); this.tips.push(add(G.tip, this.mat.tip, 0, 0.74, 0)); break;
      case 'buzz': add(G.bolt, this.mat.limb, -0.53, 0.2, 0); add(G.bolt, this.mat.limb, 0.53, 0.2, 0); add(G.fin, this.mat.accent, 0, 0.43, 0); break;
      case 'curly': add(G.stalk, this.mat.limb, 0, 0.55, 0); for (let i = 0; i < 3; i++) add(G.coil, this.mat.accent, 0, 0.62 + i * 0.07, 0, Math.PI / 2); this.tips.push(add(G.tip, this.mat.tip, 0, 0.86, 0)); break;
      default: break;
    }
    switch (L.accessory) {
      case 'glasses': add(G.visor, new THREE.MeshStandardMaterial({ color: '#ff7ab8', transparent: true, opacity: 0.55, roughness: 0.15, emissive: '#ff4f9a', emissiveIntensity: 0.25 }), 0, 0.08, 0.4); break;
      case 'headset': add(G.band, this.mat.limb, 0, 0.05, 0, 0, 0, 0); add(new THREE.CylinderGeometry(0.02, 0.02, 0.36, 6).rotateZ(Math.PI / 2.4), this.mat.limb, 0.44, -0.3, 0.26, 0, -0.9, 0); break;
      case 'cap': add(G.fin, this.mat.accent, 0, 0.48, -0.05); break;
      case 'beanie': add(G.dish, this.mat.limb, 0.32, 0.5, 0, 0, 0, -0.6); break;
      default: break;
    }
  }

  /** Crossfade to a clip. `once` clips call `then` when they finish. */
  play(name, { fade = 0.28, then, speed = 1 } = {}) {
    const a = this.actions[name];
    if (!a) return;
    if (this.clip === name && !ONCE.has(name)) { a.timeScale = speed; return; }
    const prev = this.current;
    a.reset(); a.timeScale = speed; a.enabled = true; a.setEffectiveWeight(1);
    if (prev && prev !== a) a.crossFadeFrom(prev, fade, false);
    a.play();
    this.current = a; this.clip = name; this.onceDone = then || null;
  }

  setSpeed(s) { if (this.current) this.current.timeScale = s; }

  /** Screen-face expression: idle | happy | focus | error | sleep | think | talk */
  setFace(face) {
    if (this.face === face && !this.blinking) return;
    this.face = face;
    drawFace(this.faceCanvas.getContext('2d'), face, this.blinking, this.visitor);
    this.faceTex.needsUpdate = true;
  }

  update(dt, now) {
    this.mixer.update(dt);
    // blink
    if (now > this.blinkAt && ['idle', 'focus', 'talk', 'think'].includes(this.face)) {
      this.blinking = 1; const f = this.face; this.face = null; this.setFace(f);
      setTimeout(() => { this.blinking = 0; const g = this.face; this.face = null; this.setFace(g); }, 130);
      this.blinkAt = now + 2200 + Math.random() * 3500;
    }
    // antenna tip / chest pulse
    const err = this.face === 'error';
    const pulse = err ? (Math.sin(now / 70) > 0 ? 3 : 0.3) : 1.6 + Math.sin(now / 420) * 0.6;
    this.mat.tip.emissiveIntensity = pulse;
    if (err) this.mat.tip.emissive.set('#ff3b4f'); else this.mat.tip.emissive.set(this.L.hairColor && this.L.hairColor !== '#2A1E1A' ? this.L.hairColor : this.L.color);
    this.mat.glow.emissiveIntensity = err ? 0.4 : 1.2 + Math.sin(now / 300) * 0.4;
  }

  /** World position of the right hand (for sparks) and the point above the head (for labels). */
  handWorld(v = new THREE.Vector3()) { return this.hand ? this.hand.getWorldPosition(v) : this.root.getWorldPosition(v); }
  headTop(v = new THREE.Vector3()) { return this.head.localToWorld(v.set(0, 0.95, 0)); }

  recolor(L) {
    this.L = L;
    if (this.visitor) return;
    this.mat.chassis.color.set(L.color); this.mat.accent.color.set(L.color);
    this.mat.shell.color.copy(lighten(L.skin || '#f2c9a4', 0.62));
    this.mat.glow.emissive.set(L.color);
  }

  dispose() {
    this.mixer.stopAllAction();
    this.faceTex.dispose(); this.faceMat.dispose();
    for (const m of Object.values(this.mat)) m.dispose();
    this.ring.material.dispose();
  }
}

// ------------------------------------------------------------------ faces
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
export function drawFace(ctx, face, blink = 0, visitor = false) {
  const W = 160, H = 104;
  ctx.clearRect(0, 0, W, H);
  rr(ctx, 2, 2, W - 4, H - 4, 30);
  const bg = ctx.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#141a33'); bg.addColorStop(1, '#070a18');
  ctx.fillStyle = bg; ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.stroke();
  const eye = face === 'error' ? '#ff4f5e' : visitor ? '#ffc65c' : '#7ff3ff';
  ctx.strokeStyle = eye; ctx.fillStyle = eye; ctx.lineCap = 'round'; ctx.lineWidth = 9;
  ctx.shadowColor = eye; ctx.shadowBlur = 14;
  const L = 52, R = 108, Y = 50;
  const line = (x0, y0, x1, y1) => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); };
  if (blink || face === 'sleep') {
    line(L - 12, Y + 6, L + 12, Y + 6); line(R - 12, Y + 6, R + 12, Y + 6);
  } else if (face === 'happy') {
    for (const x of [L, R]) { ctx.beginPath(); ctx.arc(x, Y + 8, 13, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke(); }
    ctx.shadowBlur = 0; ctx.fillStyle = 'rgba(255,120,170,0.55)';
    ctx.beginPath(); ctx.ellipse(L - 12, Y + 22, 9, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(R + 12, Y + 22, 9, 5, 0, 0, Math.PI * 2); ctx.fill();
  } else if (face === 'error') {
    for (const x of [L, R]) { line(x - 10, Y - 10, x + 10, Y + 10); line(x + 10, Y - 10, x - 10, Y + 10); }
  } else if (face === 'focus') {
    ctx.lineWidth = 11; line(L - 11, Y + 2, L + 11, Y + 2); line(R - 11, Y + 2, R + 11, Y + 2);
    ctx.lineWidth = 5; line(L - 13, Y - 14, L + 9, Y - 10); line(R + 13, Y - 14, R - 9, Y - 10);
  } else if (face === 'think') {
    for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(56 + i * 24, Y + 2, 6, 0, Math.PI * 2); ctx.fill(); }
  } else {
    for (const x of [L, R]) { rr(ctx, x - 9, Y - 13, 18, 26, 9); ctx.fill(); }
    if (face === 'talk') { ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(80, Y + 24, 8, 0, Math.PI); ctx.stroke(); }
  }
  ctx.shadowBlur = 0;
}
